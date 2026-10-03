# OpenCode integration spike — 1.18.32

Date: 2026-09-27

## Environment verified

- OpenCode 1.18.32 in WSL2/Ubuntu.
- `@opencode-ai/sdk` 1.18.32 using `@opencode-ai/sdk/v2/client`.
- OpenCode bound to `127.0.0.1:4096` with HTTP Basic authentication.
- Bridge running on Windows reached the WSL server through localhost forwarding.

## Confirmed

- `global.health()` returns healthy status and server version.
- `project.list()` returns live OpenCode projects.
- `session.list()` returns live parent and child sessions.
- The Bridge returns `503` and a generic message when OpenCode is unavailable.
- OpenCode credentials stay server-side and are not included in the Bridge response.
- The Bridge snapshot normalizes only fields currently needed by a client; it does not persist OpenCode state.
- `session.create()` creates a session in the server-configured directory and returns the normalized session record.
- Conversation loading, asynchronous prompts, aborts, permission replies and sanitized event streaming are covered by Bridge integration tests.
- Session statuses, todos, diffs, provider/model catalogs, agents, Skills, MCP status and plugin names are read from the installed SDK/API.
- Telegram Mini App authentication, trusted-device proof, revocation and owner-bound action approvals are implemented and covered by automated tests.
- Workspace files use owner-bound opaque handles; uploads, image previews, downloads and sandboxed static HTML previews are implemented.

## Not yet confirmed

- Whether an independently started `opencode serve` receives real-time events from a simultaneously running TUI process.
- SSE event names, reconnect behavior and resynchronization against this installed version.
- Stable addressing of non-global projects and directory/location scoping.
- Actual-device Telegram background/reconnect behavior across Android/Desktop versions.
- Full configuration surfaces for Skills, MCP servers, plugins and providers; current exposure is limited to upstream metadata/status.
- Git/VCS, artifact gallery, recovery key, emergency lock and step-up authentication.

This file records the original integration spike plus the current verified boundary. Public routes must remain behind Telegram owner authentication and trusted-device sessions; broader distribution still depends on the release gates in `docs/release-readiness.md`.
