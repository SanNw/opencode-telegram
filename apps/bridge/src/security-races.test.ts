import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { createServer, request as httpRequest } from "node:http"
import test from "node:test"
import { createRequestHandler, type RequestHandlerOptions } from "./app.js"
import { SecurityBoundary, SecurityError } from "./security.js"
import { BridgeStore } from "./storage/database.js"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
function actorFixture() {
  const store = new BridgeStore(":memory:")
  let now = Math.floor(Date.now() / 1000)
  const started = now, token = "A".repeat(43)
  store.ensureAuthorizedUser("owner")
  const pair = (code: string, sessionToken: string) => {
    store.replacePairingCode(code, now + 900)
    return store.pairDevice("owner", code, now + 900, code, "{}", code, hash(sessionToken), now + 900, now)!
  }
  const deviceId = pair("first", token), other = pair("second", "B".repeat(43))
  const actor = { userId: "owner", deviceId }, security = new SecurityBoundary(store, "owner", () => now)
  return { store, actor, other, token, security, started, clock: (value: number) => { now = value },
    authorize: (value: string | undefined) => value ? store.sessionIdentity(hash(value), now) ?? false : false }
}

const races = [
  ["/sessions/actions", '{"type":"session.create"}'],
  ["/sessions/s/actions", '{"type":"session.prompt","text":"hello"}'],
  ["/sessions/s/actions", '{"type":"session.abort"}'],
  ["/sessions/s/actions", '{"type":"session.delete"}'],
  ["/storage/cache/actions", '{"type":"cache.cleanup"}'],
  ["/actions/a/decision", '{"decision":"approve"}'],
  ["/permissions/p/reply", '{"reply":"once"}'],
  ["/permissions/p/reply", '{"reply":"reject"}'],
  ["/uploads", "binary-content"],
  ["/security/step-up", '{"recoveryKey":"invalid"}'],
] as const

for (const [path, body] of races) test(`partial HTTP request cannot mutate ${path} after device revocation (${body.slice(0, 25)})`, async () => {
  const f = actorFixture()
  let callbacks = 0, started!: () => void
  const authorized = new Promise<void>((resolve) => { started = resolve })
  const options: RequestHandlerOptions = {
    loadSnapshot: async () => { throw new Error("unused") }, security: f.security,
    authorizeSession: (token) => { const actor = f.authorize(token); started(); return actor },
    requirePrivilege: () => { callbacks++ },
    proposeAction: () => { callbacks++; return { actionId: "a", decision: "ASK" } },
    decideAction: async () => { callbacks++; return { status: "executed" } },
    respondPermission: async () => { callbacks++ }, createUpload: () => { callbacks++ },
  }
  const server = createServer(createRequestHandler(options))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert(address && typeof address === "object")
  let client: ReturnType<typeof httpRequest> | undefined
  try {
    const result = new Promise<number>((resolve, reject) => {
      client = httpRequest(`http://127.0.0.1:${address.port}/api/v1${path}`, {
        method: "POST", headers: { cookie: `bridge_session=${f.token}`, "content-type": path === "/uploads" ? "application/octet-stream" : "application/json", "x-file-name": "a.txt" },
      }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode!)) })
      client.on("error", reject); client.setTimeout(3000, () => client?.destroy(new Error("race timeout")))
      client.write(body.slice(0, -1))
    })
    await authorized
    assert.equal(f.store.revokeTrustedDevice("owner", f.actor.deviceId, f.other), true)
    client!.end(body.slice(-1))
    assert.equal(await result, 401)
    assert.equal(callbacks, 0)
    assert.throws(() => f.store.createPendingSession("owner", f.actor.deviceId), /Device unavailable/)
  } finally { client?.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); f.store.close() }
})

for (const cause of ["expiry", "recovery"] as const) test(`partial permission rejection revalidates normal session after ${cause}`, async () => {
  const f = actorFixture()
  let started!: () => void, callbacks = 0
  const ready = new Promise<void>((resolve) => { started = resolve })
  const recoveryKey = cause === "recovery" ? (await f.security.setupRecovery(f.actor, f.token)).recoveryKey : undefined
  const server = createServer(createRequestHandler({ loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: (token) => { const actor = f.authorize(token); started(); return actor },
    respondPermission: async () => { callbacks++ }, security: f.security,
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert(address && typeof address === "object")
  let client!: ReturnType<typeof httpRequest>
  try {
    const result = new Promise<number>((resolve, reject) => {
      client = httpRequest(`http://127.0.0.1:${address.port}/api/v1/permissions/p/reply`, {
        method: "POST", headers: { cookie: `bridge_session=${f.token}`, "content-type": "application/json" },
      }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode!)) })
      client.on("error", reject); client.setTimeout(3000, () => client.destroy(new Error("timeout"))); client.write('{"reply":"reject"')
    })
    await ready
    if (cause === "expiry") f.clock(f.started + 901)
    else {
      const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      await f.security.recover({ recoveryKey: recoveryKey!, publicKey: key.publicKey.export({ format: "jwk" }), label: "Recovered",
        proof: sign("sha256", Buffer.from(`opencode-telegram:recover:${recoveryKey}`), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") })
    }
    client.end("}")
    assert.equal(await result, 401); assert.equal(callbacks, 0)
  } finally { client?.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); f.store.close() }
})

test("all positive permissions require current step-up while reject remains available normally", async () => {
  const f = actorFixture()
  let replies = 0
  const { recoveryKey } = await f.security.setupRecovery(f.actor, f.token)
  const elevated = await f.security.elevate(f.actor, f.token, recoveryKey)
  const server = createServer(createRequestHandler({ loadSnapshot: async () => { throw new Error("unused") },
    security: f.security, authorizeSession: f.authorize, requirePrivilege: f.security.requirePrivilege.bind(f.security),
    respondPermission: async ({ revalidate }) => { revalidate?.(); replies++ },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/api/v1/permissions/bash/reply`
  const submit = (reply: string, privilege = false) => fetch(url, { method: "POST", headers: { "content-type": "application/json", cookie: `bridge_session=${f.token}${privilege ? `; bridge_privileged=${elevated.token}` : ""}` }, body: JSON.stringify({ reply }) })
  try {
    assert.equal((await submit("once")).status, 403)
    assert.equal((await submit("reject")).status, 200)
    assert.equal((await submit("once", true)).status, 200)
    f.clock(f.started + 300)
    assert.equal((await submit("once", true)).status, 403)
    assert.equal((await submit("reject")).status, 200)
    assert.equal(replies, 3)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.store.close() }
})

test("guard supplied to permission callbacks catches revocation across their own async validations", async () => {
  const f = actorFixture()
  let replies = 0
  const server = createServer(createRequestHandler({ loadSnapshot: async () => { throw new Error("unused") }, authorizeSession: f.authorize,
    respondPermission: async ({ revalidate }) => {
      await Promise.resolve()
      f.store.revokeTrustedDevice("owner", f.actor.deviceId, f.other)
      revalidate?.(); replies++
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert(address && typeof address === "object")
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/permissions/p/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: `bridge_session=${f.token}` }, body: '{"reply":"reject"}' })
    assert.equal(response.status, 401); assert.equal(replies, 0)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.store.close() }
})

test("sensitive route budgets return opaque 429 and stop callbacks, with actor/device isolation", async () => {
  const f = actorFixture()
  const counts = { revoke: 0, proposal: 0, decision: 0, permission: 0, auth: 0 }
  const options: RequestHandlerOptions = { loadSnapshot: async () => { throw new Error("unused") }, security: f.security, authorizeSession: f.authorize,
    requirePrivilege: () => {}, actionRequiresPrivilege: () => true,
    revokeDevice: () => { counts.revoke++; return false },
    proposeAction: () => { counts.proposal++; return { actionId: "a", decision: "ASK" } },
    decideAction: async () => { counts.decision++; return { status: "executed" } },
    respondPermission: async () => { counts.permission++ },
    authenticateTelegram: () => { counts.auth++; throw new SecurityError(401, "Unauthorized") },
  }
  const server = createServer(createRequestHandler(options))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}/api/v1`
  const routes = [ ["/devices/unknown", "DELETE", undefined, "revoke"],
    ["/sessions/s/actions", "POST", { type: "session.delete" }, "proposal"],
    ["/actions/a/decision", "POST", { decision: "approve" }, "decision"],
    ["/permissions/p/reply", "POST", { reply: "once" }, "permission"] ] as const
  try {
    for (const [path, method, body, counter] of routes) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie: `bridge_session=${f.token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
        if (attempt === 5) {
          assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "300")
          assert.deepEqual(await response.json(), { error: "Too many attempts" })
        } else assert.notEqual(response.status, 429)
      }
      assert.equal(counts[counter], 5)
    }
    const other = await fetch(`${base}/devices/unknown`, { method: "DELETE", headers: { cookie: `bridge_session=${"B".repeat(43)}` } })
    assert.equal(other.status, 409)
    for (let i = 0; i < 31; i++) {
      const response = await fetch(`${base}/auth/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"initData":"invalid"}' })
      assert.equal(response.status, i < 30 ? 401 : 429)
    }
    assert.equal(counts.auth, 30)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.store.close() }
})

test("lock and compromised attempts are rate-limited before effects even without privilege", async () => {
  const f = actorFixture()
  try {
    for (const compromised of [false, true]) {
      for (let i = 0; i < 6; i++) await assert.rejects(f.security.lockRemoteAccess(f.actor, f.token, "", compromised),
        (error: unknown) => error instanceof SecurityError && error.status === (i < 5 ? 403 : 429))
    }
    assert.equal(f.store.securityState("owner").locked, false)
  } finally { f.store.close() }
})

test("Cloudflare clients and authentication classes have independent persistent source budgets", async () => {
  const f = actorFixture()
  const calls = { telegram: 0, pairing: 0, challenge: 0, session: 0 }
  const reject = (operation: keyof typeof calls): never => { calls[operation]++; throw new SecurityError(401, "Unauthorized") }
  const server = createServer(createRequestHandler({ loadSnapshot: async () => { throw new Error("unused") }, security: f.security,
    authenticateTelegram: () => reject("telegram"), pairDevice: () => reject("pairing"), createChallenge: () => reject("challenge"), createSession: () => reject("session"),
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}/api/v1`
  const submit = (path: string, ip: string) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ initData: "invalid", pairingCode: "invalid", deviceId: "device", challengeId: "challenge" }) })
  try {
    for (let i = 0; i < 30; i++) assert.equal((await submit("/auth/telegram", "192.0.2.1")).status, 401)
    const limited = await submit("/auth/telegram", "192.0.2.1")
    assert.equal(limited.status, 429); assert.deepEqual(await limited.json(), { error: "Too many attempts" })
    assert.equal((await submit("/auth/telegram", "192.0.2.2")).status, 401)
    for (const route of ["/devices/pair", "/auth/challenge", "/auth/session"]) assert.equal((await submit(route, "192.0.2.1")).status, 401)
    for (let i = 0; i < 30; i++) assert.equal((await submit("/auth/challenge", "2001:0db8::1")).status, 401)
    assert.equal((await submit("/auth/challenge", "2001:db8:0:0:0:0:0:1")).status, 429)
    assert.equal((await submit("/auth/session", "2001:db8::1")).status, 401)
    assert.deepEqual(calls, { telegram: 31, pairing: 1, challenge: 31, session: 2 })
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.store.close() }
})
