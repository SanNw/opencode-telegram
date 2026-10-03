# Contributing

Read `PROJECT_SPEC.md`, the wireframe reference and the existing implementation before changing behavior. Preserve the established design and security boundaries. The specification contains planned capabilities as well as implemented ones; do not infer availability from it alone.

## Local validation

Use Node.js 22 and the checked-in npm lockfile:

```sh
npm ci
npm run check
npm test
npm run build
```

Use `.env.example` as a template, never commit a working `.env`. Keep tests isolated from real Telegram accounts, tunnels and production SQLite files. Prefer mocked OpenCode responses. Native SQLite dependencies must be installed for the operating system running Node; do not share Windows and Linux `node_modules`.

## Changes and review

- Make focused changes and add a regression check for nontrivial behavior.
- Validate desktop/mobile geometry for visual changes; distinguish browser fixtures from a real Telegram test.
- Never weaken approval, device authorization, path containment or HTML sandboxing to make a test pass.
- Back up SQLite before migration tests against an existing installation. New migrations must preserve existing data and state their rollback limits.
- Explain tests performed and outstanding gaps in the change description. Do not claim a live deployment from a successful build alone.
- Do not commit credentials, private files, screenshots with secrets, database backups or generated build output.

CI checks/builds but intentionally does not publish images, push changes or deploy to the user's computer. Licensing/distribution terms require the owner's decision; absence of a license is not permission to redistribute.
