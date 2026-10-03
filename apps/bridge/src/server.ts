import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequestHandler } from "./app.js"
import { AttachmentService } from "./attachments.js"
import {
  normalizeDeviceLabel,
  normalizeDevicePublicKey,
  verifyDeviceSignature,
} from "./auth/device.js"
import { TelegramAuthError, validateTelegramInitData } from "./auth/telegram.js"
import { readConfig } from "./config.js"
import {
  createCapabilitiesLoader,
  createAgentCatalogLoader,
  createEventLoader,
  createMessageLoader,
  createOpenCodeSession,
  createProviderCatalogLoader,
  createPermissionResponder,
  createPermissionLoader,
  createWorkspacePermissionLoader,
  createWorkspaceExecutionLoader,
  createPromptSender,
  createSessionAborter,
  createSessionDeleter,
  createSessionDiffLoader,
  createSessionTodoLoader,
  createSnapshotLoader,
  createUsageCollector,
  createVcsLoader,
  createVcsDiffLoader,
} from "./opencode.js"
import { decide } from "./policy.js"
import { BridgeStore } from "./storage/database.js"
import { SecurityBoundary } from "./security.js"
import { createLockEffects } from "./lock-effects.js"
import { createStaticHandler } from "./static.js"
import { createOpenCodeManagement, ManagementActions } from "./management.js"
import { GitService } from "./git.js"
import { runTelegramNotifications } from "./telegram-notifications.js"

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))
process.chdir(repositoryRoot)
if (existsSync(resolve(repositoryRoot, ".env"))) {
  process.loadEnvFile(resolve(repositoryRoot, ".env"))
}
const config = readConfig()
const store = new BridgeStore(config.databasePath)
store.deleteExpiredUploads()
const uploadCleanupTimer = setInterval(() => store.deleteExpiredUploads(), 5 * 60 * 1_000)
uploadCleanupTimer.unref()
const attachments = new AttachmentService(store, config.openCodeDirectory)
if (config.telegram) store.ensureAuthorizedUser(config.telegram.ownerId)
const lockPermissionResponder = createPermissionResponder(config)
const lockEffects = createLockEffects({
  loadActiveSessions: createWorkspaceExecutionLoader(config),
  loadPermissions: createWorkspacePermissionLoader(config),
  abortSession: createSessionAborter(config),
  rejectPermission: (id) => lockPermissionResponder(id, "reject"),
  audit: (actor, event, outcome) => store.recordSecurityEvent(actor, event, outcome, "trusted-device"),
})
const security = config.telegram ? new SecurityBoundary(store, config.telegram.ownerId, undefined, lockEffects) : undefined
const management = createOpenCodeManagement(config)
const managementActions = new ManagementActions(store, management)
const git = new GitService(store, config.openCodeDirectory, undefined, [config.openCodePassword, config.telegram?.botToken].filter((value): value is string => Boolean(value)))
const usage = createUsageCollector(config, (records) => {
  if (config.telegram) store.recordUsage(config.telegram.ownerId, config.openCodeDirectory, records)
})
if (config.telegram) void usage.sync()
const usageTimer = setInterval(() => { if (config.telegram) void usage.sync() }, 60_000)
usageTimer.unref()
const notificationController = new AbortController()
if (config.telegram) {
  void runTelegramNotifications(
    config.telegram,
    createEventLoader(config)(notificationController.signal, { userId: config.telegram.ownerId }),
    fetch,
    () => !store.securityState(config.telegram!.ownerId).locked,
  ).catch((error) => {
    if (!notificationController.signal.aborted) console.warn(JSON.stringify({ event: "telegram.notifications_failed", error: error instanceof Error ? error.message : "unknown" }))
  })
}
const authenticateTelegram = config.telegram
  ? (raw: string) => {
    try {
      return validateTelegramInitData(raw, config.telegram!)
    } catch (error) {
      const values = new URLSearchParams(raw)
      const authDate = Number(values.get("auth_date"))
      console.warn(JSON.stringify({
        event: "telegram.init_data_rejected",
        length: raw.length,
        fields: [...values.keys()].sort(),
        hasHash: Boolean(values.get("hash")),
        hasSignature: Boolean(values.get("signature")),
        authAgeSeconds: Number.isFinite(authDate) ? Math.floor(Date.now() / 1_000) - authDate : undefined,
      }))
      throw error
    }
  }
  : undefined
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const newSession = () => randomBytes(32).toString("base64url")
const sessionExpiresAt = () => Math.floor(Date.now() / 1_000) + 900

if (config.telegram) {
  if (!store.securityState(config.telegram.ownerId).locked && !store.hasActiveTrustedDevice(config.telegram.ownerId)) {
    const pairingCode = randomBytes(24).toString("base64url")
    store.replacePairingCode(hash(pairingCode), Math.floor(Date.now() / 1_000) + 900)
    console.log(`Local device pairing code (valid for 15 minutes): ${pairingCode}`)
  }
}

const pairDevice = config.telegram
  ? ({ initData, pairingCode, publicKey, label, proof }: {
      initData: string
      pairingCode: string
      publicKey: unknown
      label: unknown
      proof: unknown
    }) => {
    const identity = validateTelegramInitData(initData, config.telegram!)
    const normalizedPublicKey = normalizeDevicePublicKey(publicKey)
    const normalizedLabel = normalizeDeviceLabel(label)
    verifyDeviceSignature(normalizedPublicKey, `opencode-telegram:pair:${pairingCode}`, proof)
    const sessionToken = newSession()
    const deviceId = store.pairDevice(
      identity.userId,
      identity.replayKey,
      identity.authDate + 330,
      hash(pairingCode),
      normalizedPublicKey,
      normalizedLabel,
      hash(sessionToken),
      sessionExpiresAt(),
    )
    if (!deviceId) throw new TelegramAuthError()
    return { deviceId, sessionToken }
  }
  : undefined

const createChallenge = config.telegram
  ? ({ initData, deviceId }: { initData: string; deviceId: string }) => {
    const identity = validateTelegramInitData(initData, config.telegram!)
    security?.limitSensitive({ userId: identity.userId, deviceId }, "device-challenge", 15)
    const challenge = store.createDeviceChallenge(identity.userId, deviceId)
    if (!challenge) throw new TelegramAuthError()
    return { challengeId: challenge.id, nonce: challenge.nonce }
  }
  : undefined

const createSession = config.telegram
  ? ({ initData, deviceId, challengeId, signature }: {
      initData: string
      deviceId: string
      challengeId: string
      signature: unknown
    }) => {
    const identity = validateTelegramInitData(initData, config.telegram!)
    security?.limitSensitive({ userId: identity.userId, deviceId }, "device-verification", 15)
    const challenge = store.getDeviceChallenge(identity.userId, deviceId, challengeId)
    if (!challenge) throw new TelegramAuthError()
    verifyDeviceSignature(
      challenge.publicKeyJwk,
      `opencode-telegram:challenge:${challengeId}:${challenge.nonce}`,
      signature,
    )
    const token = newSession()
    if (!store.consumeChallengeAndCreateSession({
      userId: identity.userId,
      deviceId,
      challengeId,
      initDataHash: identity.replayKey,
      initDataExpiresAt: identity.authDate + 330,
      sessionTokenHash: hash(token),
      sessionExpiresAt: sessionExpiresAt(),
    })) throw new TelegramAuthError()
    return token
  }
  : undefined

const authorizeSession = config.telegram
  ? (token: string | undefined) => token && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? store.sessionIdentity(hash(token)) ?? false
    : false
  : undefined

const sendPrompt = createPromptSender(config)
const createRemoteSession = createOpenCodeSession(config)
const abortSession = createSessionAborter(config)
const deleteSession = createSessionDeleter(config)
const replyPermission = createPermissionResponder(config)
const proposeAction = config.telegram
  ? (input: { userId: string; deviceId: string } & (
      | { type: "session.create"; title?: string }
      | { type: "cache.cleanup" }
      | {
          type: "session.prompt"
          sessionId: string
          text: string
          uploadIds?: string[]
          agent?: string
          model?: { providerId: string; modelId: string }
          variant?: string
        }
      | { type: "session.abort"; sessionId: string }
      | { type: "session.delete"; sessionId: string }
    )) => {
    const { userId, deviceId } = input
    const { type } = input
    store.assertRemoteAccess(userId)
    if (decide(type) !== "ASK") throw new Error("Policy denied action")
    return {
      actionId: type === "cache.cleanup"
        ? store.createPendingCacheCleanup(userId, deviceId)
        : type === "session.create"
        ? store.createPendingSession(userId, deviceId, input.title)
        : type === "session.prompt"
          ? store.createPendingPrompt(userId, deviceId, input.sessionId, input.text, input.uploadIds, {
              ...(input.agent ? { agent: input.agent } : {}),
              ...(input.model ? { model: input.model } : {}),
              ...(input.variant ? { variant: input.variant } : {}),
            })
          : type === "session.abort"
            ? store.createPendingAbort(userId, deviceId, input.sessionId)
            : store.createPendingDelete(userId, deviceId, input.sessionId),
      decision: "ASK" as const,
    }
  }
  : undefined

const decideAction = config.telegram
  ? async ({ userId, deviceId, actionId, decision, sessionHash, revalidate }: {
      userId: string
      deviceId: string
      actionId: string
      decision: "approve" | "deny"
      sessionHash?: string
      revalidate?: () => void
    }) => {
    const guard = () => { store.assertDeviceAccess(userId, deviceId); revalidate?.() }
    guard()
    const action = store.decidePendingAction(actionId, userId, deviceId, decision, undefined, sessionHash)
    if (!action) throw new Error("Action unavailable")
    if (action.decision === "denied") { managementActions.discard(actionId); return { status: "denied" as const } }
    try {
      guard()
      if (action.action === "management") await managementActions.execute(actionId, { userId, deviceId, sessionHash: sessionHash! }, action.mutation, guard)
      if (action.action === "git") await git.execute({ userId, deviceId }, action.mutation, guard)
      if (action.action === "cache.cleanup") store.clearExpiredCache(userId)
      const session = action.action === "session.create"
        ? await createRemoteSession(action.title)
        : undefined
      if (action.action === "session.prompt") {
        const uploadIds = action.uploadIds ?? []
        const files = attachments.promptFiles(userId, uploadIds)
        guard()
        await sendPrompt(action.sessionId, action.text, files, {
          ...(action.agent ? { agent: action.agent } : {}),
          ...(action.model ? { model: action.model } : {}),
          ...(action.variant ? { variant: action.variant } : {}),
        }, guard)
        // A prompt dispatched just before lock may become visible upstream only
        // after its status snapshot; cancel it again before acknowledging.
        try { guard() } catch (error) { try { await abortSession(action.sessionId) } catch { store.recordSecurityEvent({ userId, deviceId }, "security.lock.abort", "failed", "trusted-device") }; throw error }
        if (uploadIds.length) attachments.consumeUploads(userId, uploadIds)
      }
      if (action.action === "session.abort") await abortSession(action.sessionId, guard)
      if (action.action === "session.delete") await deleteSession(action.sessionId, guard)
      store.recordActionExecution(userId, "executed")
      return {
        status: "executed" as const,
        ...(session ? { session } : {}),
        ...(action.action === "session.delete" ? { sessionId: action.sessionId } : {}),
      }
    } catch (error) {
      store.recordActionExecution(userId, "failed")
      throw error
    }
  }
  : undefined

const respondPermission = config.telegram
  ? async ({ userId, deviceId, requestId, reply, revalidate }: {
      userId: string
      deviceId: string
      requestId: string
      reply: "once" | "reject"
      revalidate?: () => void
    }) => {
    const guard = () => { store.assertDeviceAccess(userId, deviceId); revalidate?.() }
    guard()
    if (decide("opencode.permission") !== "ASK") throw new Error("Policy denied action")
    try {
      await replyPermission(requestId, reply, guard)
      store.recordPermissionDecision(userId, reply)
    } catch (error) {
      store.recordPermissionDecision(userId, "failed")
      throw error
    }
  }
  : undefined

const api = createRequestHandler({
  ...(security ? { security, requirePrivilege: security.requirePrivilege.bind(security), actionRequiresPrivilege: (id, actor) => store.pendingActionRequiresPrivilege(id, actor) } : {}),
  loadUsage: (userId, from, to) => ({ ...store.usage(userId, config.openCodeDirectory, from, to), collection: usage.status() }),
  loadCache: (userId) => store.cacheSummary(userId),
  loadSnapshot: createSnapshotLoader(config),
  loadCapabilities: createCapabilitiesLoader(Boolean(config.telegram), Boolean(config.telegram)),
  loadProviderCatalog: createProviderCatalogLoader(config),
  loadManagement: management.load,
  proposeManagement: (actor, input, guard) => managementActions.propose(actor, input, guard),
  loadAgentCatalog: createAgentCatalogLoader(config),
  loadVcs: createVcsLoader(config, () => git.read()),
  loadVcsDiff: createVcsDiffLoader(config),
  proposeGit: (actor, input, guard) => git.propose(actor, input, guard),
  loadArtifacts: (input) => store.listArtifacts(input.userId, input.category, input.cursor, input.limit),
  loadSessionDiff: createSessionDiffLoader(config),
  loadSessionTodos: createSessionTodoLoader(config),
  loadEvents: createEventLoader(config, (input) => attachments.register(input)),
  loadMessages: createMessageLoader(config, (input) => attachments.register(input)),
  loadAttachment: (input) => attachments.read(input.userId, input.attachmentId),
  loadStorageRoot: (input) => attachments.storageRoot(input.userId),
  loadStorageDirectory: (input) => attachments.listDirectory(
    input.userId,
    input.directoryId,
    input.cursor,
    input.limit,
  ),
  createUpload: (input) => attachments.createUpload(input.userId, input.filename, input.content),
  loadPermissions: createPermissionLoader(config),
  ...(authenticateTelegram ? { authenticateTelegram } : {}),
  ...(pairDevice ? { pairDevice } : {}),
  ...(createChallenge ? { createChallenge } : {}),
  ...(createSession ? { createSession } : {}),
  ...(authorizeSession ? { authorizeSession } : {}),
  ...(proposeAction ? { proposeAction } : {}),
  ...(decideAction ? { decideAction } : {}),
  ...(respondPermission ? { respondPermission } : {}),
  ...(config.telegram ? {
    listDevices: (userId: string) => store.listTrustedDevices(userId),
    loadAudit: (userId: string) => store.listAuditEvents(userId),
    revokeDevice: ({ userId, deviceId, targetDeviceId }: {
      userId: string
      deviceId: string
      targetDeviceId: string
    }) => store.revokeTrustedDevice(userId, targetDeviceId, deviceId),
  } : {}),
})
const serveStatic = createStaticHandler(resolve(repositoryRoot, "apps/mini-app/dist"))
const server = createServer(async (request, response) => {
  if (request.url === "/api/v1/auth/telegram") {
    response.once("finish", () => console.info(JSON.stringify({
      event: "telegram.auth_response",
      status: response.statusCode,
    })))
  }
  if (request.url?.startsWith("/api/")) return api(request, response)
  if (await serveStatic(request, response)) return
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
  response.end("Not found")
})

server.listen(config.bridgePort, config.bridgeHost, () => {
  console.log(`Bridge listening on http://${config.bridgeHost}:${config.bridgePort}`)
})

function shutdown() {
  managementActions.close()
  notificationController.abort()
  clearInterval(usageTimer)
  clearInterval(uploadCleanupTimer)
  server.close(() => {
    store.close()
    process.exit(0)
  })
  server.closeAllConnections()
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
