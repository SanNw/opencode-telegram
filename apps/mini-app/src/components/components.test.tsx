import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CapabilityGate, ChangeSummary, ChatMessageView, DiffViewer, Icon, MAX_DIFF_LINES, MAX_MARKDOWN_CHARACTERS, MarkdownRenderer, countDiffLines, type ChatMessage } from "./index.js"

test("navigation icons share one SVG coordinate and stroke system", () => {
  for (const name of ["home", "projects", "agents", "settings"] as const) {
    const html = renderToStaticMarkup(<Icon name={name} />)
    assert.match(html, /viewBox="0 0 24 24"/)
    assert.match(html, /stroke-width="1.8"/)
    assert.match(html, /stroke-linecap="round"/)
    assert.match(html, /stroke-linejoin="round"/)
    assert.match(html, /focusable="false"/)
  }
})

test("MarkdownRenderer supports GFM and does not render arbitrary HTML or unsafe links", () => {
  const html = renderToStaticMarkup(<MarkdownRenderer content={'**Bold**\n\n- item\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))'} />)
  assert.match(html, /<strong>Bold<\/strong>/)
  assert.match(html, /<table>/)
  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(html, /javascript:/)
  assert.doesNotMatch(renderToStaticMarkup(<MarkdownRenderer content="[x](//evil.example/x)" />), /href=/)
  assert.match(renderToStaticMarkup(<MarkdownRenderer content={"x".repeat(MAX_MARKDOWN_CHARACTERS + 1)} />), /Message truncated/)
})

test("DiffViewer parses hunks and counts only changed content", () => {
  const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -4,2 +4,2 @@\n-old\n+new\n same"
  assert.deepEqual(countDiffLines(diff), { additions: 1, deletions: 1 })
  const collapsed = renderToStaticMarkup(<DiffViewer file="src/file.ts" diff={diff} status="modified" />)
  assert.match(collapsed, /aria-expanded="false"/)
  assert.doesNotMatch(collapsed, /diff-line--addition/)
  const html = renderToStaticMarkup(<DiffViewer file="src/file.ts" diff={diff} status="modified" defaultOpen />)
  assert.match(html, /src\/file.ts/)
  assert.match(html, /\+1/)
  assert.match(html, /diff-line--addition/)
  assert.match(renderToStaticMarkup(<DiffViewer file="huge" diff={Array(MAX_DIFF_LINES + 2).fill(" same").join("\n")} defaultOpen />), /Diff truncated/)
})

test("ChangeSummary derives real totals and exposes selectable files", () => {
  const html = renderToStaticMarkup(<ChangeSummary changes={[{ file: "src/new.ts", status: "created", diff: "@@ -0,0 +1,2 @@\n+one\n+two" }]} onSelect={() => undefined} />)
  assert.match(html, /1 file changed/)
  assert.match(html, /\+2/)
  assert.match(html, /Created/)
  assert.match(html, /<button/)
})

test("CapabilityGate distinguishes loading, unsupported and available states", () => {
  assert.match(renderToStaticMarkup(<CapabilityGate capability={{ status: "loading" }}><b>Private</b></CapabilityGate>), /Loading/)
  assert.doesNotMatch(renderToStaticMarkup(<CapabilityGate capability={{ status: "unsupported", reason: "No diff endpoint" }}><b>Private</b></CapabilityGate>), /Private/)
  assert.match(renderToStaticMarkup(<CapabilityGate capability={{ status: "available" }}><b>Ready</b></CapabilityGate>), /Ready/)
})

test("ChatMessageView keeps structured parts, timestamp and delivery state", () => {
  const message: ChatMessage = { id: "m1", role: "user", createdAt: "2026-09-28T12:34:00Z", status: "sending", parts: [{ type: "markdown", content: "Hello **OpenCode**" }, { type: "file", fileId: "file_12345678", path: "src/App.tsx", name: "App.tsx" }] }
  const html = renderToStaticMarkup(<ChatMessageView message={message} locale="en-GB" />)
  assert.match(html, /chat-message--user/)
  assert.match(html, /chat-message--sending/)
  assert.match(html, /<strong>OpenCode<\/strong>/)
  assert.match(html, /Sending/)
})

test("ChatMessageView withholds empty lifecycle messages until visible content arrives", () => {
  const started: ChatMessage = { id: "m-empty", role: "assistant", createdAt: "2026-09-28T12:34:00Z", status: "streaming", parts: [] }
  const blank: ChatMessage = { ...started, id: "m-blank", role: "user", parts: [{ type: "markdown", content: "   \n" }] }
  assert.equal(renderToStaticMarkup(<ChatMessageView message={started} />), "")
  assert.equal(renderToStaticMarkup(<ChatMessageView message={blank} />), "")
})

test("attachments use only opaque same-origin identifiers", () => {
  const attachmentId = `att_${"a".repeat(32)}`
  const safe: ChatMessage = { id: "m2", role: "assistant", createdAt: 0, parts: [{ type: "image", attachmentId, alt: "Result" }] }
  const unsafe: ChatMessage = { id: "m3", role: "assistant", createdAt: 0, parts: [{ type: "image", attachmentId: "https://evil.example/x", alt: "Result" }] }
  assert.match(renderToStaticMarkup(<ChatMessageView message={safe} />), new RegExp(`src="/api/v1/attachments/${attachmentId}"`))
  assert.doesNotMatch(renderToStaticMarkup(<ChatMessageView message={unsafe} />), /evil\.example/)
})
