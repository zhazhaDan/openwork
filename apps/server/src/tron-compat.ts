/** Wudong's HTTP contract over the upstream native engine client. */
import { createClientV2, createV2EventTranslationState, translateV2Event, type Event, type Result } from './tron-compat/client.js';
import { ApiError } from './errors.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
async function unwrap(result: Promise<Result>): Promise<unknown> {
  const reply = await result;
  if (!reply.response.ok || reply.error !== undefined) {
    throw new ApiError(reply.response.ok ? 502 : reply.response.status, 'tron_request_failed', 'Tron request failed', { cause: reply.error, path: new URL(reply.request.url).pathname });
  }
  return reply.data;
}
function items(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new ApiError(502, 'invalid_tron_response', 'Expected a conversation list from Tron');
  return value.map(record);
}
function integer(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (name === 'start' ? 0 : 1)) throw new ApiError(400, 'invalid_payload', `${name} is invalid`);
  return value;
}
function json(value: unknown) { return Response.json(value ?? null); }
function legacyEvents(event: Event): Event[] {
  const properties = record(event.properties);
  const sessionID = properties.sessionID;
  if (typeof sessionID !== 'string') return [event];
  if (event.type === 'session.execution.started') return [event, { type:'session.status', properties: { sessionID, status: { type:'busy' } } }];
  if (event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') return [
    event, { type:'session.error', properties:{sessionID,error:properties.error ?? { message: '任务执行已中断' }} },
  ];
  if (event.type === 'session.execution.succeeded') return [
    event,
    {type:'session.status',properties:{sessionID,status:{type:'idle'}}},
    {type:'session.idle',properties:{sessionID}},
  ];
  return [event];
}

function eventStream(stream: AsyncGenerator<Event>, signal: AbortSignal, envelope?: string): Response {
  const encoder = new TextEncoder();
  let ended = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { ended = true; if (timer) clearInterval(timer); void stream.return(undefined).catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      timer = setInterval(() => { if (!ended) controller.enqueue(encoder.encode(': heartbeat\n\n')); }, 15_000);
      void (async () => {
        try {
          for await (const payload of stream) {
            if (ended) break;
            for (const event of legacyEvents(payload)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope === undefined ? event : { directory: envelope, payload: event })}\n\n`));
          }
          if (!ended) controller.close();
        } catch (error) { if (!ended) controller.error(error); }
        finally { stop(); signal.removeEventListener('abort', stop); }
      })();
    },
    cancel() { stop(); signal.removeEventListener('abort', stop); },
  }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } });
}

/** Global native events carry their directory; retain it for Wudong's main-process fan-out. */
export function translateTronGlobalEvents(response: Response, signal: AbortSignal, sessionDirectory?: (sessionId: string) => Promise<string | null>): Response {
  const reader = response.body?.getReader();
  if (!response.ok || !reader) return response;
  const state = createV2EventTranslationState();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const directories = new Map<string, string>();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          while (!signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 1024 * 1024) throw new Error('Tron event frame exceeded the size limit');
            const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith(':')) { controller.enqueue(encoder.encode(`${line}\n\n`)); continue; }
              if (!line.startsWith('data:')) continue;
              let value: unknown;
              try { value = JSON.parse(line.slice(5)); if (typeof value === 'string') value = JSON.parse(value); } catch { continue; }
              const native = record(value);
              const sessionId = record(native.data).sessionID;
              let directory = record(native.location).directory;
              if (typeof sessionId === 'string') {
                if (native.type === 'session.moved') directories.delete(sessionId);
                if (typeof directory !== 'string' || !directory) {
                  directory = directories.get(sessionId) ?? await sessionDirectory?.(sessionId);
                }
                if (typeof directory === 'string' && directory) {
                  directories.delete(sessionId);
                  directories.set(sessionId, directory);
                  if (directories.size > 1000) directories.delete(directories.keys().next().value!);
                }
                if (native.type === 'session.deleted') directories.delete(sessionId);
              }
              for (const payload of (translateV2Event(value, state) ?? []).flatMap(legacyEvents)) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ directory: typeof directory === 'string' ? directory : '', payload })}\n\n`));
              }
            }
          }
          if (!signal.aborted) controller.close();
        } catch (error) { if (!signal.aborted) controller.error(error); }
        finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
      })();
    }, cancel,
  }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

export async function serveTronCompatibility(input: {
  request: Request; path: string; directory: string; nativeBaseUrl: string; nativeFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  hostAuthorized?: boolean;
}): Promise<Response> {
  const { request, path, directory } = input;
  const url = new URL(request.url);
  const client = createClientV2(input.nativeBaseUrl, directory, {}, input.nativeFetch);
  const options = { signal: request.signal };
  const body = request.method === 'GET' || request.method === 'HEAD' || request.method === 'DELETE' ? {} : record(await request.json());
  const sessionMatch = /^\/(?:sessions|opencode\/session)\/([^/]+)(?:\/(.*))?$/.exec(path);
  const sessionID = sessionMatch ? decodeURIComponent(sessionMatch[1]) : undefined;
  const parameters = { ...Object.fromEntries(url.searchParams), ...body, directory, ...(sessionID ? { sessionID } : {}) };
  const listSessions = async () => {
    const all: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.session.list({ directory, limit: 200, ...(cursor ? { cursor } : {}) }, options);
      all.push(...items(await unwrap(Promise.resolve(page))));
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new ApiError(502, 'invalid_tron_cursor', 'Conversation cursor did not advance');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return all;
  };
  if ((path === '/sessions' || path === '/opencode/session') && request.method === 'GET') {
    let all = await listSessions();
    const included = new Set(url.searchParams.getAll('includeSessionId'));
    const roots = url.searchParams.get('roots');
    if (roots !== null && roots !== 'true' && roots !== 'false') throw new ApiError(400, 'invalid_payload', 'roots is invalid');
    const search = url.searchParams.get('search')?.toLowerCase();
    const start = integer(url.searchParams, 'start');
    all = all.filter(item => included.has(String(item.id)) || (
      (roots !== 'true' || !item.parentID) && (!search || String(item.title).toLowerCase().includes(search))
      && (start === undefined || Number(record(item.time).updated) >= start)
    ));
    all.sort((a,b) => Number(record(b.time).updated) - Number(record(a.time).updated));
    const limit = integer(url.searchParams, 'limit');
    if (limit) {
      const selected = all.slice(0, limit);
      const selectedIDs = new Set(selected.map(item => item.id));
      all = selected.concat(all.filter(item => included.has(String(item.id)) && !selectedIDs.has(item.id)));
    }
    return json(path === '/sessions' ? { items: all } : all);
  }
  if (path === '/opencode/session' && request.method === 'POST') {
    const executionDirectory = url.searchParams.get('directory')?.trim() || directory;
    return json(await unwrap(client.session.create({ ...parameters, directory: executionDirectory }, options)));
  }
  if (path === '/opencode/session/status') return json(await unwrap(client.session.status({ directory }, options)));
  if (path === '/opencode/event') return eventStream((await client.event.subscribe({ directory }, options)).stream, request.signal);
  if (sessionMatch && sessionID) {
    const suffix = sessionMatch[2] ?? '';
    const semantic = path.startsWith('/sessions/');
    if (!suffix && request.method === 'GET') {
      const item = await unwrap(client.session.get(parameters, options));
      if (!semantic) return json(item);
      const statuses = record(await unwrap(client.session.status({ directory }, options)));
      return json({ item: { ...record(item), status: statuses[sessionID] ?? { type: 'idle' } } });
    }
    if (!suffix && request.method === 'DELETE') {
      await unwrap(client.session.delete(parameters, options)); return json(semantic ? { ok: true } : true);
    }
    if (!suffix && request.method === 'PATCH') return json(await unwrap(client.session.update(parameters, options)));
    if ((suffix === 'messages' || suffix === 'message') && request.method === 'GET') {
      const limit = integer(url.searchParams, 'limit');
      const result = await client.session.messages({ ...parameters, ...(limit ? { limit } : {}), ...(url.searchParams.has('before') ? { before: url.searchParams.get('before') } : {}) }, options);
      const value = await unwrap(Promise.resolve(result));
      return json(semantic ? { items: value, ...(result.pagination ? { pagination: result.pagination } : {}) } : value);
    }
    if (suffix === 'snapshot' && request.method === 'GET') {
      // `parameters` also contains the raw URL query. In particular `limit`
      // is a string there, while the generated client validates
      // session.messages()/session.todo() with a numeric limit. The history
      // read below normalizes it, but todo used to receive the raw string and
      // reject every renderer snapshot request (`?limit=300`) as a 500.
      // Todos are derived from the complete conversation history, so do not
      // apply the display-only message limit to that independent read.
      const sessionParameters = { directory, sessionID };
      const [session, history, statuses, todos] = await Promise.all([
        unwrap(client.session.get(sessionParameters, options)),
        client.session.messages({ ...sessionParameters, ...(url.searchParams.has('limit') ? { limit: integer(url.searchParams, 'limit') } : {}), ...(url.searchParams.has('before') ? { before: url.searchParams.get('before') } : {}) }, options),
        unwrap(client.session.status({ directory }, options)),
        unwrap(client.session.todo(sessionParameters, options)),
      ]);
      const messages = await unwrap(Promise.resolve(history));
      return json({ item: { session, messages, todos, ...(history.pagination ? { pagination: history.pagination } : {}), status: record(statuses)[sessionID] ?? { type: 'idle' } } });
    }
    const readMessage = /^message\/([^/]+)$/.exec(suffix);
    if (readMessage && request.method === 'GET') return json(await unwrap(client.session.message({ ...parameters, messageID: decodeURIComponent(readMessage[1]) }, options)));
    if (suffix === 'todo' && request.method === 'GET') return json(await unwrap(client.session.todo(parameters, options)));
    if (suffix === 'diff' && request.method === 'GET') return json(await unwrap(client.session.diff(parameters, options)));
    if (readMessage && request.method === 'DELETE') throw new ApiError(409, 'tron_capability_unavailable', 'This engine does not support deleting individual messages');
    if (suffix === 'children' && request.method === 'GET') return json(await unwrap(client.session.children(parameters, options)));
    const permission = /^permissions\/([^/]+)$/.exec(suffix);
    if (permission && request.method === 'POST') return json(await unwrap(client.permission.respond({ ...parameters, permissionID: decodeURIComponent(permission[1]) }, options)));
    const actions: Record<string, string> = { retry: 'retry', prompt_async: 'promptAsync', abort: 'abort', fork: 'fork', command: 'command', revert: 'revert', unrevert: 'unrevert', summarize: 'summarize' };
    if (request.method === 'POST' && actions[suffix]) {
      const taskDirectory = url.searchParams.get('directory')?.trim();
      if (suffix === 'prompt_async' && taskDirectory && input.hostAuthorized) {
        const sessionPath = `/api/session/${encodeURIComponent(sessionID)}`;
        const current = await input.nativeFetch(input.nativeBaseUrl + sessionPath);
        if (!current.ok) throw new ApiError(current.status, 'session_unavailable', 'Conversation could not be read');
        const session = record(record(await current.json()).data);
        if (record(session.location).directory !== taskDirectory) {
          const moved = await input.nativeFetch(input.nativeBaseUrl + sessionPath + '/move', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: taskDirectory }),
          });
          if (!moved.ok) throw new ApiError(moved.status, 'session_move_failed', 'Conversation could not move to the task directory');
        }
      }
      const value = await unwrap(client.session[actions[suffix]](parameters, options));
      return suffix === 'prompt_async' ? new Response(null, { status: 204 }) : json(value);
    }
  }
  const question = /^\/opencode\/question\/([^/]+)\/(reply|reject)$/.exec(path);
  if (question && request.method === 'POST') return json(await unwrap(client.question[question[2]]({ ...parameters, requestID: decodeURIComponent(question[1]) }, options)));
  const permission = /^\/opencode\/permission\/([^/]+)\/reply$/.exec(path);
  if (permission && request.method === 'POST') return json(await unwrap(client.permission.reply({ ...parameters, requestID: decodeURIComponent(permission[1]) }, options)));
  const reads: Record<string, () => Promise<Result>> = {
    '/opencode/agent': () => client.app.agents(parameters, options),
    '/opencode/command': () => client.command.list(parameters, options),
    '/opencode/provider': () => client.provider.list(parameters, options),
    '/opencode/config/providers': () => client.config.providers(parameters, options),
    '/opencode/config': () => client.config.get(parameters, options),
    '/opencode/permission': () => client.permission.list(parameters, options),
    '/opencode/question': () => client.question.list(parameters, options),
    '/opencode/mcp': () => client.mcp.status(parameters, options),
    '/opencode/find/file': () => client.find.files(parameters, options),
    '/opencode/global/health': () => client.global.health(parameters, options),
  };
  if (request.method === 'GET' && reads[path]) return json(await unwrap(reads[path]()));
  throw new ApiError(501, 'tron_operation_unavailable', `This operation is not available with Tron: ${request.method} ${path}`);
}
