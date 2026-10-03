# Initial private publication

This repository is a single-owner private beta, not a certified stable or multi-tenant release. No redistribution license has been selected; private publication does not grant a public distribution license.

The initial publication includes source, tests, reproducible dependency lockfile, CI, container/service templates and the normative wireframe. Local environment files, databases/backups/uploads, chat attachments, internal agent reports and generated Graphify caches are excluded. Keep operational credentials outside Git.

Validated capabilities include independent recovery, device-bound step-up, emergency lock, opaque artifacts and explicitly approved integration/Git actions. Skills/plugins remain read-only on the verified upstream contract, and MCP changes are runtime-only. Physical Telegram Android/Desktop acceptance remains pending: see `telegram-acceptance.md`. Passing CI does not replace those checks or certify the security of the installation.

GitHub publication does not deploy this self-hosted application. The CI workflow validates and builds a container without publishing an image or changing the production installation.

The secret-pattern review retains one intentional synthetic `sk-` fixture in `management.test.ts`: it is an alphabet-and-digits sequence used to verify URL credential rejection, not a provider credential. Telegram authentication tests use a fixed synthetic HMAC vector with no external bot token or personal data. Configured deployment credentials are compared against every staged file before publication, without printing them.
