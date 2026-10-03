import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import test from "node:test"
import type { BridgeConfig } from "./config.js"
import { createLockEffects } from "./lock-effects.js"
import { createWorkspaceExecutionLoader, createWorkspacePermissionLoader, createSessionAborter, createPermissionResponder, createPromptSender, createSessionDeleter } from "./opencode.js"
import { BridgeStore } from "./storage/database.js"
import { SecurityBoundary } from "./security.js"

for (const compromised of [false, true]) test(`lock adapters abort workspace busy/retry and reject pending permissions (${compromised ? "compromised" : "emergency"})`, async () => {
  const store = new BridgeStore(":memory:")
  const now = Math.floor(Date.now() / 1000), token = "A".repeat(43)
  store.ensureAuthorizedUser("owner"); store.replacePairingCode("pair", now + 900)
  const deviceId = store.pairDevice("owner", "init", now + 900, "pair", "{}", "Phone", createHash("sha256").update(token).digest("hex"), now + 900, now)!
  const actor = { userId: "owner", deviceId }
  const sessions = ["busy", "retry", "idle", "foreign"].map((id) => ({ id, directory: id === "foreign" ? "/elsewhere" : "/workspace" }))
  const permissions = ["busy", "idle", "foreign"].map((id) => ({ id: `p-${id}`, sessionID: id, permission: "bash", patterns: [], always: [], metadata: {} }))
  const writes: Array<{ path: string; body: unknown }> = []
  const upstream = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://upstream").pathname
    response.setHeader("content-type", "application/json")
    if (request.method === "GET" && path === "/session") return response.end(JSON.stringify(sessions))
    if (request.method === "GET" && path === "/session/status") return response.end(JSON.stringify({ busy: { type: "busy" }, retry: { type: "retry" }, idle: { type: "idle" }, foreign: { type: "busy" } }))
    if (request.method === "GET" && path === "/permission") return response.end(JSON.stringify(permissions))
    if (request.method === "GET" && /^\/session\/[^/]+$/.test(path)) return response.end(JSON.stringify(sessions.find((s) => s.id === path.split("/")[2])))
    if (request.method === "POST") {
      assert.equal(store.securityState("owner").locked, true, "lock must commit before upstream writes")
      let body = ""; for await (const chunk of request) body += chunk
      writes.push({ path, body: body ? JSON.parse(body) : null })
      // One abort fails to prove best-effort cleanup keeps the lock and other operations.
      if (path === "/session/retry/abort") response.statusCode = 503
      return response.end(JSON.stringify(true))
    }
    response.statusCode = 404; response.end("{}")
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address(); assert(address && typeof address === "object")
  const config: BridgeConfig = { bridgeHost: "127.0.0.1", bridgePort: 8787, databasePath: ":memory:", openCodeDirectory: "/workspace", openCodeUrl: new URL(`http://127.0.0.1:${address.port}`), openCodeUsername: "opencode" }
  const reply = createPermissionResponder(config)
  const effect = createLockEffects({ loadActiveSessions: createWorkspaceExecutionLoader(config), loadPermissions: createWorkspacePermissionLoader(config),
    abortSession: createSessionAborter(config), rejectPermission: (id) => reply(id, "reject"),
    audit: (actor, event, outcome) => store.recordSecurityEvent(actor, event, outcome, "trusted-device") })
  const security = new SecurityBoundary(store, "owner", () => now, effect)
  try {
    const { recoveryKey } = await security.setupRecovery(actor, token)
    const privilege = await security.elevate(actor, token, recoveryKey)
    const result = await security.lockRemoteAccess(actor, token, privilege.token, compromised)
    assert.equal(result.locked, true); assert.equal(result.telegramCompromised, compromised)
    assert.deepEqual(writes.map((write) => write.path).sort(), ["/session/busy/abort", "/session/retry/abort", "/permission/p-busy/reply", "/permission/p-idle/reply"].sort())
    for (const write of writes.filter((write) => write.path.startsWith("/permission"))) assert.deepEqual(write.body, { reply: "reject" })
    const audit = store.listAuditEvents("owner")
    assert(audit.some((event) => event.event === "security.lock.abort" && event.outcome === "failed"))
    assert(audit.some((event) => event.event === "security.lock.abort" && event.outcome === "executed"))
    assert.equal(audit.filter((event) => event.event === "security.lock.permission" && event.outcome === "executed").length, 2)
  } finally { await new Promise<void>((resolve) => upstream.close(() => resolve())); store.close() }
})

test("lock effects independently audit failed loaders and failed rejection", async () => {
  const audit: Array<{ event: string; outcome: string }> = []
  let rejects = 0
  const effect = createLockEffects({ loadActiveSessions: async () => { throw new Error("unavailable") },
    loadPermissions: async () => [{ requestId: "p", sessionId: "s", action: "bash", resources: [] }],
    abortSession: async () => { throw new Error("must not run") },
    rejectPermission: async () => { rejects++; throw new Error("unavailable") },
    audit: (_actor, event, outcome) => { audit.push({ event, outcome }) },
  })
  await effect({ userId: "owner", deviceId: "device" })
  assert.equal(rejects, 1)
  assert.deepEqual(audit, [{ event: "security.lock.status", outcome: "failed" }, { event: "security.lock.permission", outcome: "failed" }])
})

test("SDK mutation adapters revalidate after async scope checks before dispatch", async () => {
  let authorized = true, writes = 0
  const upstream = createServer((request, response) => {
    const path = new URL(request.url!, "http://upstream").pathname
    response.setHeader("content-type", "application/json")
    if (request.method === "GET" && path === "/permission") return response.end(JSON.stringify([{ id: "p", sessionID: "s", permission: "bash", patterns: [], always: [], metadata: {} }]))
    if (request.method === "GET" && path === "/session/s") { authorized = false; return response.end(JSON.stringify({ id: "s", directory: "/workspace" })) }
    if (request.method !== "GET") writes++
    response.end("true")
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address(); assert(address && typeof address === "object")
  const config: BridgeConfig = { bridgeHost: "127.0.0.1", bridgePort: 8787, databasePath: ":memory:", openCodeDirectory: "/workspace", openCodeUrl: new URL(`http://127.0.0.1:${address.port}`), openCodeUsername: "opencode" }
  const guard = () => { if (!authorized) throw new Error("revoked") }
  try {
    for (const operation of [() => createPromptSender(config)("s", "text", [], {}, guard),
      () => createSessionDeleter(config)("s", guard), () => createSessionAborter(config)("s", guard),
      () => createPermissionResponder(config)("p", "once", guard)]) {
      authorized = true; await assert.rejects(operation(), /revoked/)
    }
    assert.equal(writes, 0)
  } finally { await new Promise<void>((resolve) => upstream.close(() => resolve())) }
})
