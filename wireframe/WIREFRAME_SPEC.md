# OpenCode Telegram — Canonical Wireframe Specification

## Status

This directory is the **canonical visual reference** for the OpenCode Telegram product.

The production implementation may improve accessibility, performance and platform integration, but it must **not redesign or reinterpret the established visual identity** without an explicit product decision.

## Non-negotiable visual rules

Preserve the visual language demonstrated by `index.html`:

- light, clean, high-information interface;
- Figma + Codex + Linear direction;
- neutral background and panels;
- restrained accent usage;
- subtle borders instead of heavy shadows;
- approximately 12–16 px radii for primary surfaces;
- compact tool-call rows;
- dense but readable information hierarchy;
- mobile-first layout;
- compact status pills;
- consistent typography and spacing rhythm;
- persistent conceptual hierarchy: Dashboard → Project → Session → Conversation;
- Session Drawer as the conversation-history surface;
- bottom navigation on mobile;
- sidebar navigation on larger screens.

Do not turn the product into a colorful generic SaaS dashboard, a terminal-first interface, a dark cyberpunk UI, or a clone of VS Code.

## Canonical File Viewer behavior

The wireframe includes the product's Universal File Viewer.

Files and Artifacts are different concepts:

- **Files** = complete technical project workspace.
- **Artifacts** = curated useful outputs.

Conversation tool calls that create or edit files must expose `View file` and, when relevant, `View diff`.

### Markdown

Use `Preview / Raw / Diff`.

Preview is optimized for reading on phones. Raw is source text. Diff defaults to unified vertical layout on mobile.

### Source code

Use syntax highlighting, line numbers, search and jump-to-line in production. On narrow screens, code may scroll horizontally rather than being force-wrapped.

### HTML

Use `Preview / Source / Diff`.

The Preview is security-sensitive. Never inject generated/project HTML into the authenticated Mini App DOM. Render it in an isolated sandbox/origin with restrictive capabilities and no access to Bridge, Telegram or OpenCode credentials.

The HTML viewer supports Mobile / Tablet / Desktop viewport presets and fullscreen preview.

### Large files

Do not load arbitrarily large files into the browser. Use bounded reads, chunks, pagination or virtualization.

## Mobile behavior

The mobile UI is not a shrunken desktop IDE.

Prefer:

- one-column reading surfaces;
- unified vertical diffs;
- large touch targets;
- fullscreen preview;
- horizontally scrollable source code;
- preserved scroll position when moving Conversation ↔ File;
- minimal persistent chrome while reading.

## Implementation instruction for Codex/OpenCode

Treat `wireframe/index.html` as a normative visual implementation reference and `PROJECT_SPEC.md` as the normative product/architecture reference.

**DO NOT redesign the interface.**

**DO NOT reinterpret the visual identity.**

Functional adaptations are allowed when required by the production framework, accessibility, Telegram Mini App constraints or actual OpenCode API behavior. When adapting functionality, preserve the established visual hierarchy and component language.

Before implementing a new screen, first determine whether an existing canonical component/pattern in this wireframe can be reused.
