import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import test from "node:test"
import { TelegramAuthError } from "./telegram.js"
import { normalizeDeviceLabel, normalizeDevicePublicKey, verifyDeviceSignature } from "./device.js"

test("accepts only a named P-256 public key and a bounded label", () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const jwk = publicKey.export({ format: "jwk" })
  assert.deepEqual(JSON.parse(normalizeDevicePublicKey(jwk)), jwk)
  assert.equal(normalizeDeviceLabel("  Android phone  "), "Android phone")
  assert.throws(() => normalizeDevicePublicKey({ kty: "oct", k: "secret" }), TelegramAuthError)
  assert.throws(() => normalizeDeviceLabel(""), TelegramAuthError)
})

test("verifies P-256 proof of possession", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const message = "opencode-telegram:challenge:id:nonce"
  const signature = sign("sha256", Buffer.from(message), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")
  const publicKeyJwk = JSON.stringify(publicKey.export({ format: "jwk" }))
  assert.doesNotThrow(() => verifyDeviceSignature(publicKeyJwk, message, signature))
  assert.throws(() => verifyDeviceSignature(publicKeyJwk, `${message}!`, signature), TelegramAuthError)
})

