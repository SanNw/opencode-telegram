# OpenCode Telegram

Secure, self-hosted Telegram control plane for an existing OpenCode installation.

This repository is a **single-owner private beta**. The executable application reads live projects, sessions, structured conversations, tasks, diffs and workspace files through the official OpenCode SDK, authenticates the Telegram owner, pairs a device with a P-256 key and opens short Bridge sessions without duplicating OpenCode state.

Sending a prompt uses a deterministic policy decision (`ASK`): the Bridge persists a short-lived proposal tied to the authenticated user and device, and calls OpenCode only after an explicit approval. Proposals and decisions are recorded in the audit log.

Creating a session follows the same two-step policy flow. The Bridge creates it only inside the server-configured OpenCode directory; the Mini App cannot supply an arbitrary filesystem path. Parent and child sessions are surfaced separately so subagent activity can be monitored from the Agents view.

Conversation text, session status and sanitized tool-call state stream through authenticated SSE. Stop requests and native OpenCode permissions require explicit human confirmation; permission metadata and tool input/output are not forwarded to the client.

The Bridge rehydrates sessions and their live status after reconnect, foreground resume and periodic probes. Revoking a trusted device invalidates its HTTP requests and terminates its already-open event stream before another event is delivered.

When Telegram is configured, the Bot notifies only the configured owner when a known busy session finishes, a session reports an error, or OpenCode requests permission. Set `TELEGRAM_MINI_APP_URL` to add an HTTPS Mini App button to those notifications. Notification failures are logged without stopping event synchronization.

The Bridge redacts configured credentials and high-confidence secret formats before conversation text reaches the Mini App. Raw text deltas are intentionally not forwarded because a credential split across multiple chunks cannot be redacted reliably; complete normalized message-part updates provide the live conversation instead.

The Mini App also includes a trusted-device view. An authenticated device can revoke another device; revocation invalidates all Bridge sessions belonging to that device and is recorded in the audit log. The current device cannot revoke itself from the Mini App, preventing accidental lockout.

Security Center adds a one-time independent Recovery Key, five-minute step-up, emergency lock and Telegram-compromised recovery. Save the key outside Telegram before using lock. Projects includes an opaque-ID Artifact Gallery and approved, path-scoped Git commit/fast-forward pull/upstream push. Settings exposes real Skills/MCP/plugins/provider catalogs and approved API-key provider management. Skills/plugins are read-only on the tested OpenCode configuration contract; MCP changes are explicitly runtime-only. See [release readiness](docs/release-readiness.md) and [security policy](SECURITY.md) for these boundaries.

## Requirements

### Usage history, Bridge cache and HTML preview

The Dashboard persists completed assistant-message usage in SQLite (migration 8), keyed by owner, configured workspace and message ID. A background collector synchronizes at startup and every 60 seconds, including available historical messages. Repeated collection updates existing records without double-counting. Today, the last 7 days and the last 30 days use UTC boundaries and the original message date. Daily totals and provider/model/agent/project breakdowns reflect OpenCode-reported values, not a billing statement. Failed or ongoing collection is explicitly displayed; messages deleted upstream before collection cannot be recovered.

Settings → Storage includes Bridge-owned upload bytes and expired reference counts. `POST /api/v1/storage/cache/actions` proposes cleanup; the existing owner/device-bound, expiring approval flow executes it. Only expired uploads and file/directory handles belonging to that owner are removed. Active uploads, conversations, audit records, workspace files, and OpenCode/plugin caches are preserved. SQLite may reuse freed pages without shrinking the database file. No client-provided filesystem path is accepted.

Workspace `.html` and `.htm` files can be viewed through their authenticated opaque attachment ID at `/api/v1/attachments/:id/preview`. An empty iframe sandbox and response CSP enforce an opaque origin, disable scripts/forms and block external resources. Inline CSS and embedded data images/fonts are supported. Original HTML delivery remains a download. This is a static preview, not an application runtime; linked assets and JavaScript-dependent pages will not render fully.

After building, verify the browser boundary using an installed Chromium executable:

```sh
CHROME_BINARY=/absolute/path/to/chrome node deploy/verify-html-preview.mjs
```

The CI also runs the Mini App browser suite with Node.js 22 and Chromium. Run it locally with `CHROME_BINARY=/absolute/path/to/chrome npm run test:browser` after building. See [browser validation](docs/browser-validation.md) for coverage, evidence and the distinction from physical Telegram acceptance.

## Runtime requirements

- Node.js 20 or newer
- OpenCode with its server bound to localhost/private networking

## Run the Phase 0 Bridge

Your OpenCode installation is in WSL2/Ubuntu. The recommended development setup is to run both OpenCode and the Bridge in that same distribution:

```bash
cd "/mnt/e/Projetos/Opencode telegram"
npm install
npm run build
opencode serve --hostname 127.0.0.1 --port 4096
npm start
```

Use two WSL terminals for the two long-running commands. Running the Bridge from Windows also works with WSL localhost forwarding in the currently verified environment, but co-location avoids depending on that forwarding behavior.

After the production build, the Bridge serves both the Mini App and its API from one origin:

```text
Mini App: http://127.0.0.1:8787/
API:      http://127.0.0.1:8787/api/v1/
```

The Cloudflare Named Tunnel must target `http://localhost:8787`. Do not point it at Vite's development port (`5173`): the production Mini App is served by the Bridge, and the authenticated event stream stays on the same origin.

The configured public hostname is `https://opencode.religiowiki.com`, backed by the named tunnel `f992345c-0f92-4c4d-bfe3-2ef9c6bed304`. Its published application service must remain `http://localhost:8787`, with `cloudflared` running inside the same WSL distribution as the Bridge.

Production services are defined in [`deploy/systemd/`](./deploy/systemd/). The installed units are `opencode-telegram-opencode.service` and `opencode-telegram-bridge.service`; both are enabled for automatic startup. The Telegram owner's private-chat menu button is configured as `Open OpenCode` and opens the public hostname above.

Then request:

```text
GET http://127.0.0.1:8787/api/v1/system/health
GET http://127.0.0.1:8787/api/v1/opencode/snapshot
GET http://127.0.0.1:8787/api/v1/opencode/events
GET http://127.0.0.1:8787/api/v1/opencode/catalog
GET http://127.0.0.1:8787/api/v1/opencode/agents
```

The conversation composer reads connected providers, models, model variants and registered agents from OpenCode. A prompt proposal can select an agent, a connected model and one of that model's enabled reasoning variants. The Bridge persists those choices with the pending action and validates them again against the live OpenCode catalog after approval, immediately before delivery.

The agent view reads the session's actual OpenCode todo list. Projects also expose a read-only workspace Git summary (branch and changed-file counts); absolute server paths are normalized before delivery. No Git mutation is performed by that view.

File parts returned by OpenCode are registered as short-lived opaque handles. The Mini App never sends filesystem paths back to the Bridge. Authenticated content is read with:

```text
GET http://127.0.0.1:8787/api/v1/attachments/att_<opaque-id>
```

The handle is bound to the authenticated Telegram owner and OpenCode session. The Bridge resolves the configured workspace with `realpath`, rejects traversal and escaping symlinks, blocks common credential-file names, verifies regular files and size limits, and detects previewable PNG, JPEG and WebP files by their signatures. SVG, HTML and unknown formats are never rendered as active same-origin content; supported downloads use restrictive response headers and `no-store` caching.

The Storage tab uses the same boundary with opaque directory handles:

```text
GET http://127.0.0.1:8787/api/v1/storage/root
GET http://127.0.0.1:8787/api/v1/storage/directories/dir_<opaque-id>?cursor=0&limit=50
```

Directory responses contain only opaque child IDs, safe names and bounded metadata. The client cannot provide a path. Listings are paginated, symlinks are omitted, common dependency/version-control directories are hidden, and files are opened through the authenticated attachment endpoint.

The conversation composer accepts up to four attachments through an authenticated, same-origin staging endpoint:

```text
POST http://127.0.0.1:8787/api/v1/uploads
X-File-Name: <percent-encoded filename>
Content-Type: application/octet-stream
```

The response contains an opaque `upl_<id>` handle, never a filesystem path. A prompt proposal may reference those handles in `uploadIds`; the Bridge checks ownership and expiry again only after explicit user approval, converts the blobs to official OpenCode SDK file parts, and deletes them after successful delivery. Uploads expire after 15 minutes, are signature/type and size checked, block common credential names, and are rate limited per authenticated owner.

Copy `.env.example` to `.env` when configuration differs; the Bridge loads this file automatically with Node's native environment-file support. Existing process environment variables keep precedence. If the OpenCode server uses `OPENCODE_SERVER_PASSWORD`, provide the same value to the Bridge.

`OPENCODE_DIRECTORY` is a server-side allowlisted location. In this WSL checkout it is `/mnt/e/Projetos/Opencode telegram`; it is never accepted from Mini App requests.

## Telegram authentication

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` together to enable authentication. On the first Bridge start, the terminal prints a single-use pairing code valid for 15 minutes. The Mini App stores its P-256 private key in Telegram SecureStorage and exchanges a signed challenge for a 15-minute `HttpOnly`, `Secure`, `SameSite=Strict` cookie.

Without both Telegram variables the Bridge refuses to start. For an isolated local development instance with no tunnel, explicitly set `ALLOW_INSECURE_LOCAL_DEV=true`; never use that setting with Cloudflare Tunnel or another reverse proxy.

## Security boundary

The Bridge intentionally refuses to bind outside loopback. Telegram `initData` validation, replay protection, Bridge sessions, trusted-device foundations, action policy and audit events are enforced. Internet access terminates at the configured Cloudflare Named Tunnel; the Bridge and OpenCode server remain bound to loopback.

## Commands

```bash
npm run check
npm test
npm run build
```

The product and security requirements remain normative in [`PROJECT_SPEC.md`](./PROJECT_SPEC.md); the canonical visual reference remains in [`wireframe/`](./wireframe/).

The current integration findings and remaining Phase 0 checks are tracked in [`docs/research/opencode-1.18.32.md`](./docs/research/opencode-1.18.32.md).


