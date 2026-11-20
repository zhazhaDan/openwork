import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configuredTron } from "../src/local-tron.js";

test("engine selection preserves the existing launch configuration without path discovery or version probes", () => {
  const env = { OPENWORK_OPENCODE_BIN: "/configured/tron", PATH: "/another/bin", HOME: "/another/home" };
  assert.deepEqual(configuredTron({ env }), { bin: "/configured/tron", source: "env" });
  assert.deepEqual(configuredTron({ bin: "/host/engine-custom-name", env }), { bin: "/host/engine-custom-name", source: "env" });
  assert.deepEqual(configuredTron({ bin: "C:\\runtime\\tron.exe", env }), { bin: "C:\\runtime\\tron.exe", source: "env" });
  assert.throws(() => configuredTron({ env: {
    PATH: process.env.PATH, HOME: process.env.HOME,
    WUDONG_TRON_BIN: "/ignored/tron", OPENWORK_OPENCODE2_BIN: "/ignored/opencode2",
  } }), /engine path is missing/);
});

test("embedded Server starts the supplied Tron path and working directory and stops its child", {
  skip: !process.env.OPENWORK_TEST_TRON,
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "local-tron-server-"));
  const overrides = {
    OPENWORK_OPENCODE_BIN: "/invalid/should-not-override-host-config",
    TRON_DB: join(root, "tron.db"),
    TRON_CONFIG_DIR: join(root, "host-config"),
    FIXTURE_API_KEY: "local-fixture-only",
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENWORK_ENGINE_V2_PREVIEW: "sidecar",
  };
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const { startEmbeddedServer } = await import("../src/embedded.js");
  const observedAuthorization: Array<string | null> = [];
  const modelServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    observedAuthorization.push(request.headers.get('authorization'));
    const body = await request.json();
    const completion = { id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Wudong native fixture reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    if (!body.stream) return Response.json(completion);
    return new Response([
      { ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Wudong native fixture reply' }, finish_reason: null }] },
      { ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  let server: Awaited<ReturnType<typeof startEmbeddedServer>> | undefined;
  try {
    await mkdir(overrides.TRON_CONFIG_DIR, { recursive: true });
    await writeFile(join(overrides.TRON_CONFIG_DIR, 'tron.jsonc'), JSON.stringify({ provider: { fixture: {
      name: 'Local fixture', npm: '@ai-sdk/openai-compatible', env: ['FIXTURE_API_KEY'],
      options: { baseURL: `http://127.0.0.1:${modelServer.port}/v1`, apiKey: '{env:FIXTURE_API_KEY}' },
      models: { mock: { name: 'Fixture model', limit: {context: 1000000, output: 8192} } },
    } } }));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const engineCwd = join(root, "configured-working-directory");
    let engineBin = await realpath(process.env.OPENWORK_TEST_TRON!);
    const startupCwd = join(root, "startup-cwd");
    if (process.platform !== "win32") {
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const wrapper = join(root, "configured-engine-custom-name");
      await writeFile(wrapper, `#!/bin/sh\npwd > ${quote(startupCwd)}\nexec ${quote(engineBin)} "$@"\n`, { mode: 0o755 });
      engineBin = wrapper;
    }
    const opencodeDatabase = join(root, "data", "opencode", "opencode.db");
    await mkdir(join(root, "data", "opencode"), { recursive: true });
    await writeFile(opencodeDatabase, "untouched OpenCode history");
    server = await startEmbeddedServer({
      host: "127.0.0.1", port: 0, configPath: join(root, "server.json"),
      token: "local-tron-client", hostToken: "local-tron-host", logRequests: false,
      workspaces: [workspace], manageOpencode: true, opencodeBin: engineBin, opencodeCwd: engineCwd,
    });
    assert.equal(server.config.localTron?.bin, engineBin);
    if (process.platform !== "win32") assert.equal((await readFile(startupCwd, "utf8")).trim(), await realpath(engineCwd));
    assert.equal(server.managedOpencode?.isAlive(), true);
    const pid = server.managedOpencode?.pid;
    assert.ok(pid);
    const request = (path: string, init?: RequestInit) => fetch(`${server!.url}${path}`, {
      ...init, headers: { authorization: "Bearer local-tron-client", "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const status = await request("/experimental/engine-v2-preview/status");
    assert.equal(status.status, 200);
    const state = await status.json();
    assert.equal(state.version, "0.5.1");
    assert.equal(state.chatRouting, true);
    assert.equal(state.pid, pid);
    const mount = `/workspace/${server.config.workspaces[0].id}/opencode2/api`;
    const created = await request(`${mount}/session`, { method: "POST", body: JSON.stringify({ location: { directory: workspace } }) });
    assert.equal(created.status, 200, await created.clone().text());
    const session = await created.json();
    assert.match(session.data.id, /^ses_/);
    assert.equal((await request(`${mount}/session/${session.data.id}`)).status, 200);
    assert.equal((await request("/experimental/engine-v2-preview", { method: "PUT", body: JSON.stringify({ chatRouting: false }) })).status, 409);
    assert.equal(await readFile(opencodeDatabase, "utf8"), "untouched OpenCode history");
    const legacyMount = `/w/${server.config.workspaces[0].id}/opencode`;
    const legacyCreated = await request(`${legacyMount}/session`, { method: "POST", body: JSON.stringify({ title: "Wudong compatibility" }) });
    assert.equal(legacyCreated.status, 200, await legacyCreated.clone().text());
    const legacySession = await legacyCreated.json();
    assert.equal(legacySession.directory, workspace);
    const semantic = `/workspace/${server.config.workspaces[0].id}/sessions`;
    const listed = await request(`${semantic}?roots=true&limit=100`);
    assert.equal(listed.status, 200, await listed.clone().text());
    assert.ok((await listed.json()).items.some((item: {id:string}) => item.id === legacySession.id));
    // Renderer snapshots always include a display limit. Keep this query in
    // the integration test: passing the raw string limit into session.todo()
    // used to make every conversation snapshot return 500.
    const snapshot = await request(`${semantic}/${legacySession.id}/snapshot?limit=300`);
    assert.equal(snapshot.status, 200, await snapshot.clone().text());
    const snapshotData = (await snapshot.json()).item;
    assert.equal(snapshotData.session.id, legacySession.id);
    assert.deepEqual(snapshotData.messages, []);
    assert.equal(snapshotData.status.type, "idle");
    assert.equal((await request(`${legacyMount}/session/status`)).status, 200);
    const eventAbort = new AbortController();
    const eventResponse = await fetch(`${server.url}${legacyMount}/event`, { headers: {authorization:'Bearer local-tron-client'}, signal: eventAbort.signal });
    const observed: string[] = [];
    const eventReader = eventResponse.body!.getReader();
    const readingEvents = (async () => {
      try {
        while (true) {
          const next = await eventReader.read();
          if (next.done) break;
          observed.push(new TextDecoder().decode(next.value));
        }
      } catch { /* Aborting the subscription ends the read. */ }
    })();
    try {
      const prompt = await request(`${legacyMount}/session/${legacySession.id}/prompt_async`, { method:'POST', body:JSON.stringify({
        model: { providerID:'fixture', modelID:'mock' }, agent:'build', parts:[{type:'text',text:'Say hello'}],
      }) });
      assert.equal(prompt.status, 204, await prompt.clone().text());
      let reply = '';
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const history = await request(`${semantic}/${legacySession.id}/snapshot`);
        const value = (await history.json()).item;
        reply = JSON.stringify(value.messages);
        if (reply.includes('Wudong native fixture reply') && value.status.type === 'idle') break;
        await new Promise(resolve => setTimeout(resolve,100));
      }
      assert.match(reply,/Wudong native fixture reply/, observed.join('').slice(-18000));
      assert.deepEqual(JSON.parse(reply).map((message: {info: {role:string}}) => message.info.role), ['user','assistant']);
      assert.match(observed.join(''),/message.part.updated/);
      assert.match(observed.join(''),/session.status/);
      assert.match(observed.join(''),/session.idle/);
      assert.ok(observedAuthorization.includes('Bearer local-fixture-only'));
    } finally { eventAbort.abort(); await readingEvents; }

    const viewer = await fetch(`${server.url}${legacyMount}/session`, { method: "POST", headers: {authorization: "Bearer invalid"}, body: "{}" });
    assert.equal(viewer.status, 401);
    for (const endpoint of [`${legacyMount}/event`, '/opencode/global/event']) {
      const abort = new AbortController();
      const events = await fetch(`${server.url}${endpoint}`, { headers: {authorization:"Bearer local-tron-client"}, signal: abort.signal });
      assert.equal(events.status, 200);
      assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = events.body!.getReader();
      assert.equal((await reader.read()).done, false);
      abort.abort();
      await reader.cancel().catch(() => {});
    }
    assert.equal((await request(`${semantic}/${legacySession.id}`, {method:'DELETE'})).status, 200);
    assert.equal((await request(`${semantic}/${legacySession.id}`)).status, 404);
    assert.equal((await request(`${semantic}/${legacySession.id}/snapshot?limit=300`)).status, 404);
    const secondaryWorkspace = join(root, 'secondary-workspace');
    const register = await fetch(`${server.url}/workspaces/local`, {
      method: 'POST', headers: { authorization:'Bearer local-tron-client', 'x-openwork-host-token':'local-tron-host', 'content-type':'application/json' },
      body: JSON.stringify({ folderPath: secondaryWorkspace, name:'Second project' }),
    });
    assert.equal(register.status, 201, await register.clone().text());
    const registered = await register.json();
    const secondaryId = registered.activeId;
    const secondaryMount = `/workspace/${secondaryId}/opencode2/api`;
    const secondaryCreate = await request(`${secondaryMount}/session`, {method:'POST',body:JSON.stringify({title:'Survives key refresh'})});
    assert.equal(secondaryCreate.status,200,await secondaryCreate.clone().text());
    const secondarySession = (await secondaryCreate.json()).data.id;
    assert.ok((await stat(overrides.TRON_DB)).size > 0);
    await server.stop();
    assert.equal(server.managedOpencode?.isAlive(), false);
    assert.throws(() => process.kill(pid, 0));
    // The desktop restarts with only its bootstrap folder and a refreshed key.
    process.env.FIXTURE_API_KEY = 'local-fixture-rotated';
    server = await startEmbeddedServer({
      host:'127.0.0.1', port:0, configPath:join(root,'server.json'),
      token:'local-tron-client',hostToken:'local-tron-host',logRequests:false,
      workspaces:[workspace],manageOpencode:true,opencodeBin:engineBin,opencodeCwd:engineCwd,
    });
    const restored = server.config.workspaces.find(workspace => workspace.id === secondaryId);
    assert.equal(restored?.path, secondaryWorkspace);
    assert.equal(restored?.name, 'Second project');
    const restoredSnapshot = await request(`/workspace/${secondaryId}/sessions/${secondarySession}/snapshot`);
    assert.equal(restoredSnapshot.status,200,await restoredSnapshot.clone().text());
    assert.equal((await restoredSnapshot.json()).item.session.id,secondarySession);
    const restoredList = await request(`/workspace/${secondaryId}/sessions`);
    assert.equal(restoredList.status,200);
    assert.ok((await restoredList.json()).items.some((session: {id:string}) => session.id === secondarySession));
    observedAuthorization.length = 0;
    const refreshedPrompt = await request(`/w/${secondaryId}/opencode/session/${secondarySession}/prompt_async`, {
      method:'POST', body:JSON.stringify({
        model:{providerID:'fixture',modelID:'mock'},agent:'build',parts:[{type:'text',text:'Check refreshed key'}],
      }),
    });
    assert.equal(refreshedPrompt.status,204,await refreshedPrompt.clone().text());
    const refreshDeadline = Date.now() + 15_000;
    while (Date.now() < refreshDeadline) {
      const refreshed = await request(`/workspace/${secondaryId}/sessions/${secondarySession}/snapshot`);
      const item = (await refreshed.json()).item;
      if (observedAuthorization.length > 0 && item.status.type === 'idle') break;
      await new Promise(resolve => setTimeout(resolve,100));
    }
    assert.ok(observedAuthorization.length > 0, 'the restarted engine must call the local provider');
    assert.ok(observedAuthorization.every(value => value === 'Bearer local-fixture-rotated'));

  } finally {
    await server?.stop();
    modelServer.stop(true);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
