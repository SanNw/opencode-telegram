# Release readiness and operations

## Scope and evidence

The current installation is a single-owner WSL/Linux deployment with an external OpenCode server and Cloudflare tunnel. The Linux image build, read-only runtime and isolated health smoke test have been executed successfully; this is not evidence of Windows/macOS container support or authenticated container operation. Real Telegram Android/Desktop reconnection, keyboard and device-recovery checks remain manual acceptance gates; HTTP health alone cannot validate an authenticated conversation.

## Container deployment (optional, Linux only)

The Dockerfile builds and tests both workspaces and runs as an unprivileged user. Compose uses **host networking** because the Bridge deliberately only binds loopback. It does not publish a host port or install OpenCode/cloudflared. Host networking reduces network isolation; use it only on a trusted single-owner Linux host. Docker Desktop/Windows/macOS are not validated targets for this configuration.

1. Install/configure OpenCode and cloudflared on the same Linux host. Keep OpenCode authenticated and on loopback.
2. Create `.env` from `.env.example`, then configure owner credentials, OpenCode URL/password and the absolute `OPENCODE_DIRECTORY` used by the external server. Never commit `.env`.
3. The workspace is mounted **at the same absolute path**, read-only. It must be readable by container UID 1000. Do not mount `/`, a home directory, Docker's socket or broad sensitive directories. Do not set the workspace to `/app` or a parent of it; `/app` is reserved for the image.
4. Run `docker compose config --quiet`, then `docker compose build`. Do not display the resolved configuration without `--quiet`: it contains secrets.
5. Before switching an existing deployment, back it up and stop the old Bridge to avoid port conflicts. Compose uses a separate named database volume; it does not automatically import the old database or devices.
6. Run `docker compose up -d`. Check `docker compose ps`, then test health and an authenticated Telegram session. Access startup logs locally only when retrieving a pairing code.

Read-only workspace mounting restricts Bridge filesystem access, not the separately running OpenCode's ability to edit files. The named `bridge-data` volume persists on ordinary `docker compose down`; do not use `down --volumes` unless explicitly destroying its stored state.

## Backup and restore

Use SQLite's online backup API or `sqlite3 DATABASE '.backup BACKUP'` with explicit validated paths, a unique destination and restrictive permissions. **Do not copy only the live `.sqlite` file** while WAL writes are active. Check `PRAGMA integrity_check` on the backup. Back up protected configuration separately; keep both out of Git and public storage.

For this checkout, `node deploy/backup-bridge.mjs` uses the configured database and reserves a unique timestamped destination under `data/backups`. It uses SQLite's online backup API, restricts the file to mode 0600 and checks integrity. An optional explicit destination argument must identify a private backup location; existing files are never overwritten. The script does not print configuration or credentials.

Restore only during planned downtime with the Bridge stopped. Preserve the current database and its WAL/SHM companions as one recovery set before replacing it. Check backup integrity and schema compatibility with the chosen application version; restore ownership/permissions before restart. Never merge WAL files from the old database into a restored backup. Do not blindly roll back code after a schema migration. Test restoration on a separate instance without a public tunnel before relying on the backup.

## Updates and uninstall

Before updating: record the application version, back up, run checks/tests/build, review migration notes and accepted dependency findings, then restart and test authentication, conversation streaming and attachments. Keep the prior build and pre-update backup for controlled recovery. A service health check does not prove model inference.

To uninstall: stop the Bridge and its dedicated tunnel route; disable only the service units created for this project. Preserve data/backups by default. Do not delete the user's OpenCode installation, workspaces, unrelated Cloudflare routes or credentials shared by other applications.

## Remaining-cycle capability boundaries

Recovery Key, five-minute step-up sessions and emergency locking are implemented in the Bridge. Keep the Recovery Key outside Telegram and outside this installation: setup reveals it once, and the database stores only a salted scrypt verifier. Recovery creates a new trusted device and revokes previous devices/sessions; it is not a bypass of device proof. Emergency lock first freezes access, then attempts to abort active OpenCode work and reject permissions. An upstream abort failure is audited and does not undo the lock.

The management catalog exposes normalized, redacted Skills, MCP servers, plugins and providers. Provider API-key connection/removal uses an elevated, approved action; the submitted key is held only in memory for five minutes and must be submitted again after restart or expiration. Skills/plugin configuration is explicitly read-only on the tested upstream contract. MCP changes are runtime-only, not a promise of restart persistence. Remote endpoint additions require an exact `MANAGEMENT_ALLOWED_HOSTS` entry and public HTTPS/DNS validation; the default empty allowlist disables them. These limitations must remain visible in the Mini App.

Artifact Gallery is restricted to authorized OpenCode message attachments with expiring opaque IDs. It does not expose arbitrary workspace paths or treat uploaded storage as generated artifacts. HTML preview uses the existing isolated sandbox.

Git commit, pull and push require elevation and approval. Commits select explicit changed paths and reject unrelated staged changes. Pull is fast-forward-only. Push targets one validated upstream branch and rejects mirror/custom push configurations. Approving these actions is a user decision, not permission for the application to push automatically.

Browser viewport and lifecycle checks are evidence for the web application only. Telegram Android/Desktop keyboard behavior, background suspension and real signed-session recovery still require the physical-client acceptance matrix; simulated resize or healthy HTTP responses are not substitutes.

## Distribution gates

- CI must pass on a clean Linux runner, including native dependency installation and image build.
- Run the built container on a disposable installation; verify loopback-only binding, persistent database ownership, health, pairing, streaming and file access before replacing production.
- Run a full actual-device Telegram matrix: network loss, background/resume, expired authentication, blocked keyboard viewport, revoked device and long response.
- Exercise restart/reboot and restore from backup. Record platform/version and results, not assumptions.
- Complete independent security review and document findings. Repository secret scanning/push protection must be enabled separately where available.
- Choose license and support policy with the project owner before public redistribution. No license was invented by this change.

The initial implementation report is historical, not a current feature matrix. Read runtime capabilities and current tests together with the normative specification; unavailable upstream capabilities should remain explicitly unavailable.
