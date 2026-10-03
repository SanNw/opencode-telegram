import assert from "node:assert/strict"
import test from "node:test"
import { TelegramAuthError, validateTelegramInitData } from "./telegram.js"

// Fixed synthetic HMAC vector: no external bot credential or personal data.
const BOT_TOKEN = "synthetic-test-bot-not-a-real-token"
const VALID = "query_id=fixture-query&user=%7B%22id%22%3A42%2C%22first_name%22%3A%22Test%22%2C%22username%22%3A%22fixture%22%7D&auth_date=1662771648&hash=f5a7c8cece32d7049cc07102a0ec838f4f0fc36f04cc4362c2e7b79e22a1041d"

const options = {
  botToken: BOT_TOKEN,
  ownerId: "42",
  nowSeconds: 1_662_771_649,
  maxAgeSeconds: 300,
}

test("validates a fixed synthetic Mini App HMAC vector", () => {
  assert.deepEqual(validateTelegramInitData(VALID, options), {
    userId: "42",
    authDate: 1_662_771_648,
    queryId: "fixture-query",
    replayKey: "f5a7c8cece32d7049cc07102a0ec838f4f0fc36f04cc4362c2e7b79e22a1041d",
  })
})

test("rejects tampering, expiration, duplicates and users outside the allowlist", () => {
  const invalid = [
    VALID.replace("Test", "Attacker"),
    VALID.replace("auth_date=1662771648", "auth_date=1662771648&auth_date=1662771648"),
    VALID.replace("query_id=", "query_id=%G0"),
    `${VALID}&missing-equals`,
  ]
  for (const raw of invalid) {
    assert.throws(() => validateTelegramInitData(raw, options), TelegramAuthError)
  }
  assert.throws(
    () => validateTelegramInitData(VALID, { ...options, nowSeconds: 1_662_772_000 }),
    TelegramAuthError,
  )
  assert.throws(
    () => validateTelegramInitData(VALID, { ...options, ownerId: "1" }),
    TelegramAuthError,
  )
})

