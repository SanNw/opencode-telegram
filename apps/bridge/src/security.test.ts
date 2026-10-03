import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { BridgeStore } from "./storage/database.js"
import { SecurityBoundary, SecurityError } from "./security.js"
import { createRequestHandler } from "./app.js"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
function fixture(databasePath = ":memory:") {
  const store = new BridgeStore(databasePath)
  let now = Math.floor(Date.now() / 1000)
  const token = "A".repeat(43)
  store.ensureAuthorizedUser("owner")
  store.replacePairingCode("pair", now + 900)
  const deviceId = store.pairDevice("owner", "init", now + 900, "pair", "{}", "Phone", hash(token), now + 900, now)!
  const actor = { userId: "owner", deviceId }
  const security = new SecurityBoundary(store, "owner", () => now)
  return { store, actor, token, security, clock: (value: number) => { now = value }, now }
}
function recoveryInput(recoveryKey: string) {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  return { recoveryKey, publicKey: key.publicKey.export({ format: "jwk" }), label: "Recovered device",
    proof: sign("sha256", Buffer.from(`opencode-telegram:recover:${recoveryKey}`), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") }
}

test("Recovery Key is generated once and only a salted memory-hard verifier is stored", async () => {
  const f = fixture()
  try {
    const results = await Promise.allSettled([f.security.setupRecovery(f.actor, f.token), f.security.setupRecovery(f.actor, f.token)])
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
    const setup = results.find((r) => r.status === "fulfilled")
    assert(setup?.status === "fulfilled")
    assert.match(setup.value.recoveryKey, /^rk_[A-Za-z0-9_-]{43}$/)
    const record = f.store.recoveryVerifier("owner")!
    assert.match(record.salt, /^[a-f0-9]{64}$/)
    assert.match(record.verifier, /^[a-f0-9]{128}$/)
    assert.notEqual(record.verifier, hash(setup.value.recoveryKey))
    assert(!JSON.stringify(f.store.listAuditEvents("owner")).includes(setup.value.recoveryKey))
    await assert.rejects(f.security.setupRecovery(f.actor, f.token), (e: unknown) => e instanceof SecurityError && e.status === 409)
    await assert.rejects(f.security.setupRecovery({ ...f.actor, deviceId: "other" }, f.token), (e: unknown) => e instanceof SecurityError && e.status === 401)
  } finally { f.store.close() }
})

test("privilege expires exactly after five minutes and is bound to user, device and normal session", async () => {
  const f = fixture()
  try {
    const { recoveryKey } = await f.security.setupRecovery(f.actor, f.token)
    const elevated = await f.security.elevate(f.actor, f.token, recoveryKey)
    assert.equal(elevated.expiresAt, f.now + 300)
    f.security.requirePrivilege(f.actor, f.token, elevated.token)
    for (const actor of [{ ...f.actor, deviceId: "other" }, { ...f.actor, userId: "other" }]) {
      assert.throws(() => f.security.requirePrivilege(actor, f.token, elevated.token), SecurityError)
    }
    assert.throws(() => f.security.requirePrivilege(f.actor, "B".repeat(43), elevated.token), SecurityError)
    const challenge = f.store.createDeviceChallenge("owner", f.actor.deviceId, f.now)!
    const secondToken = "C".repeat(43)
    assert.equal(f.store.consumeChallengeAndCreateSession({ userId: "owner", deviceId: f.actor.deviceId,
      challengeId: challenge.id, initDataHash: "second-init", initDataExpiresAt: f.now + 900,
      sessionTokenHash: hash(secondToken), sessionExpiresAt: f.now + 900, now: f.now }), true)
    assert(f.store.sessionIdentity(hash(secondToken), f.now))
    assert.throws(() => f.security.requirePrivilege(f.actor, secondToken, elevated.token), SecurityError)
    f.clock(f.now + 299)
    f.security.requirePrivilege(f.actor, f.token, elevated.token)
    f.clock(f.now + 300)
    assert.throws(() => f.security.requirePrivilege(f.actor, f.token, elevated.token), SecurityError)
  } finally { f.store.close() }
})

for (const compromised of [false, true]) test(`${compromised ? "compromised mode" : "emergency lock"} revokes access, freezes approvals and requires independent recovery`, async () => {
  const f = fixture()
  try {
    const { recoveryKey } = await f.security.setupRecovery(f.actor, f.token)
    const elevated = await f.security.elevate(f.actor, f.token, recoveryKey)
    const pending = f.store.createPendingPrompt("owner", f.actor.deviceId, "session", "safe text")
    f.security.lockRemoteAccess(f.actor, f.token, elevated.token, compromised)
    assert.deepEqual(f.store.securityState("owner"), { locked: true, telegramCompromised: compromised, recoveryConfigured: true })
    assert.equal(f.store.sessionIdentity(hash(f.token), f.now), undefined)
    assert.throws(() => f.security.requirePrivilege(f.actor, f.token, elevated.token), SecurityError)
    assert.equal(f.store.decidePendingAction(pending, "owner", f.actor.deviceId, "approve"), undefined)
    for (const create of [() => f.store.createPendingPrompt("owner", f.actor.deviceId, "session", "text"),
      () => f.store.createPendingSession("owner", f.actor.deviceId), () => f.store.createPendingAbort("owner", f.actor.deviceId, "session"),
      () => f.store.createPendingDelete("owner", f.actor.deviceId, "session"), () => f.store.createPendingCacheCleanup("owner", f.actor.deviceId)]) assert.throws(create, /locked/)
    f.store.replacePairingCode("new-pair", f.now + 900)
    assert.equal(f.store.pairDevice("owner", "new-init", f.now + 900, "new-pair", "{}", "Attack", "attack", f.now + 900, f.now), undefined)
    assert.equal(f.store.createDeviceChallenge("owner", f.actor.deviceId, f.now), undefined)
    await assert.rejects(f.security.recover(recoveryInput(`rk_${"B".repeat(43)}`)), SecurityError)
    await assert.rejects(f.security.recover({ ...recoveryInput(recoveryKey), proof: "invalid" }), SecurityError)
    const recovered = await f.security.recover(recoveryInput(recoveryKey))
    assert.equal(f.store.securityState("owner").locked, false)
    assert.equal(f.store.securityState("owner").telegramCompromised, false)
    assert.equal(f.store.sessionIdentity(hash(f.token), f.now), undefined)
    assert.equal(f.store.sessionIdentity(hash(recovered.sessionToken), f.now)?.deviceId, recovered.deviceId)
    assert.deepEqual(f.store.listTrustedDevices("owner").map((d) => d.id), [recovered.deviceId])
    assert.equal(f.store.decidePendingAction(pending, "owner", f.actor.deviceId, "approve"), undefined)
    assert(!JSON.stringify(f.store.listAuditEvents("owner")).includes(recoveryKey))
  } finally { f.store.close() }
})

test("recovery and step-up throttling uses persistent owner-wide fixed windows", async () => {
  const f = fixture()
  try {
    const { recoveryKey } = await f.security.setupRecovery(f.actor, f.token)
    for (let i = 0; i < 5; i++) await assert.rejects(f.security.elevate(f.actor, f.token, "wrong"), (e: unknown) => e instanceof SecurityError && e.status === 401)
    await assert.rejects(f.security.elevate(f.actor, f.token, recoveryKey), (e: unknown) => e instanceof SecurityError && e.status === 429 && e.retryAfter === 300)
    for (let i = 0; i < 5; i++) await assert.rejects(f.security.recover(recoveryInput("wrong")), (e: unknown) => e instanceof SecurityError && e.status === 401)
    await assert.rejects(f.security.recover(recoveryInput(recoveryKey)), (e: unknown) => e instanceof SecurityError && e.status === 429)
    f.clock(f.now + 300)
    const elevated = await f.security.elevate(f.actor, f.token, recoveryKey)
    assert.equal(elevated.expiresAt, f.now + 600)
  } finally { f.store.close() }
})

test("verifier, lock, frozen approvals and throttle persist across Bridge restart without storing the key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-security-"))
  const path = join(directory, "bridge.sqlite")
  const f = fixture(path)
  let activeStore = f.store
  try {
    const { recoveryKey } = await f.security.setupRecovery(f.actor, f.token)
    const elevated = await f.security.elevate(f.actor, f.token, recoveryKey)
    const pending = f.store.createPendingSession("owner", f.actor.deviceId)
    f.security.lockRemoteAccess(f.actor, f.token, elevated.token, true)
    for (let i = 0; i < 5; i++) assert.equal(f.store.takeSecurityAttempt("owner:recovery", f.now), undefined)
    const verifier = f.store.recoveryVerifier("owner")
    f.store.close()
    assert.equal(readFileSync(path).includes(Buffer.from(recoveryKey)), false)
    activeStore = new BridgeStore(path)
    assert.deepEqual(activeStore.recoveryVerifier("owner"), verifier)
    assert.equal(activeStore.securityState("owner").locked, true)
    assert.equal(activeStore.takeSecurityAttempt("owner:recovery", f.now), 300)
    assert.equal(activeStore.sessionIdentity(hash(f.token), f.now), undefined)
    assert.equal(activeStore.decidePendingAction(pending, "owner", f.actor.deviceId, "approve"), undefined)
    const security = new SecurityBoundary(activeStore, "owner", () => f.now)
    await assert.rejects(security.recover(recoveryInput(recoveryKey)), (e: unknown) => e instanceof SecurityError && e.status === 429)
  } finally {
    activeStore.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("security HTTP flow protects cookies, denies critical operations without step-up and recovers without Telegram", async () => {
  const f = fixture()
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") }, security: f.security,
    authorizeSession: (token) => token ? f.store.sessionIdentity(hash(token), f.now) ?? false : false,
    requirePrivilege: f.security.requirePrivilege.bind(f.security),
    revokeDevice: () => { throw new Error("must not run without privilege") },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}/api/v1`
  const headers = { cookie: `bridge_session=${f.token}`, "content-type": "application/json" }
  try {
    assert.equal((await fetch(`${base}/security`)).status, 401)
    assert.equal((await fetch(`${base}/devices/other`, { method: "DELETE", headers })).status, 403)
    const setup = await fetch(`${base}/security/recovery/setup`, { method: "POST", headers })
    assert.equal(setup.status, 201); assert.equal(setup.headers.get("cache-control"), "no-store")
    const { recoveryKey } = await setup.json() as { recoveryKey: string }
    const step = await fetch(`${base}/security/step-up`, { method: "POST", headers, body: JSON.stringify({ recoveryKey }) })
    assert.equal(step.status, 200)
    const cookie = step.headers.get("set-cookie")!
    assert.match(cookie, /Max-Age=300; HttpOnly; Secure; SameSite=Strict/)
    assert(!JSON.stringify(await step.json()).includes(cookie.split(";")[0]!.split("=")[1]!))
    const lock = await fetch(`${base}/security/telegram-compromised`, { method: "POST", headers: { ...headers, cookie: `${headers.cookie}; ${cookie.split(";")[0]}` } })
    assert.equal(lock.status, 200)
    assert.equal((await fetch(`${base}/security`, { headers })).status, 401)
    const unlock = await fetch(`${base}/security/recovery/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(recoveryInput(recoveryKey)) })
    assert.equal(unlock.status, 200)
    assert.match(unlock.headers.get("set-cookie")!, /bridge_session=.*HttpOnly; Secure; SameSite=Strict/)
    assert(!JSON.stringify(await unlock.json()).includes(recoveryKey))
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    f.store.close()
  }
})
