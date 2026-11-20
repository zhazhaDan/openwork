# Wudong upstream v2 integration

This branch is based on `different-ai/openwork:dev` and keeps the complete
OpenCode v2 adapter dependency graph intact. Do not merge the old Wudong fork
wholesale into this branch: upstream removed the legacy `apps/opencode-router`
and `apps/orchestrator` sidecars, so Git interprets those changes as
modify/delete conflicts.

## Preserved compatibility

- Prefer workspace engine config at `.tron/tron.jsonc` or `.tron/tron.json`.
- Use only `.tron/tron.json(c)` for the workspace engine configuration.
- Use only `.tron/{skills,commands,plugins,agents}` for workspace behavior.
- Accept `WUDONG_BROWSER_PROVIDER`, with `OPENWORK_BROWSER_PROVIDER` fallback.

## Local Tron startup

Both the CLI and desktop embedded Server start the Tron executable supplied
by the existing launch configuration through the v2 adapter. The embedding
host passes `opencodeBin` and `opencodeCwd`; standalone launches use
`OPENWORK_OPENCODE_BIN` and `OPENWORK_MANAGED_OPENCODE_CWD`. These legacy
option names are preserved. There is no new engine-path option, PATH or
home-directory discovery, or required-version check. The reported version
comes from the engine health response.

The Server does not start an additional v1 child, resolve packaged OpenCode
sidecars, or download an engine. Missing launch configuration reports an
error. The CLI's managed-engine switch remains `OPENWORK_MANAGE_OPENCODE=1`;
an external engine URL remains an explicit attachment.

The generated engine config is `tron.json` in the Server's private Tron
config directory. The child receives `TRON_PASSWORD`, `TRON_DB`,
`TRON_CONFIG_DIR`, and `TRON_MODELS_URL`. Local history uses `TRON_DB` or
the normal XDG `tron/tron.db`; startup does not migrate OpenCode history.
Local chats always use the v2 route and cannot switch back to OpenCode.
Remote engine URLs remain explicit attachments.

Run the native startup regression with a locally installed executable:

```sh
OPENWORK_TEST_TRON=/absolute/path/to/tron pnpm --filter openwork-server exec bun --conditions=development test test/local-tron.test.ts
```

The test covers a custom executable path and working directory supplied by
the host, session creation and reads through the Server proxy, refusal to
switch to OpenCode, preservation of the old OpenCode database, and child
cleanup. It also exercises inference against a temporary local model endpoint, legacy HTTP session reads, streaming message/status translation, and engine shutdown. Full plugin and platform coverage remains separate.

## Remaining packaging work

The removed `apps/opencode-router` sidecar is not part of the Wudong target.
Do not restore it: that would reintroduce the old `/session`, `/prompt_async`,
and `/global/event` contracts and bypass the v2 adapter.

The old sidecar publishing script targets the retired server/router/
orchestrator bundle. Replace it with a server + engine packaging path; do not
publish binaries from the old layout as a v2-compatible release.


## Wudong HTTP compatibility and packaging

`src/tron-compat.ts` retains Wudong's session read model and legacy HTTP mounts.
`scripts/build-tron-client.ts` bundles the upstream UI native client with an
injected Server transport; the native proxy still applies authentication,
mutation policy and session ownership. Generated JavaScript is a build output.
Execution events additionally produce Wudong's legacy busy/idle/error events.

The Wudong host launches only Server with its existing configured engine path
and cwd, includes native plugins plus their portable Effect dependency, and
waits for native engine readiness before reporting healthy. Startup imports
the existing `.tron` provider/MCP configuration; declared provider credentials
use the host-supplied environment. Mobile connection registration uses the
workspace directory rather than obsolete direct engine credentials.

Wudong's `scripts/build-sidecars.sh` now builds this Server and its plugins;
`OPENWORK_SERVER_SOURCE` selects an integration checkout. Router is no longer
a required packaging resource. Current local validation is macOS arm64;
these changes have not been published as a full cross-platform release.
