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

## Deliberately separate work

The removed `apps/opencode-router` sidecar is not part of the Wudong target.
Do not restore it: that would reintroduce the old `/session`, `/prompt_async`,
and `/global/event` contracts and bypass the v2 adapter.

The old sidecar publishing script targets the retired server/router/
orchestrator bundle. Replace it with a server + engine packaging path; do not
publish binaries from the old layout as a v2-compatible release.
