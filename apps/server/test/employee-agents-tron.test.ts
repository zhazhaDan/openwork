import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('employee agents hot load and execute while an unrelated MCP requires login', {
  skip: !process.env.OPENWORK_TEST_TRON, timeout: 90_000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'employee-agents-tron-')));
  const overrides = {
    TRON_CONFIG_DIR: join(root, 'host'), TRON_DB: join(root, 'tron.db'),
    OPENWORK_RUNTIME_DB: join(root, 'runtime.sqlite'), OPENWORK_DATA_DIR: join(root, 'server-data'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    HOME: join(root, 'home'), OPENWORK_USER_HOME: join(root, 'home'),
  };
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  let initialized = 0;
  let modelInput = '';
  const mcp = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/unauthorized') return new Response('Login required', { status: 401 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const input = await request.json();
    if (input.method === 'initialize') initialized++;
    if (input.id === undefined) return new Response(null, { status: 202 });
    const result = input.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : input.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Fixture echo', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'fixture' }] };
    return Response.json({ jsonrpc: '2.0', id: input.id, result });
  } });
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json();
    modelInput = JSON.stringify(body);
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'employee-proof', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(frame({ role: 'assistant', content: 'employee task completed' }) + frame({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const { startEmbeddedServer } = await import('../src/embedded.js');
  let server: Awaited<ReturnType<typeof startEmbeddedServer>> | undefined;
  try {
    const workspaces = [join(root, 'a'), join(root, 'b')];
    for (const directory of [...workspaces, overrides.HOME, overrides.TRON_CONFIG_DIR]) await mkdir(directory, { recursive: true });
    const hostPath = join(overrides.TRON_CONFIG_DIR, 'tron.jsonc');
    const config = {
      providers: { fixture: { name: 'Fixture', package: '@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'fixture-only' }, models: { mock: { name: 'Fixture', capabilities: { tools: true }, limit: { context: 1000000, output: 8192 } } } } },
      mcp: {
        ready: { type: 'remote', url: `http://127.0.0.1:${mcp.port}/ready`, oauth: false, enabled: true, codemode: false },
        unauthorized: { type: 'remote', url: `http://127.0.0.1:${mcp.port}/unauthorized`, oauth: false, enabled: true },
      },
      agents: {},
    };
    async function save() {
      await writeFile(hostPath + '.tmp', JSON.stringify(config));
      await rename(hostPath + '.tmp', hostPath);
    }
    await save();
    server = await startEmbeddedServer({ host: '127.0.0.1', port: 0, configPath: join(root, 'server.json'), token: 'fixture', hostToken: 'fixture-host', logRequests: false,
      workspaces, manageOpencode: true, opencodeBin: await realpath(process.env.OPENWORK_TEST_TRON!), opencodeCwd: workspaces[0] });
    const pid = server.managedOpencode?.pid;
    const mounts = server.config.workspaces.map(workspace => `/workspace/${workspace.id}/opencode2/api`);
    const legacy = `/w/${server.config.workspaces[0].id}/opencode`;
    async function request(path: string, method = 'GET', body?: unknown) {
      const response = await fetch(server!.url + path, { method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
      return response.status === 204 ? undefined : response.json();
    }
    async function until(read: () => Promise<boolean>, label = 'employee') {
      const deadline = Date.now() + 10_000;
      do { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
      assert.fail(`Configuration did not settle: ${label}`);
    }
    for (const mount of mounts) {
      await request(mount + '/agent');
      await until(async () => {
        const inventory = (await request(mount + '/mcp')).data;
        return inventory.some((entry: { name: string; status: { status: string } }) => entry.name === 'ready' && entry.status.status === 'connected')
          && inventory.some((entry: { name: string; status: { status: string } }) => entry.name === 'unauthorized' && ['failed', 'needs_auth'].includes(entry.status.status));
      }, `MCP ${mount}`);
    }
    assert.equal(initialized, 2);
    const employee = { description: 'Employee first version', system: 'employee-system-proof-v1', mode: 'primary', hidden: true,
      permissions: [{ action: 'skill', resource: '*', effect: 'deny' }] };
    config.agents = { 'wudong-employee-fixture': employee, 'unrelated-native-agent': { system: 'not mirrored' } };
    await save();
    const verify = async () => {
      for (const mount of mounts) await until(async () => {
        const agents = (await request(mount + '/agent')).data;
        assert.ok(!agents.some((agent: { id: string }) => agent.id === 'unrelated-native-agent'));
        return agents.some((agent: { id: string; system: string; description: string; permissions: Array<{ action: string; resource: string; effect: string }> }) => agent.id === 'wudong-employee-fixture'
          && agent.system === employee.system && agent.description === employee.description
          && agent.permissions.findLast(rule => rule.action === 'skill' && rule.resource === '*')?.effect === 'deny');
      });
    };
    await verify();
    employee.description = 'Employee updated'; employee.system = 'employee-system-proof-v2';
    await save(); await verify();
    const first = server.config.workspaces[0];
    const taskDirectory = join(first.path, '.wudong', 'worktrees', 'fixture');
    await mkdir(taskDirectory, { recursive: true });
    const permissions = [{ permission: 'read', pattern: '/employee-cache/**', action: 'allow' },
      { permission: 'edit', pattern: '/employee-cache/**', action: 'deny' }];
    const created = await fetch(server.url + legacy + `/session?directory=${encodeURIComponent(taskDirectory)}`, {
      method: 'POST', headers: { authorization: 'Bearer fixture', 'x-openwork-host-token': 'fixture-host', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Employee task', model: { providerID: 'fixture', modelID: 'mock' }, permission: permissions }),
    });
    assert.ok(created.ok, await created.clone().text());
    const session = await created.json();
    const nativeSession = (await request(mounts[0] + `/session/${session.id}`)).data;
    assert.equal(nativeSession.location.directory, taskDirectory, 'Execution must stay in the task worktree');
    assert.equal(nativeSession.openworkHomeDirectory, first.path, 'Conversation must remain owned by the original workspace');
    assert.deepEqual(nativeSession.model, { providerID: 'fixture', id: 'mock', variant: 'default' });
    assert.deepEqual(nativeSession.permissions, permissions.map(rule => ({ action: rule.permission, resource: rule.pattern, effect: rule.action })));
    assert.deepEqual((await request(legacy + `/session/${session.id}`)).permission, permissions);
    const updatedPermissions = [...permissions, { permission: 'external_directory', pattern: '/employee-cache/**', action: 'allow' }];
    await request(legacy + `/session/${session.id}`, 'PATCH', { permission: updatedPermissions });
    assert.deepEqual((await request(legacy + `/session/${session.id}`)).permission, updatedPermissions);
    assert.equal((await request(mounts[0] + `/session/${session.id}/permission`, 'POST', {
      action: 'edit', resources: ['/employee-cache/immutable.txt'],
    })).data.effect, 'deny', 'The native engine must enforce the session resource rules');
    const eventsAbort = new AbortController();
    const eventResponse = await fetch(server.url + '/opencode/global/event', {
      headers: { authorization: 'Bearer fixture', accept: 'text/event-stream' }, signal: eventsAbort.signal,
    });
    assert.ok(eventResponse.ok);
    const received: Array<{ directory: string; payload: { type: string; properties: { sessionID: string } } }> = [];
    const consume = (async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      try {
        for await (const chunk of eventResponse.body!) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
          for (const line of lines) if (line.startsWith('data:')) received.push(JSON.parse(line.slice(5)));
        }
      } catch (error) { if (!eventsAbort.signal.aborted) throw error; }
    })();
    await request(legacy + `/session/${session.id}/prompt_async`, 'POST', { model: { providerID: 'fixture', modelID: 'mock' }, agent: 'wudong-employee-fixture', parts: [{ type: 'text', text: 'Complete the task' }] });
    await until(async () => {
      const snapshot = (await request(`/workspace/${first.id}/sessions/${session.id}/snapshot`)).item;
      return snapshot.status.type === 'idle' && JSON.stringify(snapshot.messages).includes('employee task completed');
    });
    assert.ok(modelInput.includes(employee.system), modelInput);
    assert.equal((await request(`/workspace/${first.id}/sessions/${session.id}`)).item.status.type, 'idle');
    const messages = (await request(`/workspace/${first.id}/sessions/${session.id}/messages?limit=100`)).items;
    assert.ok(messages.some((message: { info: { role: string }; parts: unknown[] }) => message.info.role === 'assistant' && JSON.stringify(message.parts).includes('employee task completed')));
    await request(legacy + `/session/${session.id}/prompt_async`, 'POST', { model: { providerID: 'fixture', modelID: 'mock' }, agent: 'wudong-employee-fixture', parts: [{ type: 'text', text: 'Continue the task' }] });
    await until(async () => {
      const snapshot = (await request(`/workspace/${first.id}/sessions/${session.id}/snapshot`)).item;
      return snapshot.status.type === 'idle' && snapshot.messages.filter((message: { info: { role: string } }) => message.info.role === 'assistant').length === 2;
    }, 'continue execution');
    assert.equal((await request(mounts[0] + `/session/${session.id}`)).data.location.directory, taskDirectory);
    await until(async () => received.some(event => event.payload.type === 'session.idle' && event.payload.properties.sessionID === session.id), 'global SSE');
    assert.equal(received.find(event => event.payload.type === 'session.idle' && event.payload.properties.sessionID === session.id)?.directory, taskDirectory);
    eventsAbort.abort(); await consume;
    const misplaced = await request(legacy + '/session', 'POST', { title: 'Earlier employee session' });
    assert.equal((await request(mounts[0] + `/session/${misplaced.id}`)).data.location.directory, first.path);
    const resumed = await fetch(server.url + legacy + `/session/${misplaced.id}/prompt_async?directory=${encodeURIComponent(taskDirectory)}`, {
      method: 'POST', headers: { authorization: 'Bearer fixture', 'x-openwork-host-token': 'fixture-host', 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'fixture', modelID: 'mock' }, agent: 'wudong-employee-fixture', parts: [{ type: 'text', text: 'Resume the earlier task in its worktree' }] }),
    });
    assert.ok(resumed.ok, await resumed.clone().text());
    await until(async () => (await request(`/workspace/${first.id}/sessions/${misplaced.id}/snapshot`)).item.status.type === 'idle', 'resume older task');
    assert.equal((await request(mounts[0] + `/session/${misplaced.id}`)).data.location.directory, taskDirectory);
    assert.equal(initialized, 3, 'Only the newly opened task directory establishes another MCP connection');
    assert.equal(server.managedOpencode?.pid, pid);
    // Every generated-config rewrite must retain current employee profiles.
    const { runtimeStorageDir } = await import('../src/runtime-db.js');
    const { engineInstanceId } = await import('../src/engine-v2-preview.js');
    const instance = engineInstanceId();
    const generated = await readFile(join(runtimeStorageDir(server.config), 'tron', 'state', ...(instance ? ['instances', instance] : []), 'config', 'tron.json'), 'utf8');
    assert.ok(generated.includes(employee.system));
  } finally {
    await server?.stop(); model.stop(true); mcp.stop(true);
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
