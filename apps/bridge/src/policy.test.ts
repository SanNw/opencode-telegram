import assert from "node:assert/strict"
import test from "node:test"
import { decide } from "./policy.js"

test("policy allows reads, asks before prompts and denies unknown actions", () => {
  assert.equal(decide("session.read"), "ALLOW")
  assert.equal(decide("session.create"), "ASK")
  assert.equal(decide("session.prompt"), "ASK")
  assert.equal(decide("session.abort"), "ASK")
  assert.equal(decide("opencode.permission"), "ASK")
  assert.equal(decide("session.delete"), "ASK")
})
