import assert from "node:assert/strict"
import test from "node:test"
import { recoverDevice, recoveryRequest } from "./recovery-auth.js"

test("independent recovery creates fresh device proof and stores only revocable device credentials", async () => {
  const events: string[] = [], privateKey: JsonWebKey = { kty: "EC", d: "test-private-key" }, publicKey: JsonWebKey = { kty: "EC", x: "test-public" }
  await recoverDevice("rk_independent", "Recovery device", {
    prepareStorage: async () => { events.push("storage"); return undefined },
    createKey: async () => { events.push("new-key"); return { privateKey, publicKey } },
    sign: async (key, message) => { assert.equal(key, privateKey); assert.equal(message, "opencode-telegram:recover:rk_independent"); events.push("proof"); return "signed-proof" },
    request: (async (path, options) => {
      events.push("request"); assert.equal(path, "/api/v1/security/recovery/unlock"); assert.equal(options?.credentials, "include")
      assert.deepEqual(JSON.parse(String(options?.body)), { recoveryKey: "rk_independent", publicKey, label: "Recovery device", proof: "signed-proof" })
      assert.doesNotMatch(String(options?.body), /initData|test-private-key/)
      return Response.json({ status: "authorized", deviceId: "new-device" })
    }) as typeof fetch,
    store: async (credential) => { events.push("store"); assert.deepEqual(credential, { deviceId: "new-device", privateKey }); assert.doesNotMatch(JSON.stringify(credential), /rk_independent/) },
  })
  assert.deepEqual(events, ["storage", "new-key", "proof", "request", "store"])
})

test("failed recovery never persists the new device or raw server error", async () => {
  let stored = false
  await assert.rejects(recoverDevice("rk_wrong", "Recovery device", {
    prepareStorage: async () => undefined,
    createKey: async () => ({ publicKey: {}, privateKey: {} }),
    sign: async () => "proof",
    request: (async () => new Response("rk_wrong debug secret", { status: 401 })) as typeof fetch,
    store: async () => { stored = true },
  }), /Recovery could not be verified/)
  assert.equal(stored, false)
})

test("recovery transport never invokes native fetch with the dependency object as receiver", async (t) => {
  const holder = { request: recoveryRequest }
  t.mock.method(globalThis, "fetch", function (this: unknown, path: string) {
    assert.notEqual(this, holder, "browser fetch rejects an arbitrary object receiver")
    assert.equal(path, "/api/v1/security/recovery/unlock")
    return Promise.resolve(Response.json({ status: "authorized" }))
  })
  const response = await holder.request("/api/v1/security/recovery/unlock")
  assert.equal(response.status, 200)
})
