import assert from "node:assert/strict"
import test from "node:test"
import { redactText } from "./redact.js"

test("redacts configured and high-confidence credential patterns", () => {
  const telegram = `${"1".repeat(9)}:${"A".repeat(35)}`
  const value = redactText(
    `password=correct-horse-battery and bot=${telegram} auth=Bearer abcdefghijklmnopqrstuvwxyz`,
    ["correct-horse-battery"],
  )
  assert.equal(value.includes("correct-horse-battery"), false)
  assert.equal(value.includes(telegram), false)
  assert.equal(value.includes("abcdefghijklmnopqrstuvwxyz"), false)
  assert.match(value, /\[REDACTED\]/)
})

test("does not redact ordinary prose", () => {
  assert.equal(redactText("Build completed in 42 seconds."), "Build completed in 42 seconds.")
})
