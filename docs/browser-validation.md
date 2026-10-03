# Automated browser validation

The CI validates the built Mini App in real Chromium against an isolated local mock API, then validates the HTML preview against the real Bridge request handler with a test authorization callback. Neither check authenticates to Telegram, sends provider credentials, runs a model or contacts the production Bridge.

## Run locally

Use Node.js 22 or newer and an installed Chromium/Chrome executable. Build first:

```sh
npm run build
CHROME_BINARY=/absolute/path/to/chrome npm run test:browser
CHROME_BINARY=/absolute/path/to/chrome npm run test:preview
```

Both scripts also accept the executable path as their first argument. This supports Windows Node/browser execution from WSL without hardcoded usernames or versioned application paths:

```text
node deploy/verify-mini-app-browser.mjs "C:\path\to\chrome.exe"
node deploy/verify-html-preview.mjs "C:\path\to\chrome.exe"
```

A missing browser or unsupported Node runtime fails explicitly. The CI does not silently skip browser verification. Browser profiles and API servers are disposable; no deployment environment file is loaded.

## Evidence and coverage

`test-results/browser/evidence.json` records successful checks. Screenshots record mobile/desktop geometry and the reduced chat viewport. Failures produce `failure.json` and, when the page is available, a failure screenshot. Outputs are ignored by Git and Docker; CI retains them as a private workflow artifact for seven days. They contain isolated fixtures, not production data.

Coverage includes fixed navigation after scrolling, long-conversation scrolling/composer visibility, modal focus and background-pointer isolation, provider input reset, 403 routing, one-time key acknowledgement, a five-minute step-up boundary, confirmed lock, P-256 recovery without Telegram initialization, and removal of protected content after mock HTTP 401. Step-up timestamps use the actual API's epoch-second convention; expiration is exercised by advancing only the browser/mock clocks, not the host clock.

The separate HTML check loads the real preview route and asserts an opaque iframe origin, blocked scripts and zero forbidden resource requests.

These are browser integration/security-boundary checks, not full Telegram end-to-end certification. Physical keyboard behavior, OS suspension, real signed-session validation and production network/tunnel reconnection remain acceptance gates in `telegram-acceptance.md`.
