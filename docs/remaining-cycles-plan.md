# Remaining cycles implementation plan

Authority: `PROJECT_SPEC.md`, especially sections 15, 19-21, 25-26 and 40-49.

## Task 1 — Independent security boundary

- Add a one-time Recovery Key setup flow backed only by a memory-hard verifier.
- Add five-minute privileged sessions bound to the authenticated device.
- Add Emergency Lock and Telegram-compromised modes that revoke sessions, freeze actions, and require the Recovery Key to unlock.
- Require step-up for device revocation, integration/provider changes, Git writes, and security changes.
- Add deterministic throttling and structured audit records.

## Task 2 — OpenCode configuration management

- Read Skills, MCP, plugins, providers and configuration from the official OpenCode SDK.
- Expose narrowly validated mutations through the official SDK only.
- Keep credentials server-side and require step-up plus human approval for sensitive writes.

## Task 3 — Artifact Gallery and Git writes

- Maintain explicit lightweight artifact metadata for OpenCode-produced file parts; never classify every workspace file as an artifact.
- List, preview and download artifacts through opaque attachment IDs.
- Add commit, pull and push actions with fixed Git argv, workspace scoping, step-up and human approval.

## Task 4 — Mini App surfaces

- Add Security Center recovery, elevation, lock and compromised-account controls.
- Add real integration management and provider connection surfaces.
- Add Artifact Gallery and Git action controls without changing the established visual identity.

## Task 5 — Verification and release

- Unit and integration tests for security invariants and all new endpoints.
- Browser coverage for mobile viewport, virtual-keyboard resize, background/resume, session expiry/revocation and long responses.
- Check, tests, production build, dependency audit, service restart and public smoke checks.
- Update release documentation and the code graph.
