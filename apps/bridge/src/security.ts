import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import type { BridgeStore, SecurityActor } from "./storage/database.js"
import { normalizeDeviceLabel, normalizeDevicePublicKey, verifyDeviceSignature } from "./auth/device.js"

const derive = (value: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(value, salt, 64, scryptOptions, (error, derived) => error ? reject(error) : resolve(derived))
})
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const keyPattern = /^rk_[A-Za-z0-9_-]{43}$/
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export class SecurityError extends Error {
  constructor(readonly status: 401 | 403 | 409 | 429, readonly publicMessage: string, readonly retryAfter?: number) {
    super(publicMessage)
  }
}

/** The independent factor never enters OpenCode, Telegram, logs or pending actions. */
export class SecurityBoundary {
  constructor(readonly store: BridgeStore, readonly ownerId: string, readonly clock = () => Math.floor(Date.now() / 1000), readonly lockEffects?: (actor: SecurityActor) => Promise<void>) {}

  limitSensitive(actor: SecurityActor, operation: string, limit = 5) {
    const retryAfter = this.store.takeSecurityAttempt(`actor:${actor.userId}:${actor.deviceId}:${operation}`, this.clock(), limit)
    if (retryAfter !== undefined) {
      this.store.recordSecurityEvent(actor, "security.endpoint", "throttled", "trusted-device", "rate-limit", this.clock())
      throw new SecurityError(429, "Too many attempts", retryAfter)
    }
  }

  limitSource(source: string, operation: "telegram" | "pairing" | "challenge" | "session") {
    const retryAfter = this.store.takeSecurityAttempt(`source:${hash(source)}:${operation}`, this.clock(), 30)
    if (retryAfter !== undefined) throw new SecurityError(429, "Too many attempts", retryAfter)
  }

  #actor(actor: SecurityActor, sessionToken: string) {
    const identity = tokenPattern.test(sessionToken) ? this.store.sessionIdentity(hash(sessionToken), this.clock()) : undefined
    if (!identity || identity.userId !== actor.userId || identity.deviceId !== actor.deviceId || actor.userId !== this.ownerId) {
      throw new SecurityError(401, "Unauthorized")
    }
  }

  #attempt(actor: { userId: string; deviceId?: string }, operation: "step-up" | "recovery" | "setup") {
    // Owner-wide buckets prevent bypass by inventing device IDs or changing IPs.
    const retryAfter = this.store.takeSecurityAttempt(`${actor.userId}:${operation}`, this.clock())
    if (retryAfter !== undefined) {
      this.store.recordSecurityEvent(actor, `security.${operation}`, "throttled", operation === "recovery" ? "independent-recovery" : "trusted-device", "rate-limit", this.clock())
      throw new SecurityError(429, "Too many attempts", retryAfter)
    }
  }

  async #verify(actor: { userId: string; deviceId?: string }, recoveryKey: string, operation: "step-up" | "recovery") {
    this.#attempt(actor, operation)
    const record = this.store.recoveryVerifier(actor.userId)
    // The dummy derivation gives absent configuration and incorrect keys the same cost.
    const salt = record?.salt ?? "0".repeat(64)
    const candidate = await derive(recoveryKey.slice(0, 128), salt)
    const expected = Buffer.from(record?.verifier ?? "0".repeat(128), "hex")
    const accepted = timingSafeEqual(candidate, expected) && Boolean(record) && keyPattern.test(recoveryKey)
    if (!accepted) {
      this.store.recordSecurityEvent(actor, `security.${operation}`, "rejected", operation === "recovery" ? "independent-recovery" : "trusted-device", "invalid-factor", this.clock())
      throw new SecurityError(401, "Invalid recovery credential")
    }
  }

  async setupRecovery(actor: SecurityActor, sessionToken: string) {
    this.#actor(actor, sessionToken)
    this.#attempt(actor, "setup")
    if (this.store.securityState(actor.userId).recoveryConfigured) throw new SecurityError(409, "Recovery already configured")
    const recoveryKey = `rk_${randomBytes(32).toString("base64url")}`
    const salt = randomBytes(32).toString("hex")
    const verifier = (await derive(recoveryKey, salt)).toString("hex")
    this.#actor(actor, sessionToken)
    if (!this.store.configureRecovery(actor, salt, verifier)) throw new SecurityError(409, "Recovery already configured")
    return { recoveryKey, storageAdvice: "Store outside Telegram, preferably in a password manager. This key is displayed only once." }
  }

  async elevate(actor: SecurityActor, sessionToken: string, recoveryKey: string) {
    this.#actor(actor, sessionToken)
    await this.#verify(actor, recoveryKey, "step-up")
    this.#actor(actor, sessionToken)
    const token = randomBytes(32).toString("base64url")
    const expiresAt = this.store.createPrivilegedSession(actor, hash(sessionToken), hash(token), this.clock())
    if (!expiresAt) throw new SecurityError(401, "Unauthorized")
    this.store.recordSecurityEvent(actor, "security.step-up", "accepted", "trusted-device", undefined, this.clock())
    return { token, expiresAt }
  }

  requirePrivilege(actor: SecurityActor, sessionToken: string | undefined, privilegedToken: string | undefined) {
    const accepted = actor.userId === this.ownerId && sessionToken && privilegedToken && tokenPattern.test(sessionToken) && tokenPattern.test(privilegedToken) &&
      this.store.hasPrivilege(actor, hash(sessionToken), hash(privilegedToken), this.clock())
    if (!accepted) {
      this.store.recordSecurityEvent(actor, "security.privilege", "rejected", "trusted-device", "step-up-required", this.clock())
      throw new SecurityError(403, "Step-up authentication required")
    }
  }

  async lockRemoteAccess(actor: SecurityActor, sessionToken: string, privilegedToken: string, compromised: boolean) {
    this.#actor(actor, sessionToken)
    this.limitSensitive(actor, compromised ? "telegram-compromised" : "lock")
    this.requirePrivilege(actor, sessionToken, privilegedToken)
    if (!this.store.securityState(actor.userId).recoveryConfigured) throw new SecurityError(409, "Configure recovery first")
    this.store.lockRemoteAccess(actor, compromised, this.clock())
    if (this.lockEffects) {
      try { await this.lockEffects(actor) }
      catch { this.store.recordSecurityEvent(actor, "security.lock.upstream", "failed", "trusted-device", "upstream-unavailable", this.clock()) }
    }
    return this.store.securityState(actor.userId)
  }

  async recover(input: { recoveryKey: string; publicKey: unknown; label: unknown; proof: unknown }) {
    const actor = { userId: this.ownerId }
    await this.#verify(actor, input.recoveryKey, "recovery")
    let publicKey: string, label: string
    try {
      publicKey = normalizeDevicePublicKey(input.publicKey)
      label = normalizeDeviceLabel(input.label)
      verifyDeviceSignature(publicKey, `opencode-telegram:recover:${input.recoveryKey}`, input.proof)
    } catch {
      this.store.recordSecurityEvent(actor, "security.recovery", "rejected", "independent-recovery", "invalid-device-proof", this.clock())
      throw new SecurityError(401, "Invalid recovery credential")
    }
    const sessionToken = randomBytes(32).toString("base64url")
    const deviceId = this.store.recoverAccess(this.ownerId, publicKey, label, hash(sessionToken), this.clock())
    return { deviceId, sessionToken }
  }
}
