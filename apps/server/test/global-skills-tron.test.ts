import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("desktop global skills are listed and hot loaded by Tron in multiple workspaces", {
  skip: !process.env.OPENWORK_TEST_TRON,
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "global-skills-tron-"));
  const home = join(root, "home");
  const userHome = join(root, "user-home");
  const overrides = {
    HOME: home, OPENWORK_USER_HOME: userHome,
    TRON_DB: join(root, "tron.db"), TRON_CONFIG_DIR: join(root, "host-config"),
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENWORK_ENGINE_V2_PREVIEW: "sidecar",
  };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const { startEmbeddedServer } = await import("../src/embedded.js");
  let server: Awaited<ReturnType<typeof startEmbeddedServer>> | undefined;
  try {
    const workspaces = [join(root, "project-a"), join(root, "project-b")];
    for (const dir of [home, userHome, ...workspaces]) await mkdir(dir, { recursive: true });
    server = await startEmbeddedServer({
      host: "127.0.0.1", port: 0, configPath: join(root, "server.json"),
      token: "skill-fixture", hostToken: "skill-host", logRequests: false,
      workspaces, manageOpencode: true, opencodeBin: await realpath(process.env.OPENWORK_TEST_TRON!),
      opencodeCwd: workspaces[0],
    });
    const pid = server.managedOpencode?.pid;
    const request = (path: string, authenticated = true) => fetch(`${server!.url}${path}`, {
      headers: authenticated ? { authorization: "Bearer skill-fixture" } : {},
      signal: AbortSignal.timeout(20_000),
    });
    const globalItems = async () => {
      const response = await request("/skills/global");
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).items;
    };
    assert.equal((await request("/skills/global", false)).status, 401);
    assert.deepEqual(await globalItems(), []);
    const nativeItems = async (id: string) => {
      const response = await request(`/workspace/${id}/opencode2/api/skill`);
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).data;
    };
    for (const workspace of server.config.workspaces) await nativeItems(workspace.id);
    const skillDir = join(home, ".tron", "skills", "productivity", "installed-skill");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    const content = (body: string) => `---\nname: installed-skill\ndescription: Installed from the desktop\n---\n${body}\n`;
    await writeFile(skillPath, content("First version"));
    // A same-named CLI skill must not hide the desktop installation in the list.
    const duplicate = join(userHome, ".tron", "skills", "installed-skill");
    await mkdir(duplicate, { recursive: true });
    await writeFile(join(duplicate, "SKILL.md"), content("CLI copy"));
    const items = await globalItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].path, skillPath);
    assert.equal(items[0].scope, "global");
    await rm(duplicate, { recursive: true });
    const waitForContent = async (body: string | null) => {
      const deadline = Date.now() + 10_000;
      let inventories: Array<Array<{ name: string; path: string; content: string }>> = [];
      do {
        inventories = await Promise.all(server!.config.workspaces.map((workspace) => nativeItems(workspace.id)));
        if (inventories.every((inventory) => body === null
          ? !inventory.some((item) => item.name === "installed-skill")
          : inventory.some((item) => item.path === skillPath && item.content.trim() === body))) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.fail(`Skill changes did not reach both workspaces: ${JSON.stringify(inventories)}`);
    };
    await waitForContent("First version");
    await writeFile(skillPath, content("Updated version"));
    await waitForContent("Updated version");
    await rm(skillDir, { recursive: true });
    assert.deepEqual(await globalItems(), []);
    await waitForContent(null);
    assert.equal(server.managedOpencode?.pid, pid);
    assert.equal(server.managedOpencode?.isAlive(), true);
  } finally {
    await server?.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
