import assert from "node:assert/strict"
import test from "node:test"
import { attachmentUrl, ControlError, controlErrorMessage, controlRequest, secondsRemaining, proposeSessionDeletion, decideSessionDeletion, replyOpenCodePermission } from "./control-api.js"

test("sensitive proposals send same-origin cookies and 403 directs to Security", async (t) => {
  let stepUp = 0, unauthorized = 0
  t.mock.method(globalThis, "fetch", async (path: string, options: RequestInit) => {
    assert.equal(path, "/api/v1/opencode/vcs/actions")
    assert.equal(options.credentials, "include")
    assert.deepEqual(JSON.parse(String(options.body)), { operation: "push" })
    return new Response(JSON.stringify({ error: "secret=never-echo" }), { status: 403 })
  })
  await assert.rejects(controlRequest("/api/v1/opencode/vcs/actions", { onStepUp: () => { stepUp++ }, onUnauthorized: () => { unauthorized++ } }, { operation: "push" }), (failure: unknown) => {
    assert.ok(failure instanceof ControlError); assert.equal(failure.status, 403); assert.doesNotMatch(failure.message, /never-echo/); return true
  })
  assert.equal(stepUp, 1); assert.equal(unauthorized, 0)
})

test("central approve and deny decisions carry only the decision", async (t) => {
  const sent: unknown[] = []
  t.mock.method(globalThis, "fetch", async (_path: string, options: RequestInit) => { sent.push(JSON.parse(String(options.body))); return Response.json({ status: "resolved" }) })
  for (const decision of ["approve", "deny"]) await controlRequest("/api/v1/actions/opaque-id/decision", { onStepUp() {}, onUnauthorized() {} }, { decision })
  assert.deepEqual(sent, [{ decision: "approve" }, { decision: "deny" }])
})

test("session revocation and staged-file partial failures are distinct", async (t) => {
  let unauthorized = 0
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }))
  const context = { onStepUp() {}, onUnauthorized() { unauthorized++ } }
  await assert.rejects(controlRequest("/api/v1/security", context), ControlError)
  assert.equal(unauthorized, 1)
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "unsafe server error", stagingMayHaveChanged: true }), { status: 409 }))
  await assert.rejects(controlRequest("/api/v1/actions/id/decision", context, { decision: "approve" }), (failure: unknown) => {
    assert.ok(failure instanceof ControlError); assert.equal(failure.stagingMayHaveChanged, true); assert.match(controlErrorMessage(failure), /may remain staged/); assert.doesNotMatch(failure.message, /unsafe/); return true
  })
})

test("artifact links accept only opaque handles and expiry never shows negative time", () => {
  const id = `att_${"a".repeat(32)}`
  assert.equal(attachmentUrl(id), `/api/v1/attachments/${id}`)
  assert.equal(attachmentUrl(id, true), `/api/v1/attachments/${id}/preview`)
  for (const unsafe of ["../../etc/passwd", "/workspace/private.md", "att_short", "javascript:alert(1)"]) assert.equal(attachmentUrl(unsafe), undefined)
  assert.equal(secondsRemaining(1300, 1_000_000), 300)
  assert.equal(secondsRemaining(900, 1_000_000), 0)
  assert.equal(secondsRemaining(undefined), 0)
})

test("delete proposals/approvals and Allow once route 403 to Security", async (t) => {
  let stepUp = 0
  const requests: Array<{ path: string; body: unknown }> = []
  t.mock.method(globalThis, "fetch", async (path: string, options: RequestInit) => {
    requests.push({ path, body: JSON.parse(String(options.body)) }); return new Response("{}", { status: 403 })
  })
  const context = { onUnauthorized() { assert.fail("403 must not revoke ordinary auth") }, onStepUp() { stepUp++ } }
  await assert.rejects(proposeSessionDeletion("session/id", context), ControlError)
  await assert.rejects(decideSessionDeletion("action/id", "approve", context), ControlError)
  await assert.rejects(replyOpenCodePermission("permission/id", "once", context), ControlError)
  assert.equal(stepUp, 3)
  assert.deepEqual(requests, [
    { path: "/api/v1/sessions/session%2Fid/actions", body: { type: "session.delete" } },
    { path: "/api/v1/actions/action%2Fid/decision", body: { decision: "approve" } },
    { path: "/api/v1/permissions/permission%2Fid/reply", body: { reply: "once" } },
  ])
})
