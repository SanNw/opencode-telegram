import assert from "node:assert/strict"
import test from "node:test"
import { createDeviceKey, createNonExtractableDeviceKey, signDeviceMessage } from "./device-auth.js"

test("generated device proof is a raw P-256 signature", async () => {
  const keys = await createDeviceKey()
  const message = "opencode-telegram:pair:test-code"
  const signature = await signDeviceMessage(keys.privateKey, message)
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    keys.publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )
  const bytes = Uint8Array.from(atob(signature.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))

  assert.equal(bytes.length, 64)
  assert.equal(await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    bytes,
    new TextEncoder().encode(message),
  ), true)
})

test("desktop fallback signs with a non-exportable WebCrypto key", async () => {
  const keys = await createNonExtractableDeviceKey()
  assert.equal(keys.privateKey.extractable, false)
  const signature = await signDeviceMessage(keys.privateKey, "desktop-device")
  assert.equal(typeof signature, "string")
  assert(signature.length > 40)
})
