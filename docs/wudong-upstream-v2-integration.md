# Wudong upstream v2 integration

This branch is based on `different-ai/openwork:dev` and keeps the complete
OpenCode v2 adapter dependency graph intact. Do not merge the old Wudong fork
wholesale into this branch: upstream removed the legacy `apps/opencode-router`
and `apps/orchestrator` sidecars, so Git interprets those changes as
modify/delete conflicts.

## Preserved compatibility

- Prefer workspace engine config at `.tron/tron.jsonc` or `.tron/tron.json`.
- Accept top-level `tron.jsonc` and `tron.json` for existing workspaces.
- Use `.tron/{skills,commands,plugins,agents}` when `.tron` exists.
- Keep `.opencode` paths as an upstream-compatible fallback.
- Accept `WUDONG_BROWSER_PROVIDER`, with `OPENWORK_BROWSER_PROVIDER` fallback.

## Deliberately separate work

The Wudong Feishu and WeCom implementation lived in the removed
`apps/opencode-router` sidecar. Port it as a separate channel service against
the current `@openwork/headless-threads` API. Restoring the deleted directory
would reintroduce the old `/session`, `/prompt_async`, and `/global/event`
contracts and bypass the v2 adapter.

The Wudong sidecar publishing script also targets the retired server/router/
orchestrator bundle. Rework it after the channel service target is defined;
do not publish binaries from the old layout as a v2-compatible release.
