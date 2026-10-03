import assert from "node:assert/strict"
import test from "node:test"
import { BridgeStore } from "./database.js"
import Database from "better-sqlite3"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("online WAL backup and restored store preserve device revocation, lock, recovery verifier and audit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-restore-"))
  const source = join(directory, "source.sqlite"), backupPath = join(directory, "backup.sqlite")
  let store: BridgeStore | undefined = new BridgeStore(source)
  let restored: BridgeStore | undefined
  try {
    const now = Math.floor(Date.now() / 1000)
    store.ensureAuthorizedUser("279058397")
    store.replacePairingCode("fixture-pairing", now + 600)
    const deviceId = store.pairDevice("279058397", "fixture-init", now + 600, "fixture-pairing", "{}", "Restore fixture", "fixture-session", now + 600, now)
    assert(deviceId)
    const actor = { userId: "279058397", deviceId }
    assert(store.configureRecovery(actor, "fixture-salt", "fixture-verifier"))
    const pending = store.createPendingAbort(actor.userId, deviceId, "fixture-opencode-session")
    store.lockRemoteAccess(actor, true, now)
    const expectedDevices = store.listTrustedDevices(actor.userId)
    const expectedAudit = store.listAuditEvents(actor.userId)
    // Keep the live store open while using SQLite's online backup, not copying
    // its main file without WAL. Restore into a separate disposable database.
    const live = new Database(source, { readonly: true, fileMustExist: true })
    try { await live.backup(backupPath) } finally { live.close() }
    store.close(); store = undefined
    restored = new BridgeStore(backupPath)
    assert.deepEqual(restored.listTrustedDevices(actor.userId), expectedDevices)
    assert.deepEqual(restored.listAuditEvents(actor.userId), expectedAudit)
    assert.deepEqual(restored.securityState(actor.userId), { recoveryConfigured: true, locked: true, telegramCompromised: true })
    assert.deepEqual(restored.recoveryVerifier(actor.userId), { salt: "fixture-salt", verifier: "fixture-verifier" })
    assert.equal(restored.isSessionValid("fixture-session", now), false)
    assert.equal(restored.decidePendingAction(pending, actor.userId, deviceId, "approve", now), undefined)
    const inspection = new Database(backupPath, { readonly: true, fileMustExist: true })
    try { assert.equal(inspection.pragma("integrity_check", { simple: true }), "ok") } finally { inspection.close() }
  } finally {
    restored?.close(); store?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("Telegram initData is consumed atomically once", () => {
  const store = new BridgeStore(":memory:")
  try {
    store.ensureAuthorizedUser("279058397")
    assert.equal(store.consumeTelegramInitData("279058397", "signed-hash", 4_000_000_000), true)
    assert.equal(store.consumeTelegramInitData("279058397", "signed-hash", 4_000_000_000), false)
  } finally {
    store.close()
  }
})

test("pairing code creates one trusted device and cannot be reused", () => {
  const store = new BridgeStore(":memory:")
  try {
    store.ensureAuthorizedUser("279058397")
    store.replacePairingCode("pairing-hash", 2_000)
    const first = store.pairDevice(
      "279058397", "init-hash-1", 2_000, "pairing-hash", "{}", "Phone",
      "session-hash-1", 2_000, 1_000,
    )
    const second = store.pairDevice(
      "279058397", "init-hash-2", 2_000, "pairing-hash", "{}", "Other",
      "session-hash-2", 2_000, 1_000,
    )
    assert.equal(typeof first, "string")
    assert.equal(second, undefined)
    assert.equal(store.hasActiveTrustedDevice("279058397"), true)
    assert.equal(store.isSessionValid("session-hash-1", 1_500), true)
    assert(first)
    const uploadId = `upl_${"a".repeat(32)}`
    const action = store.createPendingPrompt("279058397", first, "session-1", "Inspect the tests", [uploadId], {
      agent: "OpenAgent",
      model: { providerId: "openai", modelId: "gpt-5.4" },
      variant: "high",
    })
    assert.deepEqual(store.decidePendingAction(action, "279058397", first, "approve"), {
      decision: "approved",
      action: "session.prompt",
      sessionId: "session-1",
      text: "Inspect the tests",
      uploadIds: [uploadId],
      agent: "OpenAgent",
      model: { providerId: "openai", modelId: "gpt-5.4" },
      variant: "high",
    })
    assert.equal(store.decidePendingAction(action, "279058397", first, "approve"), undefined)
    const abort = store.createPendingAbort("279058397", first, "session-1")
    assert.deepEqual(store.decidePendingAction(abort, "279058397", first, "approve"), {
      decision: "approved",
      action: "session.abort",
      sessionId: "session-1",
    })
    const deletion = store.createPendingDelete("279058397", first, "session-1")
    assert.deepEqual(store.decidePendingAction(deletion, "279058397", first, "approve"), {
      decision: "approved",
      action: "session.delete",
      sessionId: "session-1",
    })
    assert.equal(store.decidePendingAction(deletion, "279058397", first, "approve"), undefined)
    const create = store.createPendingSession("279058397", first, "Remote task")
    assert.deepEqual(store.decidePendingAction(create, "279058397", first, "approve"), {
      decision: "approved",
      action: "session.create",
      title: "Remote task",
    })
    assert.deepEqual(store.listTrustedDevices("279058397").map(({ label }) => label), ["Phone"])
    assert.equal(store.revokeTrustedDevice("279058397", first, first), false)
    assert(store.listAuditEvents("279058397").some(({ event, outcome }) => (
      event === "action.decided" && outcome === "approve"
    )))
  } finally {
    store.close()
  }
})

test("revoking another trusted device also revokes its sessions", () => {
  const store = new BridgeStore(":memory:")
  try {
    store.ensureAuthorizedUser("owner")
    store.replacePairingCode("first-code", 2_000)
    const first = store.pairDevice(
      "owner", "init-1", 2_000, "first-code", "{}", "Current phone",
      "session-1", 2_000, 1_000,
    )!
    store.replacePairingCode("second-code", 2_000)
    const second = store.pairDevice(
      "owner", "init-2", 2_000, "second-code", "{}", "Old phone",
      "session-2", 2_000, 1_001,
    )!

    assert.equal(store.revokeTrustedDevice("owner", second, first), true)
    assert.equal(store.isSessionValid("session-2", 1_500), false)
    assert.equal(store.isSessionValid("session-1", 1_500), true)
    assert.deepEqual(store.listTrustedDevices("owner").map(({ id }) => id), [first])
  } finally {
    store.close()
  }
})

