import assert from "node:assert/strict"
import test from "node:test"
import { stateAfterUnauthorized, stateForTelegramAuthStatus } from "./auth-status.js"

test("HTTP 202 continues into device verification instead of authorizing", () => {
  assert.equal(stateForTelegramAuthStatus(202), undefined)
  assert.deepEqual(stateForTelegramAuthStatus(200), { kind: "authorized" })
  assert.deepEqual(stateForTelegramAuthStatus(401), {
    kind: "denied",
    reason: "invalid_session",
    status: 401,
  })
})

test("late unauthorized requests preserve only a confirmed lock outcome", () => {
  for (const telegramCompromised of [false, true]) assert.deepEqual(stateAfterUnauthorized({ kind: "locked", telegramCompromised }), { kind: "locked", telegramCompromised })
  assert.deepEqual(stateAfterUnauthorized({ kind: "authorized" }), { kind: "denied", reason: "invalid_session" })
  assert.deepEqual(stateForTelegramAuthStatus(401), { kind: "denied", reason: "invalid_session", status: 401 })
})
