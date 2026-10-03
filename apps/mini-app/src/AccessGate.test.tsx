import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AccessGate, type GateState } from "./AccessGate.js"

const onRetry = () => undefined
const onPair = () => undefined
const onClose = () => undefined

function renderGate(state: GateState): string {
  return renderToStaticMarkup(
    <AccessGate state={state} onRetry={onRetry} onPair={onPair} onClose={onClose}>
      <p>Private project name</p>
    </AccessGate>,
  )
}

test("private content is mounted only after authorization", () => {
  for (const kind of ["authenticating", "untrusted", "denied", "offline"] as const) {
    assert.doesNotMatch(renderGate({ kind }), /Private project name/)
  }
  assert.match(renderGate({ kind: "authorized" }), /Private project name/)
})

test("independent recovery remains available when Telegram context is absent or access is revoked", () => {
  for (const state of [{ kind: "denied", reason: "missing_context" }, { kind: "denied", reason: "invalid_session" }, { kind: "untrusted" }, { kind: "offline" }] as const) {
    const html = renderToStaticMarkup(<AccessGate state={state} onRetry={onRetry} onPair={onPair} onClose={onClose} onRecover={async () => undefined}><p>Private project</p></AccessGate>)
    assert.match(html, /Recover or unlock access/); assert.match(html, /type="password"/); assert.match(html, /name="recoveryKey"/); assert.doesNotMatch(html, /Private project/)
  }
})

test("confirmed lock and compromised outcomes are distinct from ordinary authentication failure", () => {
  for (const telegramCompromised of [false, true]) {
    const html = renderToStaticMarkup(<AccessGate state={{ kind: "locked", telegramCompromised }} onRetry={onRetry} onPair={onPair} onClose={onClose} onRecover={async () => undefined}><p>Private project</p></AccessGate>)
    assert.match(html, telegramCompromised ? /Telegram marked as compromised/ : /Remote access locked/)
    assert.match(html, /action succeeded/); assert.match(html, /Recover or unlock access/); assert.doesNotMatch(html, /signed session could not be validated|Private project/)
  }
  const denied = renderGate({ kind: "denied", reason: "invalid_session", status: 401 })
  assert.match(denied, /signed session could not be validated/); assert.doesNotMatch(denied, /action succeeded|Telegram marked as compromised/)
})
