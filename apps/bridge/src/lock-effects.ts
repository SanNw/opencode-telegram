import type { PendingPermission } from "./opencode.js"
import type { SecurityActor } from "./storage/database.js"

type LockEffectOptions = {
  loadActiveSessions: () => Promise<string[]>
  loadPermissions: () => Promise<PendingPermission[]>
  abortSession: (sessionId: string) => Promise<void>
  rejectPermission: (requestId: string) => Promise<void>
  audit: (actor: SecurityActor, event: string, outcome: "executed" | "failed") => void
}

/** Local lock is committed before this independent, best-effort upstream cleanup. */
export function createLockEffects(options: LockEffectOptions) {
  return async (actor: SecurityActor) => {
    const [sessions, permissions] = await Promise.allSettled([options.loadActiveSessions(), options.loadPermissions()])
    const effects: Promise<unknown>[] = []
    const run = async (event: string, operation: () => Promise<void>) => {
      try { await operation(); options.audit(actor, event, "executed") }
      catch { options.audit(actor, event, "failed") }
    }
    if (sessions.status === "fulfilled") {
      for (const sessionId of sessions.value) effects.push(run("security.lock.abort", () => options.abortSession(sessionId)))
    } else options.audit(actor, "security.lock.status", "failed")
    // The permission loader validates workspace scope independently, so failures
    // while loading statuses cannot prevent pending permission rejection.
    if (permissions.status === "fulfilled") {
      for (const permission of permissions.value) effects.push(run("security.lock.permission", () => options.rejectPermission(permission.requestId)))
    } else options.audit(actor, "security.lock.permissions", "failed")
    await Promise.allSettled(effects)
  }
}
