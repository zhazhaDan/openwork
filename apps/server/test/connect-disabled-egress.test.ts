import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOpenWorkAutomationCatalog } from "../src/connect-automation-catalog.js";
import { getConnectSnapshot, writeConnectCloudMcp, writeConnectState } from "../src/connect-state.js";
import type { ServerConfig } from "../src/types.js";

describe("disabled Connect egress boundary", () => {
  let dir: string;
  let config: ServerConfig;
  const previousDb = process.env.OPENWORK_RUNTIME_DB;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openwork-connect-disabled-"));
    process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
    config = {
      host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
      workspaces: [{ id: "ws_test", path: dir, name: "test", workspaceType: "local" }],
      authorizedRoots: [dir], readOnly: false, startedAt: Date.now(),
      tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    };
    // Simulate disabling Connect without deleting a previously installed config.
    await writeConnectCloudMcp(config, { type: "remote", url: "https://den.test/mcp/agent" });
    await writeConnectState(config, { connectEnabled: false });
  });

  afterEach(() => {
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  });

  test("state and automation reads perform no active probe or Cloud fetch", async () => {
    let engineProbes = 0;
    let cloudRequests = 0;
    const snapshot = await getConnectSnapshot(config, {
      workspaceId: "ws_test",
      createWorkspaceOpencodeClient: () => {
        engineProbes += 1;
        throw new Error("disabled Connect attempted an engine health probe");
      },
    });
    const automations = await readOpenWorkAutomationCatalog(config, async () => {
      cloudRequests += 1;
      throw new Error("disabled Connect attempted Cloud egress");
    });

    expect(snapshot).toMatchObject({
      connectEnabled: false,
      connectCatalogEnabled: false,
      cloudMcpPresent: false,
      cloudHealth: null,
      workspace: { resolution: "resolved", id: "ws_test", directory: dir },
    });
    expect(automations).toBeNull();
    expect(engineProbes).toBe(0);
    expect(cloudRequests).toBe(0);
  });
});
