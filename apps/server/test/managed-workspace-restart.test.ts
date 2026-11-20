import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveServerConfig } from '../src/config.js';

test('managed engine bootstrap preserves registered workspace identities and explicit attachment keeps replacement semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tron-workspace-registry-'));
  try {
    const configPath = join(root, 'server.json');
    const primary = join(root,'primary');
    const second = join(root,'second');
    await writeFile(configPath, JSON.stringify({ workspaces:[
      {id:'ws_existing_primary',path:primary,name:'Default task'},
      {id:'ws_existing_secondary',path:second,name:'Second project',displayName:'My project',preset:'starter'},
    ] }));
    const managed = await resolveServerConfig({configPath,workspaces:[primary]}, {preserveRegisteredWorkspaces:true});
    assert.deepEqual(managed.workspaces.map(workspace => [workspace.id,workspace.path,workspace.name]), [
      ['ws_existing_primary',primary,'Default task'], ['ws_existing_secondary',second,'Second project'],
    ]);
    assert.equal(managed.workspaces[1].displayName,'My project');
    const attached = await resolveServerConfig({configPath,workspaces:[primary]});
    assert.equal(attached.workspaces.length,1);
    assert.equal(attached.workspaces[0].path,primary);
  } finally { await rm(root,{recursive:true,force:true}); }
});
