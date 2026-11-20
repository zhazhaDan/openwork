import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Tron desktop contracts execute MCP tools and preserve configuration and workspace isolation', {
  skip: !process.env.OPENWORK_TEST_TRON, timeout: 180_000,
}, async () => {
  const engine = resolve(process.env.OPENWORK_TEST_TRON!);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tron-adaptation-')));
  const a = join(root, 'a'), b = join(root, 'b'), home = join(root, 'home');
  const overrides = { HOME: home, OPENWORK_USER_HOME: home, TRON_CONFIG_DIR: join(root, 'host'),
    TRON_DB: join(root, 'tron.db'), OPENWORK_RUNTIME_DB: join(root, 'runtime.sqlite'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENWORK_DATA_DIR: join(root, 'server-data') };
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  let tool: 'echo' | 'write' | undefined;
  let failModel = false;
  const failures: string[] = [];
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json();
    if (failModel && body.tools) return Response.json({ error: { message: 'fixture failure', type: 'invalid_request_error', code: 'invalid_request' } }, { status: 400 });
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'repair-proof', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    let content = 'native-proof-done';
    if (tool && body.tools) {
      const name = tool === 'echo' ? 'proof_echo' : 'write';
      const found = body.tools.find((entry: { function: { name: string } }) => entry.function.name === name);
      const parameters = tool === 'echo' ? { text: 'native-proof' } : { path: join(a, 'proof.txt'), content: 'new native file\n' };
      tool = undefined;
      if (found) return new Response(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'proof-call', type: 'function', function: { name, arguments: JSON.stringify(parameters) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      failures.push(`Missing executable tool ${name}`); content = 'missing tool';
    }
    if (!body.stream) return Response.json({ id: 'proof', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    return new Response(frame({ role: 'assistant', content }) + frame({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const { startEmbeddedServer } = await import('../src/embedded.js');
  const { writeRuntimeOpencodeConfig, readRuntimeOpencodeConfig, reconcileTronRuntimeConfig } = await import('../src/runtime-opencode-config-store.js');
  let server: Awaited<ReturnType<typeof startEmbeddedServer>> | undefined;
  try {
    for (const directory of [a, b, home, overrides.TRON_CONFIG_DIR]) await mkdir(directory, { recursive: true });
    await writeFile(join(a, 'proof.txt'), 'old native file\n');
    execFileSync('git', ['init', '-q'], { cwd: a });
    execFileSync('git', ['add', 'proof.txt'], { cwd: a });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixture'], { cwd: a });
    const hostPath = join(overrides.TRON_CONFIG_DIR, 'tron.jsonc');
    const providers = { fixture: { name: 'Local fixture', package: '@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'fixture-only' }, models: { mock: { name: 'Fixture', capabilities: { tools: true }, limit: { context: 1000000, output: 8192 } } } } };
    const saveHost = (mcp: unknown = {}) => writeFile(hostPath, JSON.stringify({ providers, mcp }));
    await saveHost();
    await mkdir(join(overrides.TRON_CONFIG_DIR, 'commands'), { recursive: true });
    await mkdir(join(overrides.TRON_CONFIG_DIR, 'plugins'), { recursive: true });
    await writeFile(join(overrides.TRON_CONFIG_DIR, 'commands', 'global-proof.md'), '---\nname: global-proof\ndescription: Global fixture\n---\nReply briefly\n');
    await writeFile(join(overrides.TRON_CONFIG_DIR, 'plugins', 'global-proof.js'), "export default {id:'fixture.global-proof',setup:async()=>{}};\n");
    const callLog = join(root, 'mcp-called');
    const script = join(root, 'mcp.py');
    await writeFile(script, `import json,sys\nfor line in sys.stdin:\n try:\n  r=json.loads(line); m=r.get('method'); i=r.get('id')\n  if i is None: continue\n  if m=='initialize': result={'protocolVersion':'2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'proof','version':'1'}}\n  elif m=='tools/list': result={'tools':[{'name':'echo','description':'Echo test','inputSchema':{'type':'object','properties':{'text':{'type':'string'}}}}]}\n  elif m=='tools/call':\n   open(${JSON.stringify(callLog)},'a').write('called\\n'); result={'content':[{'type':'text','text':'native-proof'}]}\n  else: result={}\n  print(json.dumps({'jsonrpc':'2.0','id':i,'result':result}),flush=True)\n except Exception: pass\n`);
    const mcpConfig = { type: 'local', command: ['python3', '-u', script], codemode: false, enabled: true };
    const options = { host: '127.0.0.1', port: 0, configPath: join(root, 'server.json'), token: 'fixture-client', hostToken: 'fixture-host',
      approvalMode: 'auto', logRequests: false, workspaces: [a, b], manageOpencode: true, opencodeBin: engine, opencodeCwd: a };
    server = await startEmbeddedServer(options);
    const [wa, wb] = server.config.workspaces.map(workspace => workspace.id);
    const native = (id: string) => `/workspace/${id}/opencode2/api`;
    const legacy = (id: string) => `/w/${id}/opencode`;
    async function request(path: string, method = 'GET', body?: unknown, expected = 200) {
      const response = await fetch(server!.url + path, { method, headers: { authorization: 'Bearer fixture-client', 'x-openwork-host-token': 'fixture-host', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35_000) });
      assert.equal(response.status, expected, `${method} ${path}: ${await response.clone().text()}`);
      return response.status === 204 ? undefined : response.json();
    }
    async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
      let value: T;
      const deadline = Date.now() + 15_000;
      do { value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
      assert.fail(`Condition did not settle: ${JSON.stringify(value)}`);
    }
    const pid = server.managedOpencode?.pid;
    assert.ok((await request(`/workspace/${wa}/commands?scope=global`)).items.some((entry: { name: string }) => entry.name === 'global-proof'));
    await until(() => request(native(wa) + '/command'), catalog => catalog.data.some((entry: { name: string }) => entry.name === 'global-proof'));
    await until(() => request(native(wa) + '/plugin'), catalog => catalog.data.some((entry: { id: string; state: { status: string } }) => entry.id === 'fixture.global-proof' && entry.state.status === 'active'));

    assert.equal((await request('/capabilities')).session.deleteMessage, false);
    await writeFile(join(a, 'proof-search.txt'), 'search fixture');
    assert.deepEqual(await request(legacy(wa) + '/find/file?query=proof-search&dirs=true&limit=50'), ['proof-search.txt']);
    assert.deepEqual(await request(legacy(wb) + '/find/file?query=proof-search&limit=50'), []);
    const fileSession = (await request(`/workspace/${wa}/files/sessions`, 'POST', { write: false, ttlSeconds: 30 })).session;
    await writeFile(join(a, '.gitignore'), 'ignore-proof\n');
    await writeFile(join(root, 'outside'), 'outside fixture');
    await symlink(join(root, 'outside'), join(a, 'escape'));
    const batch = await request(`/files/sessions/${fileSession.id}/read-batch`, 'POST', { paths: ['.gitignore', '../outside', 'escape'] });
    assert.equal(Buffer.from(batch.items[0].contentBase64, 'base64').toString(), 'ignore-proof\n');
    assert.equal(batch.items[1].ok, false); assert.equal(batch.items[2].ok, false);
    assert.ok((await request(`/files/sessions/${fileSession.id}/renew`, 'POST', { ttlSeconds: 1800 })).session.expiresAt > fileSession.expiresAt);
    await request(`/files/sessions/${fileSession.id}`, 'DELETE');
    await request(`/files/sessions/${fileSession.id}/renew`, 'POST', {}, 404);

    const session = await request(legacy(wa) + '/session', 'POST', { title: 'Native proof' });
    await request(`/workspace/${wa}/mcp`, 'POST', { name: 'proof', config: mcpConfig });
    const catalog = await request(native(wa) + '/rpc/openwork.mcp-readiness/catalog', 'POST', { input: { server: 'proof' } });
    assert.ok(catalog.output.tools.includes('proof_echo'));
    assert.ok(!(await request(native(wb) + '/mcp')).data.some((entry: { name: string }) => entry.name === 'proof'));
    const prompt = async (id: string, text: string) => request(legacy(wa) + `/session/${id}/prompt_async`, 'POST', { model: { providerID: 'fixture', modelID: 'mock' }, agent: 'build', parts: [{ type: 'text', text }] }, 204);
    const settled = (id: string, replies: number) => until(() => request(`/workspace/${wa}/sessions/${id}/snapshot`), snapshot => snapshot.item.status.type === 'idle'
      && snapshot.item.messages.filter((entry: { info: { role: string } }) => entry.info.role === 'assistant').length >= replies);
    tool = 'echo'; await prompt(session.id, 'Execute the fixture echo tool'); await settled(session.id, 2);
    assert.equal(await readFile(callLog, 'utf8'), 'called\n');
    await request(`/workspace/${wa}/mcp/proof`, 'DELETE');
    assert.deepEqual((await request(native(wa) + '/rpc/openwork.mcp-readiness/catalog', 'POST', { input: { server: 'proof' } })).output.tools, []);
    assert.equal(server.managedOpencode?.pid, pid);

    tool = 'write'; await prompt(session.id, 'Write the fixture file'); await settled(session.id, 4);
    assert.equal(await readFile(join(a, 'proof.txt'), 'utf8'), 'new native file\n');
    await writeFile(join(a, 'proof.txt'), 'later unrelated disk edit\n');
    const diff = await request(legacy(wa) + `/session/${session.id}/diff`);
    assert.ok(diff.some((entry: { file: string; patch: string }) => entry.file.endsWith('proof.txt') && entry.patch.includes('new native file')), JSON.stringify(diff));
    assert.ok(!JSON.stringify(diff).includes('later unrelated disk edit'));
    await request(legacy(wa) + `/session/${session.id}/message/unsupported`, 'DELETE', undefined, 409);

    const retry = await request(legacy(wa) + '/session', 'POST', { title: 'Retry proof' });
    failModel = true; await prompt(retry.id, 'Retry this exact message'); await settled(retry.id, 1);
    failModel = false;
    assert.equal((await request(legacy(wa) + `/session/${retry.id}/retry`, 'POST', {})).result, 'retried');
    const retried = await settled(retry.id, 1);
    assert.equal(retried.item.messages.filter((entry: { info: { role: string } }) => entry.info.role === 'user').length, 1);
    assert.equal((await request(legacy(wa) + `/session/${retry.id}/retry`, 'POST', {})).result, 'nothing_to_retry');

    const bSession = (await request(native(wb) + '/session', 'POST', { title: 'Other workspace' })).data.id;
    await request(native(wb) + `/session/${bSession}/form`, 'POST', { title: 'Keep pending', fields: [{ key: 'answer', type: 'string', title: 'Answer' }] });
    await saveHost({ servers: { hostProof: { ...mcpConfig, enabled: undefined } } });
    await request(`/workspace/${wa}/engine/reload`, 'POST', {});
    assert.ok((await request(native(wa) + '/mcp')).data.some((entry: { name: string }) => entry.name === 'hostProof'));
    assert.ok((await request(native(wb) + '/form')).data.length > 0, 'reloading A must preserve pending forms in B');
    assert.equal(server.managedOpencode?.pid, pid);
    await saveHost(); await request(`/workspace/${wa}/engine/reload`, 'POST', {});
    assert.ok(!(await request(native(wa) + '/mcp')).data.some((entry: { name: string }) => entry.name === 'hostProof'));
    const aSession = (await request(native(wa) + '/session', 'POST', { title: 'Keep target pending' })).data.id;
    await request(native(wa) + `/session/${aSession}/form`, 'POST', { title: 'Keep A pending', fields: [{ key: 'answer', type: 'string', title: 'Answer' }] });
    await saveHost({ servers: { liveProof: { ...mcpConfig, enabled: undefined } } });
    await request(`/workspace/${wa}/engine/sync`, 'POST', {});
    for (const id of [wa, wb]) {
      assert.ok((await request(native(id) + '/mcp')).data.some((entry: { name: string }) => entry.name === 'liveProof'));
      assert.ok((await request(native(id) + '/form')).data.length > 0, 'live sync must preserve pending requests in every workspace');
    }
    await request(`/workspace/${wa}/engine/reload`, 'POST', {}, 409);
    await saveHost(); await request(`/workspace/${wa}/engine/sync`, 'POST', {});
    for (const id of [wa, wb]) {
      assert.ok(!(await request(native(id) + '/mcp')).data.some((entry: { name: string }) => entry.name === 'liveProof'));
      assert.deepEqual((await request(native(id) + '/rpc/openwork.mcp-readiness/catalog', 'POST', { input: { server: 'liveProof' } })).output.tools, []);
      assert.ok((await request(native(id) + '/form')).data.length > 0);
    }
    assert.equal(server.managedOpencode?.pid, pid);
    // A Server edit and an unrelated Server entry survive host reconciliation.
    await reconcileTronRuntimeConfig(server.config, wa, { provider: {}, mcp: { imported: mcpConfig } });
    await writeRuntimeOpencodeConfig(server.config, wa, current => ({ ...current, mcp: { ...current.mcp, imported: { ...mcpConfig, enabled: false }, serverOwned: mcpConfig } }));
    await reconcileTronRuntimeConfig(server.config, wa, { provider: {}, mcp: {} });
    const preserved = await readRuntimeOpencodeConfig(server.config, wa);
    assert.equal(preserved.mcp?.imported.enabled, false); assert.ok(preserved.mcp?.serverOwned);
    await server.stop(); server = await startEmbeddedServer(options);
    assert.ok(!(await request(native(wa) + '/mcp')).data.some((entry: { name: string }) => entry.name === 'hostProof'));
    assert.deepEqual(failures, []);
  } finally {
    await server?.stop(); model.stop(true);
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
