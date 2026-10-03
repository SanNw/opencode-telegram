import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import Database from "better-sqlite3"
import { isManagementType, managementTypes, normalizeManagementMutation, type ManagementMutation } from "../management-actions.js"
import { gitTypes, isGitType, normalizeGitMutation, type GitMutation } from "../git-actions.js"

export type UsageRecord = {
  id: string; sessionId: string; projectId: string; createdAt: number
  provider: string; model: string; agent: string
  input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number
}

export type FileHandleRecord = {
  id: string
  userId: string
  sessionId: string
  relativePath: string
  name: string
  mime: string
  size: number
  preview: "image" | "text" | "download"
  expiresAt: number
}

export type DirectoryHandleRecord = {
  id: string
  userId: string
  relativePath: string
  name: string
  expiresAt: number
}

export type UploadRecord = { id: string; userId: string; name: string; mime: string; size: number; content: Buffer; expiresAt: number }

export type SecurityState = { recoveryConfigured: boolean; locked: boolean; telegramCompromised: boolean }
export type SecurityActor = { userId: string; deviceId: string }

export class BridgeStore {
  readonly #database: Database.Database

  constructor(path: string) {
    const filename = path === ":memory:" ? path : resolve(path)
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true })

    this.#database = new Database(filename)
    this.#database.pragma("foreign_keys = ON")
    if (filename !== ":memory:") this.#database.pragma("journal_mode = WAL")
    this.#migrate()
  }

  #migrate() {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)

    let version = (this.#database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration")
      .get() as { version: number }).version

    if (version < 1) {
      this.#database.transaction(() => {
        this.#database.exec(`
        CREATE TABLE authorized_user (
          telegram_user_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          created_at INTEGER NOT NULL
        );

        CREATE TABLE consumed_telegram_init_data (
          hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );

        CREATE TABLE audit_event (
          id INTEGER PRIMARY KEY,
          created_at INTEGER NOT NULL,
          event TEXT NOT NULL,
          telegram_user_id TEXT,
          outcome TEXT NOT NULL
        );

        CREATE INDEX audit_event_created_at ON audit_event(created_at);
        `)
        this.#database
          .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (1, ?)")
          .run(Date.now())
      })()
      version = 1
    }

    if (version < 2) {
      this.#database.transaction(() => {
        this.#database.exec(`
          CREATE TABLE pairing_code (
            hash TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL,
            used_at INTEGER
          );

          CREATE TABLE trusted_device (
            id TEXT PRIMARY KEY,
            telegram_user_id TEXT NOT NULL REFERENCES authorized_user(telegram_user_id),
            public_key_jwk TEXT NOT NULL,
            label TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            revoked_at INTEGER
          );

          CREATE INDEX trusted_device_user ON trusted_device(telegram_user_id, revoked_at);
        `)
        this.#database
          .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (2, ?)")
          .run(Date.now())
      })()
      version = 2
    }

    if (version < 3) {
      this.#database.transaction(() => {
        this.#database.exec(`
          CREATE TABLE device_challenge (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL REFERENCES trusted_device(id),
            nonce TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            consumed_at INTEGER
          );

          CREATE TABLE bridge_session (
            token_hash TEXT PRIMARY KEY,
            telegram_user_id TEXT NOT NULL REFERENCES authorized_user(telegram_user_id),
            device_id TEXT NOT NULL REFERENCES trusted_device(id),
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            revoked_at INTEGER
          );

          CREATE INDEX bridge_session_device ON bridge_session(device_id, revoked_at);
        `)
        this.#database
          .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (3, ?)")
          .run(Date.now())
      })()
      version = 3
    }

    if (version < 4) {
      this.#database.transaction(() => {
        this.#database.exec(`
          CREATE TABLE pending_action (
            id TEXT PRIMARY KEY,
            telegram_user_id TEXT NOT NULL REFERENCES authorized_user(telegram_user_id),
            device_id TEXT NOT NULL REFERENCES trusted_device(id),
            action TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            decided_at INTEGER
          );

          CREATE INDEX pending_action_actor ON pending_action(telegram_user_id, device_id, status);
        `)
        this.#database
          .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (4, ?)")
          .run(Date.now())
      })()
      version = 4
    }

    if (version < 5) {
      this.#database.transaction(() => {
        this.#database.exec(`
          CREATE TABLE file_handle (
            id TEXT PRIMARY KEY,
            lookup_key TEXT NOT NULL UNIQUE,
            telegram_user_id TEXT NOT NULL REFERENCES authorized_user(telegram_user_id),
            session_id TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            name TEXT NOT NULL,
            mime TEXT NOT NULL,
            size INTEGER NOT NULL CHECK (size >= 0),
            preview TEXT NOT NULL CHECK (preview IN ('image', 'text', 'download')),
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          );

          CREATE INDEX file_handle_owner
          ON file_handle(telegram_user_id, session_id, expires_at);
        `)
        this.#database
          .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (5, ?)")
          .run(Date.now())
      })()
      version = 5
    }

    if (version < 6) {
      this.#database.transaction(() => {
        this.#database.exec(`
          CREATE TABLE directory_handle (
            id TEXT PRIMARY KEY,
            lookup_key TEXT NOT NULL UNIQUE,
            telegram_user_id TEXT NOT NULL REFERENCES authorized_user(telegram_user_id),
            relative_path TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          );

          CREATE INDEX directory_handle_owner
          ON directory_handle(telegram_user_id, expires_at);
        `)
        this.#database
          .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (6, ?)")
          .run(Date.now())
      })()
      version = 6
    }

    if (version < 7) {
      this.#database.transaction(() => {
        this.#database.exec(`
          CREATE TABLE upload_blob (
            id TEXT PRIMARY KEY,
            telegram_user_id TEXT NOT NULL REFERENCES authorized_user(telegram_user_id),
            name TEXT NOT NULL,
            mime TEXT NOT NULL,
            size INTEGER NOT NULL CHECK (size >= 0),
            content BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          );
          CREATE INDEX upload_blob_owner ON upload_blob(telegram_user_id, expires_at);
        `)
        this.#database.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (7, ?)").run(Date.now())
      })()
      version = 7
    }
    if (version < 8) {
      this.#database.transaction(() => {
        this.#database.exec(`CREATE TABLE usage_message (
          owner TEXT NOT NULL, workspace TEXT NOT NULL, id TEXT NOT NULL,
          sessionId TEXT NOT NULL, projectId TEXT NOT NULL, createdAt INTEGER NOT NULL,
          provider TEXT NOT NULL, model TEXT NOT NULL, agent TEXT NOT NULL,
          input INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
          cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL, cost REAL NOT NULL,
          PRIMARY KEY(owner, workspace, id)
        ); CREATE INDEX usage_period ON usage_message(owner, workspace, createdAt);`)
        this.#database.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (8, ?)").run(Date.now())
      })()
      version = 8
    }
    if (version < 9) {
      this.#database.transaction(() => {
        this.#database.exec(`
          CREATE TABLE security_state (
            telegram_user_id TEXT PRIMARY KEY REFERENCES authorized_user(telegram_user_id),
            recovery_salt TEXT, recovery_verifier TEXT,
            locked INTEGER NOT NULL DEFAULT 0, telegram_compromised INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE privileged_session (
            token_hash TEXT PRIMARY KEY, session_token_hash TEXT NOT NULL REFERENCES bridge_session(token_hash),
            telegram_user_id TEXT NOT NULL, device_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL, revoked_at INTEGER
          );
          CREATE TABLE security_throttle (
            scope TEXT PRIMARY KEY, window_started_at INTEGER NOT NULL, attempts INTEGER NOT NULL
          );
          ALTER TABLE pending_action ADD COLUMN frozen_at INTEGER;
          ALTER TABLE audit_event ADD COLUMN device_id TEXT;
          ALTER TABLE audit_event ADD COLUMN origin TEXT;
          ALTER TABLE audit_event ADD COLUMN reason TEXT;
        `)
        this.#database.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (9, ?)").run(Date.now())
      })()
      version = 9
    }
    if (version < 10) {
      this.#database.transaction(() => {
        this.#database.exec("ALTER TABLE pending_action ADD COLUMN session_token_hash TEXT")
        this.#database.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (10, ?)").run(Date.now())
      })()
    }
  }

  securityState(userId: string): SecurityState {
    const state = this.#database.prepare(`SELECT recovery_verifier IS NOT NULL AS recoveryConfigured,
      locked, telegram_compromised AS telegramCompromised FROM security_state WHERE telegram_user_id=?`)
      .get(userId) as { recoveryConfigured: number; locked: number; telegramCompromised: number } | undefined
    return { recoveryConfigured: Boolean(state?.recoveryConfigured), locked: Boolean(state?.locked), telegramCompromised: Boolean(state?.telegramCompromised) }
  }

  assertRemoteAccess(userId: string) {
    if (this.securityState(userId).locked) throw new Error("Remote access locked")
  }

  assertDeviceAccess(userId: string, deviceId: string) {
    this.assertRemoteAccess(userId)
    const device = this.#database.prepare(`SELECT 1 FROM trusted_device device JOIN authorized_user user
      ON user.telegram_user_id=device.telegram_user_id WHERE device.id=? AND device.telegram_user_id=?
      AND device.revoked_at IS NULL AND user.enabled=1`).get(deviceId, userId)
    if (!device) throw new Error("Device unavailable")
  }

  recoveryVerifier(userId: string): { salt: string; verifier: string } | undefined {
    return this.#database.prepare(`SELECT recovery_salt AS salt, recovery_verifier AS verifier
      FROM security_state WHERE telegram_user_id=? AND recovery_verifier IS NOT NULL`).get(userId) as { salt: string; verifier: string } | undefined
  }

  configureRecovery(actor: SecurityActor, salt: string, verifier: string): boolean {
    return this.#database.transaction(() => {
      this.assertRemoteAccess(actor.userId)
      this.#database.prepare("INSERT OR IGNORE INTO security_state(telegram_user_id) VALUES (?)").run(actor.userId)
      const changed = this.#database.prepare(`UPDATE security_state SET recovery_salt=?,recovery_verifier=?
        WHERE telegram_user_id=? AND recovery_verifier IS NULL`).run(salt, verifier, actor.userId).changes === 1
      this.recordSecurityEvent(actor, "recovery.configured", changed ? "accepted" : "rejected", "trusted-device")
      return changed
    })()
  }

  recordSecurityEvent(actor: { userId: string; deviceId?: string }, event: string, outcome: string, origin: "trusted-device" | "independent-recovery", reason?: string, now = Math.floor(Date.now() / 1000)) {
    this.#database.prepare(`INSERT INTO audit_event(created_at,event,telegram_user_id,outcome,device_id,origin,reason)
      VALUES (?,?,?,?,?,?,?)`).run(now * 1000, event, actor.userId, outcome, actor.deviceId ?? null, origin, reason ?? null)
  }

  takeSecurityAttempt(scope: string, now: number, limit = 5, windowSeconds = 300): number | undefined {
    return this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM security_throttle WHERE window_started_at + ? <= ?").run(windowSeconds, now)
      const row = this.#database.prepare("SELECT window_started_at AS started,attempts FROM security_throttle WHERE scope=?")
        .get(scope) as { started: number; attempts: number } | undefined
      if (row && now < row.started + windowSeconds && row.attempts >= limit) return row.started + windowSeconds - now
      if (!row || now >= row.started + windowSeconds) {
        this.#database.prepare(`INSERT INTO security_throttle VALUES (?,?,1)
          ON CONFLICT(scope) DO UPDATE SET window_started_at=excluded.window_started_at,attempts=1`).run(scope, now)
      } else this.#database.prepare("UPDATE security_throttle SET attempts=attempts+1 WHERE scope=?").run(scope)
      return undefined
    })()
  }

  createPrivilegedSession(actor: SecurityActor, sessionHash: string, tokenHash: string, now: number): number | undefined {
    const session = this.sessionIdentity(sessionHash, now)
    if (!session || session.userId !== actor.userId || session.deviceId !== actor.deviceId) return undefined
    const expiresAt = Math.min(now + 300, session.expiresAt)
    this.#database.prepare(`INSERT INTO privileged_session(token_hash,session_token_hash,telegram_user_id,device_id,expires_at)
      VALUES (?,?,?,?,?)`).run(tokenHash, sessionHash, actor.userId, actor.deviceId, expiresAt)
    return expiresAt
  }

  hasPrivilege(actor: SecurityActor, sessionHash: string, tokenHash: string, now: number): boolean {
    const session = this.sessionIdentity(sessionHash, now)
    if (!session || session.userId !== actor.userId || session.deviceId !== actor.deviceId) return false
    return Boolean(this.#database.prepare(`SELECT 1 FROM privileged_session WHERE token_hash=? AND session_token_hash=?
      AND telegram_user_id=? AND device_id=? AND revoked_at IS NULL AND expires_at>?`)
      .get(tokenHash, sessionHash, actor.userId, actor.deviceId, now))
  }

  lockRemoteAccess(actor: SecurityActor, compromised: boolean, now: number) {
    this.#database.transaction(() => {
      this.#database.prepare("INSERT OR IGNORE INTO security_state(telegram_user_id) VALUES (?)").run(actor.userId)
      this.#database.prepare(`UPDATE security_state SET locked=1, telegram_compromised=MAX(telegram_compromised,?) WHERE telegram_user_id=?`).run(Number(compromised), actor.userId)
      this.#database.prepare("UPDATE bridge_session SET revoked_at=? WHERE telegram_user_id=? AND revoked_at IS NULL").run(now, actor.userId)
      this.#database.prepare("UPDATE privileged_session SET revoked_at=? WHERE telegram_user_id=? AND revoked_at IS NULL").run(now, actor.userId)
      this.#database.prepare("UPDATE pending_action SET frozen_at=? WHERE telegram_user_id=? AND status='pending' AND frozen_at IS NULL").run(now, actor.userId)
      this.#database.prepare(`UPDATE device_challenge SET consumed_at=? WHERE device_id IN
        (SELECT id FROM trusted_device WHERE telegram_user_id=?) AND consumed_at IS NULL`).run(now, actor.userId)
      // Pairing credentials issued before the lock must never reopen access.
      this.#database.prepare("DELETE FROM pairing_code").run()
      if (compromised) this.#database.prepare("UPDATE trusted_device SET revoked_at=? WHERE telegram_user_id=? AND revoked_at IS NULL").run(now, actor.userId)
      this.recordSecurityEvent(actor, compromised ? "security.telegram_compromised" : "security.locked", "accepted", "trusted-device", undefined, now)
    })()
  }

  recoverAccess(userId: string, publicKeyJwk: string, label: string, sessionHash: string, now: number): string {
    return this.#database.transaction(() => {
      const deviceId = randomUUID()
      // Recovery starts fresh: old sessions, approvals and device credentials cannot resume.
      this.#database.prepare("UPDATE bridge_session SET revoked_at=? WHERE telegram_user_id=? AND revoked_at IS NULL").run(now, userId)
      this.#database.prepare("UPDATE privileged_session SET revoked_at=? WHERE telegram_user_id=? AND revoked_at IS NULL").run(now, userId)
      this.#database.prepare("UPDATE trusted_device SET revoked_at=? WHERE telegram_user_id=? AND revoked_at IS NULL").run(now, userId)
      this.#database.prepare("UPDATE pending_action SET frozen_at=? WHERE telegram_user_id=? AND status='pending' AND frozen_at IS NULL").run(now, userId)
      this.#database.prepare("DELETE FROM pairing_code").run()
      this.#database.prepare("UPDATE security_state SET locked=0,telegram_compromised=0 WHERE telegram_user_id=?").run(userId)
      this.#database.prepare(`INSERT INTO trusted_device(id,telegram_user_id,public_key_jwk,label,created_at,last_seen_at)
        VALUES (?,?,?,?,?,?)`).run(deviceId, userId, publicKeyJwk, label, now, now)
      this.#database.prepare(`INSERT INTO bridge_session(token_hash,telegram_user_id,device_id,created_at,expires_at)
        VALUES (?,?,?,?,?)`).run(sessionHash, userId, deviceId, now, now + 900)
      this.recordSecurityEvent({ userId, deviceId }, "recovery.unlocked", "accepted", "independent-recovery", undefined, now)
      return deviceId
    })()
  }

  recordUsage(owner: string, workspace: string, records: UsageRecord[]) {
    const insert = this.#database.prepare(`INSERT INTO usage_message VALUES
      (@owner,@workspace,@id,@sessionId,@projectId,@createdAt,@provider,@model,@agent,@input,@output,@reasoning,@cacheRead,@cacheWrite,@cost)
      ON CONFLICT(owner,workspace,id) DO UPDATE SET input=excluded.input, output=excluded.output,
      reasoning=excluded.reasoning, cacheRead=excluded.cacheRead, cacheWrite=excluded.cacheWrite, cost=excluded.cost`)
    this.#database.transaction(() => {
      for (const record of records) {
        if (![record.createdAt, record.input, record.output, record.reasoning, record.cacheRead, record.cacheWrite, record.cost].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("Invalid usage metric")
        insert.run({ ...record, owner, workspace })
      }
    })()
  }

  usage(owner: string, workspace: string, from: number, to: number) {
    const sums = `COUNT(*) AS messages, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output,
      COALESCE(SUM(reasoning),0) AS reasoning, COALESCE(SUM(cacheRead),0) AS cacheRead,
      COALESCE(SUM(cacheWrite),0) AS cacheWrite, COALESCE(SUM(cost),0) AS cost`
    const where = "FROM usage_message WHERE owner=? AND workspace=? AND createdAt>=? AND createdAt<?"
    const args = [owner, workspace, from, to]
    return {
      from, to, source: "opencode-reported", timezone: "UTC",
      totals: this.#database.prepare(`SELECT ${sums} ${where}`).get(...args),
      daily: this.#database.prepare(`SELECT strftime('%Y-%m-%d',createdAt/1000,'unixepoch') AS label, ${sums} ${where} GROUP BY label ORDER BY label`).all(...args),
      breakdown: Object.fromEntries(["provider", "model", "agent", "projectId"].map((field) => [field,
        this.#database.prepare(`SELECT ${field} AS label, ${sums} ${where} GROUP BY ${field} ORDER BY SUM(input)+SUM(output) DESC`).all(...args),
      ])),
    }
  }

  cacheSummary(userId: string, now = Math.floor(Date.now() / 1000)) {
    return {
      uploads: this.#database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM upload_blob WHERE telegram_user_id=?").get(userId),
      expiredUploads: this.#database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM upload_blob WHERE telegram_user_id=? AND expires_at<?").get(userId, now),
      expiredHandles: (this.#database.prepare(`SELECT
        (SELECT COUNT(*) FROM file_handle WHERE telegram_user_id=? AND expires_at<?) +
        (SELECT COUNT(*) FROM directory_handle WHERE telegram_user_id=? AND expires_at<?) AS count`).get(userId, now, userId, now) as { count: number }).count,
    }
  }

  clearExpiredCache(userId: string, now = Math.floor(Date.now() / 1000)) {
    return this.#database.transaction(() => {
      const before = this.cacheSummary(userId, now)
      for (const table of ["upload_blob", "file_handle", "directory_handle"]) {
        this.#database.prepare(`DELETE FROM ${table} WHERE telegram_user_id=? AND expires_at<?`).run(userId, now)
      }
      this.#database.prepare("INSERT INTO audit_event(created_at,event,telegram_user_id,outcome) VALUES (?,'cache.cleaned',?,'executed')").run(Date.now(), userId)
      return before
    })()
  }

  createPendingCacheCleanup(userId: string, deviceId: string) {
    this.assertDeviceAccess(userId, deviceId)
    const id = randomUUID(), now = Math.floor(Date.now() / 1000)
    this.#database.prepare(`INSERT INTO pending_action
      (id,telegram_user_id,device_id,action,resource_id,payload_json,status,created_at,expires_at)
      VALUES (?,?,?,'cache.cleanup','expired-bridge-cache','{}','pending',?,?)`).run(id,userId,deviceId,now,now+300)
    return id
  }

  createUpload(input: UploadRecord) {
    const now = Math.floor(Date.now() / 1_000)
    this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM upload_blob WHERE expires_at < ?").run(now)
      this.#database.prepare(`INSERT INTO upload_blob (id, telegram_user_id, name, mime, size, content, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.userId, input.name, input.mime, input.size, input.content, now, input.expiresAt)
    })()
  }

  getUploads(ids: string[], userId: string, now = Math.floor(Date.now() / 1_000)): UploadRecord[] {
    if (!ids.length) return []
    this.deleteExpiredUploads(now)
    const placeholders = ids.map(() => "?").join(",")
    return this.#database.prepare(`SELECT id, telegram_user_id AS userId, name, mime, size, content, expires_at AS expiresAt FROM upload_blob WHERE telegram_user_id = ? AND expires_at >= ? AND id IN (${placeholders})`)
      .all(userId, now, ...ids) as UploadRecord[]
  }

  deleteUploads(ids: string[], userId: string) {
    if (!ids.length) return
    const placeholders = ids.map(() => "?").join(",")
    this.#database.prepare(`DELETE FROM upload_blob WHERE telegram_user_id = ? AND id IN (${placeholders})`).run(userId, ...ids)
  }

  deleteExpiredUploads(now = Math.floor(Date.now() / 1_000)): number {
    return this.#database.prepare("DELETE FROM upload_blob WHERE expires_at < ?").run(now).changes
  }

  upsertDirectoryHandle(input: DirectoryHandleRecord & { lookupKey: string }): DirectoryHandleRecord {
    const now = Math.floor(Date.now() / 1_000)
    this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM directory_handle WHERE expires_at < ?").run(now)
      this.#database.prepare(`
        INSERT INTO directory_handle (
          id, lookup_key, telegram_user_id, relative_path, name, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (lookup_key) DO UPDATE SET
          name = excluded.name,
          expires_at = excluded.expires_at
      `).run(input.id, input.lookupKey, input.userId, input.relativePath, input.name, now, input.expiresAt)
    })()
    const stored = this.#database.prepare(`
      SELECT id,
             telegram_user_id AS userId,
             relative_path AS relativePath,
             name,
             expires_at AS expiresAt
      FROM directory_handle WHERE lookup_key = ?
    `).get(input.lookupKey) as DirectoryHandleRecord | undefined
    if (!stored) throw new Error("Directory handle could not be stored")
    return stored
  }

  getDirectoryHandle(id: string, userId: string, now = Math.floor(Date.now() / 1_000)): DirectoryHandleRecord | undefined {
    return this.#database.prepare(`
      SELECT id,
             telegram_user_id AS userId,
             relative_path AS relativePath,
             name,
             expires_at AS expiresAt
      FROM directory_handle
      WHERE id = ? AND telegram_user_id = ? AND expires_at >= ?
      LIMIT 1
    `).get(id, userId, now) as DirectoryHandleRecord | undefined
  }

  upsertFileHandle(input: FileHandleRecord & { lookupKey: string }): FileHandleRecord {
    const now = Math.floor(Date.now() / 1_000)
    this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM file_handle WHERE expires_at < ?").run(now)
      this.#database.prepare(`
        INSERT INTO file_handle (
          id, lookup_key, telegram_user_id, session_id, relative_path,
          name, mime, size, preview, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (lookup_key) DO UPDATE SET
          name = excluded.name,
          mime = excluded.mime,
          size = excluded.size,
          preview = excluded.preview,
          expires_at = excluded.expires_at
      `).run(
        input.id,
        input.lookupKey,
        input.userId,
        input.sessionId,
        input.relativePath,
        input.name,
        input.mime,
        input.size,
        input.preview,
        now,
        input.expiresAt,
      )
    })()
    const stored = this.#database.prepare(`
      SELECT id,
             telegram_user_id AS userId,
             session_id AS sessionId,
             relative_path AS relativePath,
             name,
             mime,
             size,
             preview,
             expires_at AS expiresAt
      FROM file_handle
      WHERE lookup_key = ?
    `).get(input.lookupKey) as FileHandleRecord | undefined
    if (!stored) throw new Error("File handle could not be stored")
    return stored
  }

  getFileHandle(id: string, userId: string, now = Math.floor(Date.now() / 1_000)): FileHandleRecord | undefined {
    return this.#database.prepare(`
      SELECT id,
             telegram_user_id AS userId,
             session_id AS sessionId,
             relative_path AS relativePath,
             name,
             mime,
             size,
             preview,
             expires_at AS expiresAt
      FROM file_handle
      WHERE id = ? AND telegram_user_id = ? AND expires_at >= ?
      LIMIT 1
    `).get(id, userId, now) as FileHandleRecord | undefined
  }

  listArtifacts(userId: string, category: "all" | "documents" | "images" | "code", cursor: number, limit: number, now = Math.floor(Date.now() / 1000)) {
    const rows = this.#database.prepare(`SELECT id, name, mime, size, preview, session_id AS sessionId, created_at AS createdAt,
      CASE WHEN mime LIKE 'image/%' THEN 'images'
      WHEN lower(name) GLOB '*.ts' OR lower(name) GLOB '*.tsx' OR lower(name) GLOB '*.js' OR lower(name) GLOB '*.jsx' OR lower(name) GLOB '*.mjs' OR lower(name) GLOB '*.py' OR lower(name) GLOB '*.go' OR lower(name) GLOB '*.rs' OR lower(name) GLOB '*.c' OR lower(name) GLOB '*.cpp' OR lower(name) GLOB '*.java' OR lower(name) GLOB '*.css' OR lower(name) GLOB '*.sh' OR lower(name) GLOB '*.sql' OR lower(name) GLOB '*.html' THEN 'code'
      ELSE 'documents' END AS category
      FROM file_handle WHERE telegram_user_id=? AND session_id!='storage' AND expires_at>=?
      AND (?='all' OR category=?) ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(userId, now, category, category, limit + 1, cursor) as Array<{ id: string; name: string; mime: string; size: number; preview: string; sessionId: string; createdAt: number; category: string }>
    return { artifacts: rows.slice(0, limit), ...(rows.length > limit ? { nextCursor: String(cursor + limit) } : {}) }
  }

  recordFileAccess(userId: string, outcome: "accepted" | "rejected") {
    this.#database.prepare(`
      INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
      VALUES (?, 'file.read', ?, ?)
    `).run(Date.now(), userId, outcome)
  }

  ensureAuthorizedUser(userId: string) {
    this.#database
      .prepare(`
        INSERT INTO authorized_user (telegram_user_id, enabled, created_at)
        VALUES (?, 1, ?)
        ON CONFLICT (telegram_user_id) DO NOTHING
      `)
      .run(userId, Date.now())
  }

  consumeTelegramInitData(userId: string, hash: string, expiresAt: number): boolean {
    return this.#database.transaction(() => {
      const now = Math.floor(Date.now() / 1_000)
      this.#database.prepare("DELETE FROM consumed_telegram_init_data WHERE expires_at < ?").run(now)
      const inserted = this.#database
        .prepare("INSERT OR IGNORE INTO consumed_telegram_init_data (hash, expires_at) VALUES (?, ?)")
        .run(hash, expiresAt)
      const accepted = inserted.changes === 1
      this.#database
        .prepare(`
          INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
          VALUES (?, 'telegram.init_data', ?, ?)
        `)
        .run(Date.now(), userId, accepted ? "accepted" : "replayed")
      return accepted
    })()
  }

  hasActiveTrustedDevice(userId: string): boolean {
    return Boolean(this.#database
      .prepare("SELECT 1 FROM trusted_device WHERE telegram_user_id = ? AND revoked_at IS NULL LIMIT 1")
      .get(userId))
  }

  replacePairingCode(hash: string, expiresAt: number) {
    this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM pairing_code").run()
      this.#database.prepare("INSERT INTO pairing_code (hash, expires_at) VALUES (?, ?)").run(hash, expiresAt)
    })()
  }

  pairDevice(
    userId: string,
    initDataHash: string,
    initDataExpiresAt: number,
    pairingCodeHash: string,
    publicKeyJwk: string,
    label: string,
    sessionTokenHash: string,
    sessionExpiresAt: number,
    now = Math.floor(Date.now() / 1_000),
  ): string | undefined {
    return this.#database.transaction(() => {
      if (this.securityState(userId).locked) return undefined
      this.#database.prepare("DELETE FROM consumed_telegram_init_data WHERE expires_at < ?").run(now)
      const code = this.#database.prepare(`
        SELECT 1 FROM pairing_code
        WHERE hash = ? AND used_at IS NULL AND expires_at >= ?
      `).get(pairingCodeHash, now)
      if (!code) return undefined

      const replay = this.#database
        .prepare("INSERT OR IGNORE INTO consumed_telegram_init_data (hash, expires_at) VALUES (?, ?)")
        .run(initDataHash, initDataExpiresAt)
      if (replay.changes !== 1) return undefined

      const consumed = this.#database.prepare(`
        UPDATE pairing_code
        SET used_at = ?
        WHERE hash = ? AND used_at IS NULL AND expires_at >= ?
      `).run(now, pairingCodeHash, now)
      if (consumed.changes !== 1) throw new Error("Pairing code changed during transaction")

      const deviceId = randomUUID()
      this.#database.prepare(`
        INSERT INTO trusted_device (
          id, telegram_user_id, public_key_jwk, label, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(deviceId, userId, publicKeyJwk, label, now, now)
      this.#database.prepare(`
        INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
        VALUES (?, 'device.paired', ?, 'accepted')
      `).run(Date.now(), userId)
      this.#database.prepare(`
        INSERT INTO bridge_session (
          token_hash, telegram_user_id, device_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(sessionTokenHash, userId, deviceId, now, sessionExpiresAt)
      return deviceId
    })()
  }

  createDeviceChallenge(
    userId: string,
    deviceId: string,
    now = Math.floor(Date.now() / 1_000),
  ): { id: string; nonce: string; publicKeyJwk: string } | undefined {
    if (this.securityState(userId).locked) return undefined
    this.#database.prepare("DELETE FROM device_challenge WHERE expires_at < ? OR consumed_at IS NOT NULL").run(now)
    const device = this.#database.prepare(`
      SELECT public_key_jwk AS publicKeyJwk
      FROM trusted_device
      WHERE id = ? AND telegram_user_id = ? AND revoked_at IS NULL
    `).get(deviceId, userId) as { publicKeyJwk: string } | undefined
    if (!device) return undefined

    const challenge = {
      id: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      publicKeyJwk: device.publicKeyJwk,
    }
    this.#database.prepare(`
      INSERT INTO device_challenge (id, device_id, nonce, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(challenge.id, deviceId, challenge.nonce, now + 60)
    return challenge
  }

  getDeviceChallenge(
    userId: string,
    deviceId: string,
    challengeId: string,
    now = Math.floor(Date.now() / 1_000),
  ): { nonce: string; publicKeyJwk: string } | undefined {
    if (this.securityState(userId).locked) return undefined
    return this.#database.prepare(`
      SELECT challenge.nonce, device.public_key_jwk AS publicKeyJwk
      FROM device_challenge challenge
      JOIN trusted_device device ON device.id = challenge.device_id
      WHERE challenge.id = ?
        AND challenge.device_id = ?
        AND device.telegram_user_id = ?
        AND challenge.consumed_at IS NULL
        AND challenge.expires_at >= ?
        AND device.revoked_at IS NULL
    `).get(challengeId, deviceId, userId, now) as { nonce: string; publicKeyJwk: string } | undefined
  }

  consumeChallengeAndCreateSession(input: {
    userId: string
    deviceId: string
    challengeId: string
    initDataHash: string
    initDataExpiresAt: number
    sessionTokenHash: string
    sessionExpiresAt: number
    now?: number
  }): boolean {
    const now = input.now ?? Math.floor(Date.now() / 1_000)
    return this.#database.transaction(() => {
      if (this.securityState(input.userId).locked) return false
      const device = this.#database.prepare("SELECT 1 FROM trusted_device WHERE id=? AND telegram_user_id=? AND revoked_at IS NULL").get(input.deviceId, input.userId)
      if (!device) return false
      const challenge = this.#database.prepare(`
        UPDATE device_challenge
        SET consumed_at = ?
        WHERE id = ? AND device_id = ? AND consumed_at IS NULL AND expires_at >= ?
      `).run(now, input.challengeId, input.deviceId, now)
      if (challenge.changes !== 1) return false

      const replay = this.#database
        .prepare("INSERT OR IGNORE INTO consumed_telegram_init_data (hash, expires_at) VALUES (?, ?)")
        .run(input.initDataHash, input.initDataExpiresAt)
      if (replay.changes !== 1) return false

      this.#database.prepare(`
        INSERT INTO bridge_session (
          token_hash, telegram_user_id, device_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(input.sessionTokenHash, input.userId, input.deviceId, now, input.sessionExpiresAt)
      this.#database.prepare(`
        UPDATE trusted_device SET last_seen_at = ?
        WHERE id = ? AND telegram_user_id = ? AND revoked_at IS NULL
      `).run(now, input.deviceId, input.userId)
      this.#database.prepare(`
        INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
        VALUES (?, 'session.created', ?, 'accepted')
      `).run(Date.now(), input.userId)
      return true
    })()
  }

  sessionExpiresAt(tokenHash: string, now = Math.floor(Date.now() / 1_000)): number | undefined {
    return this.sessionIdentity(tokenHash, now)?.expiresAt
  }

  sessionIdentity(tokenHash: string, now = Math.floor(Date.now() / 1_000)): {
    expiresAt: number
    userId: string
    deviceId: string
  } | undefined {
    return this.#database.prepare(`
      SELECT session.expires_at AS expiresAt,
             session.telegram_user_id AS userId,
             session.device_id AS deviceId
      FROM bridge_session session
      JOIN trusted_device device ON device.id = session.device_id
      JOIN authorized_user user ON user.telegram_user_id = session.telegram_user_id
      WHERE session.token_hash = ?
        AND session.expires_at >= ?
        AND session.revoked_at IS NULL
        AND device.revoked_at IS NULL
        AND user.enabled = 1
        AND NOT EXISTS (SELECT 1 FROM security_state WHERE telegram_user_id=session.telegram_user_id AND locked=1)
      LIMIT 1
    `).get(tokenHash, now) as { expiresAt: number; userId: string; deviceId: string } | undefined
  }

  isSessionValid(tokenHash: string, now = Math.floor(Date.now() / 1_000)): boolean {
    return this.sessionExpiresAt(tokenHash, now) !== undefined
  }

  listTrustedDevices(userId: string): Array<{
    id: string
    label: string
    createdAt: number
    lastSeenAt: number
  }> {
    return this.#database.prepare(`
      SELECT id, label, created_at AS createdAt, last_seen_at AS lastSeenAt
      FROM trusted_device
      WHERE telegram_user_id = ? AND revoked_at IS NULL
      ORDER BY last_seen_at DESC
    `).all(userId) as Array<{ id: string; label: string; createdAt: number; lastSeenAt: number }>
  }

  revokeTrustedDevice(userId: string, targetDeviceId: string, actorDeviceId: string): boolean {
    if (targetDeviceId === actorDeviceId) return false
    const now = Math.floor(Date.now() / 1_000)
    return this.#database.transaction(() => {
      const revoked = this.#database.prepare(`
        UPDATE trusted_device SET revoked_at = ?
        WHERE id = ? AND telegram_user_id = ? AND revoked_at IS NULL
      `).run(now, targetDeviceId, userId)
      if (revoked.changes !== 1) return false
      this.#database.prepare(`
        UPDATE bridge_session SET revoked_at = ?
        WHERE device_id = ? AND revoked_at IS NULL
      `).run(now, targetDeviceId)
      this.#database.prepare("UPDATE privileged_session SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL").run(now, targetDeviceId)
      this.#database.prepare("UPDATE pending_action SET frozen_at=? WHERE device_id=? AND status='pending' AND frozen_at IS NULL").run(now, targetDeviceId)
      this.#database.prepare(`
        INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
        VALUES (?, 'device.revoked', ?, 'accepted')
      `).run(Date.now(), userId)
      return true
    })()
  }

  listAuditEvents(userId: string, limit = 50): Array<{
    id: number
    createdAt: number
    event: string
    outcome: string
  }> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
    return this.#database.prepare(`
      SELECT id, created_at AS createdAt, event, outcome, device_id AS deviceId, origin, reason
      FROM audit_event
      WHERE telegram_user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(userId, boundedLimit) as Array<{
      id: number
      createdAt: number
      event: string
      outcome: string
    }>
  }

  createPendingPrompt(
    userId: string,
    deviceId: string,
    sessionId: string,
    text: string,
    uploadIds: string[] = [],
    selection: {
      agent?: string
      model?: { providerId: string; modelId: string }
      variant?: string
    } = {},
  ): string {
    this.assertDeviceAccess(userId, deviceId)
    const id = randomUUID()
    const now = Math.floor(Date.now() / 1_000)
    this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO pending_action (
          id, telegram_user_id, device_id, action, resource_id, payload_json,
          status, created_at, expires_at
        ) VALUES (?, ?, ?, 'session.prompt', ?, ?, 'pending', ?, ?)
      `).run(id, userId, deviceId, sessionId, JSON.stringify({ text, ...(uploadIds.length ? { uploadIds } : {}), ...selection }), now, now + 300)
      this.#database.prepare(`
        INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
        VALUES (?, 'action.proposed', ?, 'ask')
      `).run(Date.now(), userId)
    })()
    return id
  }

  createPendingSession(userId: string, deviceId: string, title?: string): string {
    this.assertDeviceAccess(userId, deviceId)
    const id = randomUUID()
    const now = Math.floor(Date.now() / 1_000)
    this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO pending_action (
          id, telegram_user_id, device_id, action, resource_id, payload_json,
          status, created_at, expires_at
        ) VALUES (?, ?, ?, 'session.create', 'configured-workspace', ?, 'pending', ?, ?)
      `).run(id, userId, deviceId, JSON.stringify({ ...(title ? { title } : {}) }), now, now + 300)
      this.#database.prepare(`
        INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
        VALUES (?, 'action.proposed', ?, 'ask')
      `).run(Date.now(), userId)
    })()
    return id
  }

  createPendingAbort(userId: string, deviceId: string, sessionId: string): string {
    this.assertDeviceAccess(userId, deviceId)
    const id = randomUUID()
    const now = Math.floor(Date.now() / 1_000)
    this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO pending_action (
          id, telegram_user_id, device_id, action, resource_id, payload_json,
          status, created_at, expires_at
        ) VALUES (?, ?, ?, 'session.abort', ?, '{}', 'pending', ?, ?)
      `).run(id, userId, deviceId, sessionId, now, now + 300)
      this.#database.prepare(`
        INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
        VALUES (?, 'action.proposed', ?, 'ask')
      `).run(Date.now(), userId)
    })()
    return id
  }

  createPendingDelete(userId: string, deviceId: string, sessionId: string): string {
    this.assertDeviceAccess(userId, deviceId)
    const id = randomUUID()
    const now = Math.floor(Date.now() / 1_000)
    this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO pending_action (
          id, telegram_user_id, device_id, action, resource_id, payload_json,
          status, created_at, expires_at
        ) VALUES (?, ?, ?, 'session.delete', ?, '{}', 'pending', ?, ?)
      `).run(id, userId, deviceId, sessionId, now, now + 300)
      this.#database.prepare(`
        INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
        VALUES (?, 'action.proposed', ?, 'ask')
      `).run(Date.now(), userId)
    })()
    return id
  }

  decidePendingAction(
    id: string,
    userId: string,
    deviceId: string,
    decision: "approve" | "deny",
    now = Math.floor(Date.now() / 1_000),
    sessionHash?: string,
  ):
    | { decision: "approved"; action: "session.create"; title?: string }
    | {
        decision: "approved"
        action: "session.prompt"
        sessionId: string
        text: string
        uploadIds?: string[]
        agent?: string
        model?: { providerId: string; modelId: string }
        variant?: string
      }
    | { decision: "approved"; action: "session.abort"; sessionId: string }
    | { decision: "approved"; action: "session.delete"; sessionId: string }
    | { decision: "approved"; action: "cache.cleanup" }
    | { decision: "approved"; action: "management"; mutation: ManagementMutation }
    | { decision: "approved"; action: "git"; mutation: GitMutation }
    | { decision: "denied" }
    | undefined {
    return this.#database.transaction(() => {
      if (this.securityState(userId).locked) return undefined
      if (sessionHash) {
        const session = this.sessionIdentity(sessionHash, now)
        if (!session || session.userId !== userId || session.deviceId !== deviceId) return undefined
      }
      const liveDevice = this.#database.prepare("SELECT 1 FROM trusted_device WHERE id=? AND telegram_user_id=? AND revoked_at IS NULL").get(deviceId, userId)
      if (!liveDevice) return undefined
      const action = this.#database.prepare(`
        SELECT action, resource_id AS sessionId, payload_json AS payload
        FROM pending_action
        WHERE id = ? AND telegram_user_id = ? AND device_id = ?
          AND action IN ('session.create', 'session.prompt', 'session.abort', 'session.delete', 'cache.cleanup', ${[...managementTypes, ...gitTypes].map(() => "?").join(",")})
          AND status = 'pending' AND frozen_at IS NULL AND expires_at >= ?
          AND (session_token_hash IS NULL AND action NOT IN (${[...managementTypes, ...gitTypes].map(() => "?").join(",")}) OR session_token_hash = ?)
      `).get(id, userId, deviceId, ...managementTypes, ...gitTypes, now, ...managementTypes, ...gitTypes, sessionHash ?? "") as {
        action: "session.create" | "session.prompt" | "session.abort" | "session.delete" | "cache.cleanup" | ManagementMutation["type"] | GitMutation["type"]
        sessionId: string
        payload: string
      } | undefined
      if (!action) return undefined
      const updated = this.#database.prepare(`
        UPDATE pending_action SET status = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(decision === "approve" ? "approved" : "denied", now, id)
      if (updated.changes !== 1) return undefined
      this.#database.prepare(`
        INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
        VALUES (?, 'action.decided', ?, ?)
      `).run(Date.now(), userId, decision)
      if (decision === "deny") return { decision: "denied" as const }
      if (isGitType(action.action)) return { decision: "approved" as const, action: "git" as const, mutation: normalizeGitMutation({ ...JSON.parse(action.payload), type: action.action }) }
      if (isManagementType(action.action)) return { decision: "approved" as const, action: "management" as const, mutation: normalizeManagementMutation({ ...JSON.parse(action.payload), type: action.action }) }
      if (action.action === "cache.cleanup") return { decision: "approved" as const, action: "cache.cleanup" as const }
      if (action.action === "session.create") {
        const payload = JSON.parse(action.payload) as { title?: string }
        return {
          decision: "approved" as const,
          action: "session.create" as const,
          ...(payload.title ? { title: payload.title } : {}),
        }
      }
      if (action.action === "session.abort") {
        return { decision: "approved" as const, action: "session.abort" as const, sessionId: action.sessionId }
      }
      if (action.action === "session.delete") {
        return { decision: "approved" as const, action: "session.delete" as const, sessionId: action.sessionId }
      }
      const payload = JSON.parse(action.payload) as {
        text: string
        uploadIds?: unknown
        agent?: unknown
        model?: unknown
        variant?: unknown
      }
      const uploadIds = Array.isArray(payload.uploadIds)
        ? payload.uploadIds.filter((id): id is string => typeof id === "string")
        : []
      return {
        decision: "approved" as const,
        action: "session.prompt" as const,
        sessionId: action.sessionId,
        text: payload.text,
        ...(uploadIds.length ? { uploadIds } : {}),
        ...(typeof payload.agent === "string" ? { agent: payload.agent } : {}),
        ...(payload.model && typeof payload.model === "object" ? { model: payload.model as { providerId: string; modelId: string } } : {}),
        ...(typeof payload.variant === "string" ? { variant: payload.variant } : {}),
      }
    })()
  }

  pendingActionRequiresPrivilege(id: string, actor: SecurityActor): boolean {
    const row = this.#database.prepare(`SELECT action FROM pending_action WHERE id=? AND telegram_user_id=? AND device_id=?`)
      .get(id, actor.userId, actor.deviceId) as { action: string } | undefined
    return Boolean(row && (isManagementType(row.action) || row.action === "session.delete" || row.action.startsWith("git.") || row.action.startsWith("integration.") || row.action.startsWith("provider.") || row.action.startsWith("security.")))
  }

  createPendingManagement(actor: SecurityActor, input: ManagementMutation, sessionHash: string, now = Math.floor(Date.now() / 1000)): string {
    this.assertDeviceAccess(actor.userId, actor.deviceId)
    const identity = /^[a-f0-9]{64}$/.test(sessionHash) ? this.sessionIdentity(sessionHash, now) : undefined
    if (!identity || identity.userId !== actor.userId || identity.deviceId !== actor.deviceId) throw new Error("Originating session unavailable")
    const mutation = normalizeManagementMutation(input)
    const id = randomUUID()
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO pending_action (id, telegram_user_id, device_id, action, resource_id, payload_json, status, created_at, expires_at, session_token_hash)
        VALUES (?, ?, ?, ?, 'opencode-management', ?, 'pending', ?, ?, ?)`)
        .run(id, actor.userId, actor.deviceId, mutation.type, JSON.stringify(mutation), now, Math.min(now + 300, identity.expiresAt), sessionHash)
      this.recordSecurityEvent(actor, mutation.type, "ask", "trusted-device", undefined, now)
    })()
    return id
  }

  createPendingGit(actor: SecurityActor, input: GitMutation, sessionHash: string, now = Math.floor(Date.now() / 1000)): string {
    this.assertDeviceAccess(actor.userId, actor.deviceId)
    const identity = /^[a-f0-9]{64}$/.test(sessionHash) ? this.sessionIdentity(sessionHash, now) : undefined
    if (!identity || identity.userId !== actor.userId || identity.deviceId !== actor.deviceId) throw new Error("Originating session unavailable")
    const mutation = normalizeGitMutation(input), id = randomUUID()
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO pending_action (id, telegram_user_id, device_id, action, resource_id, payload_json, status, created_at, expires_at, session_token_hash)
        VALUES (?, ?, ?, ?, 'workspace-vcs', ?, 'pending', ?, ?, ?)`)
        .run(id, actor.userId, actor.deviceId, mutation.type, JSON.stringify(mutation), now, Math.min(now + 300, identity.expiresAt), sessionHash)
      this.recordSecurityEvent(actor, mutation.type, "ask", "trusted-device", undefined, now)
    })()
    return id
  }

  recordActionExecution(userId: string, outcome: "executed" | "failed") {
    this.#database.prepare(`
      INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
      VALUES (?, 'action.executed', ?, ?)
    `).run(Date.now(), userId, outcome)
  }

  recordPermissionDecision(userId: string, outcome: "once" | "reject" | "failed") {
    this.#database.prepare(`
      INSERT INTO audit_event (created_at, event, telegram_user_id, outcome)
      VALUES (?, 'permission.decided', ?, ?)
    `).run(Date.now(), userId, outcome)
  }

  close() {
    this.#database.close()
  }
}

