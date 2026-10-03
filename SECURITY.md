# Security policy

This project is a single-owner remote interface to an OpenCode installation. It is not a multi-tenant service and has not received an independent security certification.

## Trust boundaries

- Keep Bridge and OpenCode on loopback. Only the authenticated Bridge should be routed through the HTTPS tunnel; never publish OpenCode directly.
- Telegram signed initialization, owner authorization and trusted-device proof protect access. Protect the local pairing code like a credential; service logs can contain it.
- Bridge action approval does not replace OpenCode's own tool permissions. A prompt can trigger subsequent tool use. Configure OpenCode permissions appropriate to the workspace.
- File references are owner-bound opaque IDs. The configured workspace is a server-side boundary, not a browser-selected path.
- HTML preview is deliberately static and sandboxed. Do not add script or same-origin privileges to the preview iframe.
- SQLite backups contain sensitive authentication state, metadata and potentially uploaded content. Encrypt and restrict access to them.
- Recovery Key setup reveals a 256-bit key once. Store it independently of Telegram and this host; only a salted scrypt verifier is persisted. Step-up grants five minutes of privilege bound to the current user, device and normal session, not an unrestricted bearer capability.
- Integration/provider and Git writes require step-up and explicit approval. Provider keys remain in a short-lived, single-use server memory buffer, never in the proposal database or approval summary. Remote integration endpoints are default-denied unless explicitly allowlisted.

## Reporting vulnerabilities

Do not publish tokens, pairing codes, signed Telegram data, cookies, database files or private project contents in an issue. Send a minimal reproduction privately to the maintainer through an already established channel. If GitHub private vulnerability reporting is enabled for the repository, use its Security tab. No monitored public security mailbox or response SLA is currently declared.

## Immediate containment

1. With a trusted device and saved Recovery Key, use Security → Lock remote access or Mark Telegram compromised. This revokes sessions and freezes pending actions before best-effort upstream abort/rejection. If the Mini App is unavailable, stop `opencode-telegram-bridge.service` (or Compose Bridge) locally; stop the tunnel if routes cannot be isolated safely.
2. Revoke the Telegram bot token in BotFather if exposed. Rotate OpenCode credentials if affected. Update protected local configuration before restarting.
3. Preserve restricted copies of relevant logs and database state for diagnosis. Do not upload them publicly.
4. From a trusted environment, revoke affected devices and inspect OpenCode changes and pending approvals before restoring remote access.

If no trusted device remains but the saved Recovery Key is available, use the independent recovery form. It proves possession of a fresh P-256 device key, revokes old devices and sessions, then restores access without trusting Telegram initialization. If the key is unavailable, keep remote access stopped and use local administrative recovery. Do not delete the database or bypass authentication automatically. Upstream abort failure must not be confused with failure to lock access; inspect audit evidence before resuming work.

## Release gates

Require passing tests, dependency review and absence of exposed secrets before distributing. CI's dependency audit is not a penetration test. Enable repository secret scanning and push protection where supported; they are repository settings, not enabled by this document. Document accepted findings rather than suppressing the audit globally.
