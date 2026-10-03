import type { IncomingMessage, ServerResponse } from "node:http"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { TelegramAuthError, type TelegramIdentity } from "./auth/telegram.js"
import { SecurityError, type SecurityBoundary } from "./security.js"
import { trustedClientIp } from "./auth/source.js"
import { normalizeManagementMutation, type ManagementMutation } from "./management-actions.js"
import type { ManagementCatalog } from "./management.js"
import { GitActionError, normalizeGitMutation, type GitMutation } from "./git-actions.js"
import type {
  ConversationMessage,
  AgentCatalog,
  NormalizedOpenCodeEvent,
  OpenCodeCapabilities,
  OpenCodeSnapshot,
  PendingPermission,
  ProviderCatalog,
  SessionDiff,
  SessionTodo,
} from "./opencode.js"

type SnapshotLoader = () => Promise<OpenCodeSnapshot>
type TelegramAuthenticator = (raw: string) => TelegramIdentity
type EventLoader = (signal: AbortSignal, actor?: AuthorizedSession) => AsyncIterable<NormalizedOpenCodeEvent>
type DevicePairer = (input: {
  initData: string
  pairingCode: string
  publicKey: unknown
  label: unknown
  proof: unknown
}) => { deviceId: string; sessionToken: string }
type ChallengeCreator = (input: { initData: string; deviceId: string }) => {
  challengeId: string
  nonce: string
}
type SessionCreator = (input: {
  initData: string
  deviceId: string
  challengeId: string
  signature: unknown
}) => string
export type AuthorizedSession = { expiresAt: number; userId: string; deviceId: string }
type SessionAuthorizer = (token: string | undefined) => AuthorizedSession | false
type MessageLoader = (sessionId: string, actor?: AuthorizedSession) => Promise<ConversationMessage[]>
type PermissionLoader = (sessionId: string) => Promise<PendingPermission[]>
type CapabilitiesLoader = () => Promise<OpenCodeCapabilities>
type ProviderCatalogLoader = () => Promise<ProviderCatalog>
type AgentCatalogLoader = () => Promise<AgentCatalog>
type SessionDiffLoader = (sessionId: string, messageId?: string) => Promise<SessionDiff[]>
type SessionTodoLoader = (sessionId: string) => Promise<SessionTodo[]>
type AttachmentLoader = (input: AuthorizedSession & { attachmentId: string }) => Promise<{
  name: string
  mime: string
  size: number
  disposition: "inline" | "attachment"
  content: Buffer
}>
type StorageRootLoader = (input: AuthorizedSession) => Promise<{ id: string; name: string }>
type StorageDirectoryLoader = (input: AuthorizedSession & {
  directoryId: string
  cursor: number
  limit: number
}) => Promise<unknown>
type UploadCreator = (input: AuthorizedSession & { filename: string; content: Buffer }) => unknown
type ActionProposer = (input: AuthorizedSession & (
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
  actionId: string
  decision: "ASK"
}
type ActionDecider = (input: AuthorizedSession & {
  sessionHash?: string
  actionId: string
  decision: "approve" | "deny"
  revalidate?: () => void
}) => Promise<{
  status: "executed" | "denied"
  session?: OpenCodeSnapshot["sessions"][number]
  sessionId?: string
}>
type PermissionResponder = (input: AuthorizedSession & {
  requestId: string
  reply: "once" | "reject"
  revalidate?: () => void
}) => Promise<void>
type DeviceLister = (userId: string) => Array<{
  id: string
  label: string
  createdAt: number
  lastSeenAt: number
}>
type DeviceRevoker = (input: AuthorizedSession & { targetDeviceId: string }) => boolean
type AuditLoader = (userId: string) => Array<{
  id: number
  createdAt: number
  event: string
  outcome: string
}>

export type RequestHandlerOptions = {
  loadSnapshot: SnapshotLoader
  authenticateTelegram?: TelegramAuthenticator
  loadEvents?: EventLoader
  pairDevice?: DevicePairer
  createChallenge?: ChallengeCreator
  createSession?: SessionCreator
  authorizeSession?: SessionAuthorizer
  loadMessages?: MessageLoader
  loadPermissions?: PermissionLoader
  loadCapabilities?: CapabilitiesLoader
  loadProviderCatalog?: ProviderCatalogLoader
  loadAgentCatalog?: AgentCatalogLoader
  loadManagement?: () => Promise<ManagementCatalog>
  proposeManagement?: (actor: AuthorizedSession & { sessionHash: string }, input: ManagementMutation & { key?: string }, revalidate: () => void) => Promise<{ actionId: string; decision: "ASK"; summary: ManagementMutation }>
  loadSessionDiff?: SessionDiffLoader
  loadSessionTodos?: SessionTodoLoader
  loadAttachment?: AttachmentLoader
  loadStorageRoot?: StorageRootLoader
  loadStorageDirectory?: StorageDirectoryLoader
  createUpload?: UploadCreator
  proposeAction?: ActionProposer
  decideAction?: ActionDecider
  respondPermission?: PermissionResponder
  listDevices?: DeviceLister
  revokeDevice?: DeviceRevoker
  loadAudit?: AuditLoader
  loadUsage?: (userId: string, from: number, to: number) => unknown
  loadCache?: (userId: string) => unknown
  loadVcs?: () => Promise<unknown>
  loadVcsDiff?: (mode: "git" | "branch") => Promise<unknown>
  loadArtifacts?: (input: AuthorizedSession & { category: "all" | "documents" | "images" | "code"; cursor: number; limit: number }) => Promise<unknown> | unknown
  proposeGit?: (actor: AuthorizedSession & { sessionHash: string }, input: GitMutation, guard: () => void) => Promise<{ actionId: string; decision: "ASK"; summary: GitMutation }>
  security?: SecurityBoundary
  requirePrivilege?: (actor: AuthorizedSession, sessionToken: string | undefined, privilegedToken: string | undefined) => void
  actionRequiresPrivilege?: (actionId: string, actor: AuthorizedSession) => boolean
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new Error("unsupported-media-type")
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16_384) throw new Error("payload-too-large")
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    throw new Error("invalid-json")
  }
}

async function readBinary(request: IncomingMessage, limit = 10 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > limit) throw new Error("payload-too-large"); chunks.push(buffer) }
  return Buffer.concat(chunks)
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  })
  response.end(JSON.stringify(body))
}

function cookieToken(request: IncomingMessage, cookieName: string): string | undefined {
  for (const cookie of request.headers.cookie?.split(";") ?? []) {
    const [name, ...value] = cookie.trim().split("=")
    if (name === cookieName) return value.join("=") || undefined
  }
}
export const sessionToken = (request: IncomingMessage) => cookieToken(request, "bridge_session")
export const privilegedToken = (request: IncomingMessage) => cookieToken(request, "bridge_privileged")

/** Invoke after every awaited request read, immediately before using an authenticated actor. */
export function reauthorizeRequest(options: RequestHandlerOptions, request: IncomingMessage, expected: AuthorizedSession): AuthorizedSession {
  const current = options.authorizeSession?.(sessionToken(request))
  if (!current || current.userId !== expected.userId || current.deviceId !== expected.deviceId) throw new SecurityError(401, "Unauthorized")
  return current
}

export function authorizeMutation(options: RequestHandlerOptions, request: IncomingMessage, expected: AuthorizedSession, scope: string, privilege = false, limit = 5) {
  const actor = reauthorizeRequest(options, request, expected)
  options.security?.limitSensitive(actor, scope, limit)
  if (privilege) {
    if (!options.requirePrivilege) throw new SecurityError(403, "Step-up authentication required")
    options.requirePrivilege(actor, sessionToken(request), privilegedToken(request))
  }
  return actor
}

function sessionCookie(token: string): string {
  return `bridge_session=${token}; Path=/api; Max-Age=900; HttpOnly; Secure; SameSite=Strict`
}

function safeDownloadName(value: string): string {
  return value.replace(/[\r\n"\\/]/g, "_").trim().slice(0, 255) || "attachment"
}

export function createRequestHandler(options: RequestHandlerOptions) {
  const {
    loadSnapshot,
    authenticateTelegram,
    loadEvents,
    pairDevice,
    createChallenge,
    createSession,
    authorizeSession,
    loadMessages,
    loadPermissions,
    loadCapabilities,
    loadProviderCatalog,
    loadAgentCatalog,
    loadSessionDiff,
    loadSessionTodos,
    loadAttachment,
    loadStorageRoot,
    loadStorageDirectory,
    createUpload,
    proposeAction,
    decideAction,
    respondPermission,
    listDevices,
    revokeDevice,
    loadAudit,
    loadVcs,
  } = options
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
    if (request.method === "GET" && request.url === "/api/v1/system/health") {
      return json(response, 200, { status: "ok" })
    }

    const managementRead = request.url?.match(/^\/api\/v1\/opencode\/(management|skills|mcp|plugins|providers|integrations)$/)
    if (request.method === "GET" && managementRead) {
      const actor = authorizeSession?.(sessionToken(request))
      if (!actor) return json(response, 401, { error: "Unauthorized" })
      if (!options.loadManagement) return json(response, 503, { error: "Management unavailable" })
      try {
        const catalog = await options.loadManagement()
        reauthorizeRequest(options, request, actor)
        const section = managementRead[1]
        return json(response, 200, section === "management" ? catalog : section === "skills" ? { skills: catalog.skills, sources: catalog.skillSources, mutability: catalog.mutability.skills } : section === "mcp" ? { mcpServers: catalog.mcpServers, mutability: catalog.mutability.mcp } : section === "plugins" ? { plugins: catalog.plugins, mutability: catalog.mutability.plugins } : section === "providers" ? { providers: catalog.providers, mutability: catalog.mutability.providers } : { integrations: catalog.integrations, mutability: catalog.mutability })
      } catch (error) {
        if (error instanceof SecurityError) throw error
        return json(response, 503, { error: "Management unavailable" })
      }
    }

    const managementWrite = request.url?.match(/^\/api\/v1\/opencode\/(skills|mcp|plugins|(?:providers|integrations)\/([a-zA-Z0-9._-]+))\/actions$/)
    if (request.method === "POST" && managementWrite) {
      const actor = authorizeSession?.(sessionToken(request))
      if (!actor) return json(response, 401, { error: "Unauthorized" })
      if (!options.proposeManagement) return json(response, 503, { error: "Management unavailable" })
      try {
        const body = await readBody(request) as Record<string, unknown> | null
        reauthorizeRequest(options, request, actor)
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid request")
        const operation = body.operation
        const section = managementWrite[1]!
        let draft: Record<string, unknown>
        let fields: string[]
        if (section === "skills" && (operation === "add" || operation === "remove")) {
          draft = { type: `skill.url.${operation}`, url: body.url }; fields = ["operation", "url"]
        } else if (section === "plugins" && (operation === "add" || operation === "remove")) {
          draft = { type: `plugin.${operation}`, package: body.package }; fields = ["operation", "package"]
        } else if (section === "mcp" && ["add", "connect", "disconnect", "disable", "remove"].includes(String(operation))) {
          draft = { type: operation === "add" ? "mcp.remote.add" : `mcp.${operation}`, name: body.name, ...(operation === "add" ? { url: body.url } : {}) }; fields = operation === "add" ? ["operation", "name", "url"] : ["operation", "name"]
        } else if (managementWrite[2] && (operation === "connect" || operation === "remove")) {
          draft = { type: operation === "connect" ? "provider.key.connect" : "provider.credential.remove", providerId: managementWrite[2] }; fields = operation === "connect" ? ["operation", "key"] : ["operation"]
        } else throw new Error("Invalid operation")
        if (Object.keys(body).some((field) => !fields.includes(field))) throw new Error("Invalid fields")
        const mutation = normalizeManagementMutation(draft)
        const guard = () => {
          reauthorizeRequest(options, request, actor)
          if (!options.requirePrivilege) throw new SecurityError(403, "Step-up authentication required")
          options.requirePrivilege(actor, sessionToken(request), privilegedToken(request))
        }
        authorizeMutation(options, request, actor, "opencode-management", true)
        if (mutation.type === "provider.key.connect" && typeof body.key !== "string") throw new Error("Invalid credential")
        const result = await options.proposeManagement({ ...actor, sessionHash: createHash("sha256").update(sessionToken(request)!).digest("hex") }, { ...mutation, ...(mutation.type === "provider.key.connect" ? { key: body.key as string } : {}) }, guard)
        return json(response, 202, result)
      } catch (error) {
        if (error instanceof SecurityError) throw error
        return json(response, 400, { error: "Invalid request" })
      }
    }

    if (request.url?.startsWith("/api/v1/security")) {
      if (!options.security) return json(response, 503, { error: "Security unavailable" })
      const security = options.security
      if (request.method === "POST" && request.url === "/api/v1/security/recovery/unlock") {
        const body = await readBody(request) as Record<string, unknown> | null
        if (!body || typeof body.recoveryKey !== "string" || body.recoveryKey.length > 128) return json(response, 400, { error: "Invalid request" })
        const recovered = await security.recover({ recoveryKey: body.recoveryKey, publicKey: body.publicKey, label: body.label, proof: body.proof })
        return json(response, 200, { status: "authorized", deviceId: recovered.deviceId }, { "set-cookie": sessionCookie(recovered.sessionToken) })
      }
      const token = sessionToken(request)
      const actor = authorizeSession?.(token)
      if (!actor || !token) return json(response, 401, { error: "Unauthorized" })
      if (request.method === "GET" && request.url === "/api/v1/security") {
        return json(response, 200, security.store.securityState(actor.userId))
      }
      if (request.method === "POST" && request.url === "/api/v1/security/recovery/setup") {
        return json(response, 201, await security.setupRecovery(actor, token))
      }
      if (request.method === "POST" && request.url === "/api/v1/security/step-up") {
        const body = await readBody(request) as Record<string, unknown> | null
        reauthorizeRequest(options, request, actor)
        if (!body || typeof body.recoveryKey !== "string" || body.recoveryKey.length > 128) return json(response, 400, { error: "Invalid request" })
        const elevated = await security.elevate(actor, token, body.recoveryKey)
        return json(response, 200, { expiresAt: elevated.expiresAt }, {
          "set-cookie": `bridge_privileged=${elevated.token}; Path=/api; Max-Age=300; HttpOnly; Secure; SameSite=Strict`,
        })
      }
      if (request.method === "POST" && (request.url === "/api/v1/security/lock" || request.url === "/api/v1/security/telegram-compromised")) {
        reauthorizeRequest(options, request, actor)
        const state = await security.lockRemoteAccess(actor, token, privilegedToken(request) ?? "", request.url.endsWith("telegram-compromised"))
        return json(response, 200, state, { "set-cookie": "bridge_session=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict" })
      }
      return json(response, 404, { error: "Not found" })
    }

    if (request.method === "GET" && request.url?.startsWith("/api/v1/usage?")) {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!options.loadUsage) return json(response, 503, { error: "Usage unavailable" })
      const period = new URL(request.url, "http://bridge.invalid").searchParams.get("period")
      if (!["today", "week", "month"].includes(period ?? "")) return json(response, 400, { error: "Invalid period" })
      const now = new Date(), from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (period === "week" ? 6 : period === "month" ? 29 : 0) * 86400000
      try { return json(response, 200, options.loadUsage(session.userId, from, now.getTime())) }
      catch { return json(response, 503, { error: "Usage unavailable" }) }
    }
    if (request.url === "/api/v1/storage/cache" && request.method === "GET") {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!options.loadCache) return json(response, 503, { error: "Cache unavailable" })
      return json(response, 200, options.loadCache(session.userId))
    }
    if (request.url === "/api/v1/storage/cache/actions" && request.method === "POST") {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!proposeAction) return json(response, 503, { error: "Actions unavailable" })
      try {
        const body = await readBody(request) as { type?: unknown }
        if (body?.type !== "cache.cleanup") return json(response, 400, { error: "Invalid action" })
        authorizeMutation(options, request, session, "proposal", false, 30)
        return json(response, 202, proposeAction({ ...session, type: "cache.cleanup" }))
      } catch (error) { if (error instanceof SecurityError) throw error; return json(response, 400, { error: "Invalid request" }) }
    }

    if (request.method === "GET" && request.url === "/api/v1/capabilities") {
      const session = authorizeSession?.(sessionToken(request))
      if (session === false) return json(response, 401, { error: "Unauthorized" })
      if (!loadCapabilities) return json(response, 503, { error: "Capabilities unavailable" })
      try {
        return json(response, 200, await loadCapabilities())
      } catch {
        return json(response, 503, { error: "OpenCode is unavailable" })
      }
    }

    if (request.method === "GET" && request.url === "/api/v1/opencode/catalog") {
      const session = authorizeSession?.(sessionToken(request))
      if (session === false) return json(response, 401, { error: "Unauthorized" })
      if (!loadProviderCatalog) return json(response, 503, { error: "Provider catalog unavailable" })
      try {
        return json(response, 200, await loadProviderCatalog())
      } catch {
        return json(response, 503, { error: "OpenCode is unavailable" })
      }
    }

    if (request.method === "GET" && request.url === "/api/v1/opencode/agents") {
      const session = authorizeSession?.(sessionToken(request))
      if (session === false) return json(response, 401, { error: "Unauthorized" })
      if (!loadAgentCatalog) return json(response, 503, { error: "Agent catalog unavailable" })
      try {
        return json(response, 200, await loadAgentCatalog())
      } catch {
        return json(response, 503, { error: "OpenCode is unavailable" })
      }
    }

    if (request.method === "GET" && request.url?.split("?")[0] === "/api/v1/artifacts") {
      const actor = authorizeSession?.(sessionToken(request))
      if (!actor) return json(response, 401, { error: "Unauthorized" })
      if (!options.loadArtifacts) return json(response, 503, { error: "Artifacts unavailable" })
      const query = new URL(request.url, "http://bridge").searchParams
      const category = query.get("category") ?? "all", cursor = query.get("cursor") ?? "0", limit = query.get("limit") ?? "50"
      if (!["all", "documents", "images", "code"].includes(category) || !/^\d{1,7}$/.test(cursor) || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || [...query.keys()].some((key) => !["category", "cursor", "limit"].includes(key))) return json(response, 400, { error: "Invalid request" })
      const result = await options.loadArtifacts({ ...actor, category: category as "all" | "documents" | "images" | "code", cursor: Number(cursor), limit: Number(limit) })
      reauthorizeRequest(options, request, actor)
      return json(response, 200, result)
    }

    if (request.method === "GET" && request.url?.split("?")[0] === "/api/v1/opencode/vcs/diff") {
      const actor = authorizeSession?.(sessionToken(request))
      if (!actor) return json(response, 401, { error: "Unauthorized" })
      if (!options.loadVcsDiff) return json(response, 503, { error: "VCS unavailable" })
      const query = new URL(request.url, "http://bridge").searchParams, mode = query.get("mode") ?? "git"
      if ((mode !== "git" && mode !== "branch") || [...query.keys()].some((key) => key !== "mode")) return json(response, 400, { error: "Invalid request" })
      try { const result = await options.loadVcsDiff(mode); reauthorizeRequest(options, request, actor); return json(response, 200, result) }
      catch (error) { if (error instanceof SecurityError) throw error; return json(response, 503, { error: "OpenCode is unavailable" }) }
    }

    if (request.method === "POST" && request.url === "/api/v1/opencode/vcs/actions") {
      const actor = authorizeSession?.(sessionToken(request))
      if (!actor) return json(response, 401, { error: "Unauthorized" })
      if (!options.proposeGit) return json(response, 503, { error: "Git actions unavailable" })
      try {
        const raw = await readBody(request)
        reauthorizeRequest(options, request, actor)
        const body = raw as Record<string, unknown>
        if (!body || typeof body.operation !== "string" || !["commit", "pull", "push"].includes(body.operation)) throw new Error("Invalid operation")
        const { operation, ...fields } = body
        const mutation = normalizeGitMutation({ type: `git.${operation}`, ...fields })
        // Reject a supplied type instead of letting it override the operation.
        if ("type" in fields) throw new Error("Invalid fields")
        authorizeMutation(options, request, actor, "git-proposal", true)
        const guard = () => { reauthorizeRequest(options, request, actor); options.requirePrivilege!(actor, sessionToken(request), privilegedToken(request)) }
        const result = await options.proposeGit({ ...actor, sessionHash: createHash("sha256").update(sessionToken(request)!).digest("hex") }, mutation, guard)
        guard()
        return json(response, 202, result)
      } catch (error) { if (error instanceof SecurityError) throw error; return json(response, 400, { error: "Invalid or unavailable Git action" }) }
    }

    if (request.method === "GET" && request.url === "/api/v1/opencode/vcs") {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!loadVcs) return json(response, 503, { error: "VCS unavailable" })
      try { const result = await loadVcs(); reauthorizeRequest(options, request, session); return json(response, 200, result) }
      catch (error) { if (error instanceof SecurityError) throw error; return json(response, 503, { error: "OpenCode is unavailable" }) }
    }

    if (request.method === "GET" && request.url === "/api/v1/opencode/snapshot") {
      if (authorizeSession && !authorizeSession(sessionToken(request))) {
        return json(response, 401, { error: "Unauthorized" })
      }
      try {
        return json(response, 200, await loadSnapshot())
      } catch {
        return json(response, 503, {
          online: false,
          error: "OpenCode is unavailable",
        })
      }
    }

    if (request.method === "GET" && request.url === "/api/v1/opencode/events") {
      const token = sessionToken(request)
      const authorizedUntil = authorizeSession?.(token)
      if (authorizedUntil === false) {
        return json(response, 401, { error: "Unauthorized" })
      }
      if (!loadEvents) return json(response, 503, { error: "Events unavailable" })
      response.writeHead(200, {
        "cache-control": "no-cache, no-store",
        "connection": "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      })
      response.flushHeaders()
      const controller = new AbortController()
      const expiryTimer = authorizedUntil === undefined
        ? undefined
        : setTimeout(() => controller.abort(), Math.max(0, authorizedUntil.expiresAt * 1_000 - Date.now()))
      const revocationTimer = authorizeSession ? setInterval(() => {
        if (!authorizeSession(token)) controller.abort()
      }, 1000) : undefined
      revocationTimer?.unref()
      request.once("close", () => controller.abort())
      try {
        for await (const event of loadEvents(
          controller.signal,
          authorizedUntil === undefined ? undefined : authorizedUntil,
        )) {
          // Device revocation must also terminate already-open streams. The
          // initial expiry timer alone would leave a revoked device connected.
          if (authorizeSession && !authorizeSession(token)) {
            controller.abort()
            break
          }
          if (!response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
            await once(response, "drain")
          }
        }
      } finally {
        if (expiryTimer) clearTimeout(expiryTimer)
        if (revocationTimer) clearInterval(revocationTimer)
        if (!response.destroyed) response.end()
      }
      return
    }

    if (request.method === "GET" && request.url === "/api/v1/devices") {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!listDevices) return json(response, 503, { error: "Devices unavailable" })
      return json(response, 200, {
        devices: listDevices(session.userId).map((device) => ({
          ...device,
          current: device.id === session.deviceId,
        })),
      })
    }

    if (request.method === "GET" && request.url === "/api/v1/audit") {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!loadAudit) return json(response, 503, { error: "Audit unavailable" })
      return json(response, 200, { events: loadAudit(session.userId) })
    }

    const attachmentRoute = request.url?.match(/^\/api\/v1\/attachments\/(att_[A-Za-z0-9_-]{32})(\/preview)?$/)
    if (request.method === "GET" && attachmentRoute) {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!loadAttachment) return json(response, 503, { error: "Attachments unavailable" })
      try {
        const attachment = await loadAttachment({ ...session, attachmentId: attachmentRoute[1]! })
        const preview = Boolean(attachmentRoute[2])
        if (preview && !attachment.mime.startsWith("text/html")) return json(response, 415, { error: "HTML preview required" })
        response.writeHead(200, {
          "cache-control": "private, no-store",
          "content-disposition": `${preview ? "inline" : attachment.disposition}; filename="${safeDownloadName(attachment.name)}"`,
          "content-length": String(attachment.content.length),
          "content-security-policy": preview
            ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; sandbox"
            : "default-src 'none'; sandbox",
          "content-type": attachment.mime,
          "cross-origin-resource-policy": "same-origin",
          "x-content-type-options": "nosniff",
          "x-frame-options": preview ? "SAMEORIGIN" : "DENY",
          "referrer-policy": "no-referrer",
          "permissions-policy": "camera=(), microphone=(), geolocation=()",
        })
        response.end(attachment.content)
        return
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error
          ? (error as { status?: unknown }).status
          : undefined
        const publicMessage = error && typeof error === "object" && "publicMessage" in error
          ? (error as { publicMessage?: unknown }).publicMessage
          : undefined
        if (status === 404 || status === 413 || status === 415 || status === 429) {
          return json(response, status, { error: typeof publicMessage === "string" ? publicMessage : "Attachment unavailable" })
        }
        return json(response, 503, { error: "Attachment unavailable" })
      }
    }

    if (request.method === "GET" && request.url === "/api/v1/storage/root") {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!loadStorageRoot) return json(response, 503, { error: "Storage unavailable" })
      try {
        return json(response, 200, { root: await loadStorageRoot(session) })
      } catch {
        return json(response, 503, { error: "Storage unavailable" })
      }
    }

    if (request.method === "POST" && request.url === "/api/v1/uploads") {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!createUpload) return json(response, 503, { error: "Uploads unavailable" })
      const encodedFilename = typeof request.headers["x-file-name"] === "string" ? request.headers["x-file-name"] : ""
      let filename = ""
      try { filename = decodeURIComponent(encodedFilename) } catch { return json(response, 400, { error: "Invalid filename" }) }
      if (!filename || filename.length > 255) return json(response, 400, { error: "Invalid filename" })
      try {
        const content = await readBinary(request)
        const actor = authorizeMutation(options, request, session, "upload", false, 30)
        return json(response, 201, { upload: createUpload({ ...actor, filename, content }) })
      } catch (error) {
        if (error instanceof SecurityError) throw error
        if (error instanceof Error && error.message === "payload-too-large") return json(response, 413, { error: "Attachment is too large" })
        const status = error && typeof error === "object" && "status" in error ? (error as { status?: unknown }).status : undefined
        if (status === 413 || status === 415 || status === 429) return json(response, status, { error: "Upload rejected" })
        return json(response, 400, { error: "Upload rejected" })
      }
    }

    const storageRoute = request.url?.match(/^\/api\/v1\/storage\/directories\/(dir_[A-Za-z0-9_-]{32})(?:\?.*)?$/)
    if (request.method === "GET" && storageRoute) {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!loadStorageDirectory) return json(response, 503, { error: "Storage unavailable" })
      try {
        const parsed = new URL(request.url!, "http://bridge.invalid")
        const cursor = Number(parsed.searchParams.get("cursor") ?? 0)
        const limit = Number(parsed.searchParams.get("limit") ?? 50)
        if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return json(response, 400, { error: "Invalid pagination" })
        }
        return json(response, 200, await loadStorageDirectory({
          ...session,
          directoryId: storageRoute[1]!,
          cursor,
          limit,
        }))
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error
          ? (error as { status?: unknown }).status
          : undefined
        if (status === 404 || status === 429) return json(response, status, { error: "Directory unavailable" })
        return json(response, 503, { error: "Storage unavailable" })
      }
    }

    const deviceRoute = request.url?.match(/^\/api\/v1\/devices\/([^/]+)$/)
    if (request.method === "DELETE" && deviceRoute) {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!revokeDevice) return json(response, 503, { error: "Devices unavailable" })
      let targetDeviceId: string
      try {
        targetDeviceId = decodeURIComponent(deviceRoute[1]!)
      } catch {
        return json(response, 400, { error: "Invalid request" })
      }
      authorizeMutation(options, request, session, "device-revoke", true)
      return revokeDevice({ ...session, targetDeviceId })
        ? json(response, 200, { status: "revoked" })
        : json(response, 409, { error: "Device unavailable" })
    }

    if (request.method === "POST" && request.url === "/api/v1/auth/telegram") {
      if (authorizeSession?.(sessionToken(request)) !== false && authorizeSession) {
        return json(response, 200, { status: "authorized" })
      }
      if (!authenticateTelegram) return json(response, 503, { error: "Authentication unavailable" })
      options.security?.limitSource(trustedClientIp(request.socket.remoteAddress, request.headers["cf-connecting-ip"]), "telegram")
      try {
        const body = await readBody(request)
        if (!body || typeof body !== "object" || typeof (body as { initData?: unknown }).initData !== "string") {
          return json(response, 400, { error: "Invalid request" })
        }
        authenticateTelegram((body as { initData: string }).initData)
        return json(response, 202, { status: "device_verification_required" })
      } catch (error) {
        if (error instanceof SecurityError) throw error
        if (error instanceof TelegramAuthError) return json(response, 401, { error: "Unauthorized" })
        if (error instanceof Error && error.message === "payload-too-large") {
          return json(response, 413, { error: "Payload too large" })
        }
        if (error instanceof Error && error.message === "unsupported-media-type") {
          return json(response, 415, { error: "Unsupported media type" })
        }
        return json(response, 400, { error: "Invalid request" })
      }
    }

    if (request.method === "POST" && request.url === "/api/v1/devices/pair") {
      if (!pairDevice) return json(response, 503, { error: "Pairing unavailable" })
      options.security?.limitSource(trustedClientIp(request.socket.remoteAddress, request.headers["cf-connecting-ip"]), "pairing")
      try {
        const body = await readBody(request)
        if (!body || typeof body !== "object") return json(response, 400, { error: "Invalid request" })
        const input = body as Record<string, unknown>
        if (typeof input.initData !== "string" || typeof input.pairingCode !== "string") {
          return json(response, 400, { error: "Invalid request" })
        }
        const deviceId = pairDevice({
          initData: input.initData,
          pairingCode: input.pairingCode,
          publicKey: input.publicKey,
          label: input.label,
          proof: input.proof,
        })
        return json(
          response,
          201,
          { status: "authorized", deviceId: deviceId.deviceId },
          { "set-cookie": sessionCookie(deviceId.sessionToken) },
        )
      } catch (error) {
        if (error instanceof SecurityError) throw error
        if (error instanceof TelegramAuthError) return json(response, 401, { error: "Unauthorized" })
        if (error instanceof Error && error.message === "payload-too-large") {
          return json(response, 413, { error: "Payload too large" })
        }
        return json(response, 400, { error: "Invalid request" })
      }
    }

    if (request.method === "POST" && request.url === "/api/v1/auth/challenge") {
      if (!createChallenge) return json(response, 503, { error: "Authentication unavailable" })
      options.security?.limitSource(trustedClientIp(request.socket.remoteAddress, request.headers["cf-connecting-ip"]), "challenge")
      try {
        const body = await readBody(request)
        if (!body || typeof body !== "object") return json(response, 400, { error: "Invalid request" })
        const input = body as Record<string, unknown>
        if (typeof input.initData !== "string" || typeof input.deviceId !== "string") {
          return json(response, 400, { error: "Invalid request" })
        }
        return json(response, 200, createChallenge({
          initData: input.initData,
          deviceId: input.deviceId,
        }))
      } catch (error) {
        if (error instanceof SecurityError) throw error
        if (error instanceof TelegramAuthError) return json(response, 401, { error: "Unauthorized" })
        return json(response, 400, { error: "Invalid request" })
      }
    }

    if (request.method === "POST" && request.url === "/api/v1/auth/session") {
      if (!createSession) return json(response, 503, { error: "Authentication unavailable" })
      options.security?.limitSource(trustedClientIp(request.socket.remoteAddress, request.headers["cf-connecting-ip"]), "session")
      try {
        const body = await readBody(request)
        if (!body || typeof body !== "object") return json(response, 400, { error: "Invalid request" })
        const input = body as Record<string, unknown>
        if (
          typeof input.initData !== "string" ||
          typeof input.deviceId !== "string" ||
          typeof input.challengeId !== "string"
        ) return json(response, 400, { error: "Invalid request" })
        const token = createSession({
          initData: input.initData,
          deviceId: input.deviceId,
          challengeId: input.challengeId,
          signature: input.signature,
        })
        return json(
          response,
          200,
          { status: "authorized" },
          { "set-cookie": sessionCookie(token) },
        )
      } catch (error) {
        if (error instanceof SecurityError) throw error
        if (error instanceof TelegramAuthError) return json(response, 401, { error: "Unauthorized" })
        return json(response, 400, { error: "Invalid request" })
      }
    }

    if (request.method === "POST" && request.url === "/api/v1/sessions/actions") {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!proposeAction) return json(response, 503, { error: "Actions unavailable" })
      try {
        const body = await readBody(request)
        const input = body as Record<string, unknown>
        if (!body || typeof body !== "object" || input.type !== "session.create") {
          return json(response, 400, { error: "Invalid request" })
        }
        const title = typeof input.title === "string" ? input.title.trim() : undefined
        if (title && title.length > 120) return json(response, 400, { error: "Invalid request" })
        authorizeMutation(options, request, session, "proposal", false, 30)
        return json(response, 202, {
          ...proposeAction({ ...session, type: "session.create", ...(title ? { title } : {}) }),
          summary: { type: "session.create", ...(title ? { title } : {}) },
        })
      } catch (error) {
        if (error instanceof SecurityError) throw error
        if (error instanceof Error && error.message === "payload-too-large") {
          return json(response, 413, { error: "Payload too large" })
        }
        return json(response, 400, { error: "Invalid request" })
      }
    }

    const messagesRoute = request.url?.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/)
    if (request.method === "GET" && messagesRoute) {
      const session = authorizeSession?.(sessionToken(request))
      if (session === false) return json(response, 401, { error: "Unauthorized" })
      if (!loadMessages) return json(response, 503, { error: "Messages unavailable" })
      try {
        const sessionId = decodeURIComponent(messagesRoute[1]!)
        const [messages, permissions, todos] = await Promise.all([
          loadMessages(sessionId, session),
          loadPermissions?.(sessionId) ?? [],
          loadSessionTodos?.(sessionId) ?? [],
        ])
        return json(response, 200, { messages, permissions, todos })
      } catch {
        return json(response, 503, { error: "OpenCode is unavailable" })
      }
    }

    const diffRoute = request.url?.match(/^\/api\/v1\/sessions\/([^/?]+)\/diff(?:\?.*)?$/)
    if (request.method === "GET" && diffRoute) {
      const session = authorizeSession?.(sessionToken(request))
      if (session === false) return json(response, 401, { error: "Unauthorized" })
      if (!loadSessionDiff) return json(response, 503, { error: "Session diff unavailable" })
      try {
        const sessionId = decodeURIComponent(diffRoute[1]!)
        const parsed = new URL(request.url!, "http://bridge.invalid")
        const messageId = parsed.searchParams.get("messageId")?.trim()
        if (messageId && messageId.length > 200) return json(response, 400, { error: "Invalid request" })
        return json(response, 200, {
          sessionId,
          diff: await loadSessionDiff(sessionId, messageId || undefined),
        })
      } catch {
        return json(response, 503, { error: "OpenCode is unavailable" })
      }
    }

    const proposeRoute = request.url?.match(/^\/api\/v1\/sessions\/([^/]+)\/actions$/)
    if (request.method === "POST" && proposeRoute) {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!proposeAction) return json(response, 503, { error: "Actions unavailable" })
      try {
        const body = await readBody(request)
        const input = body as Record<string, unknown>
        if (
          !body ||
          typeof body !== "object" ||
          (input.type !== "session.prompt" && input.type !== "session.abort" && input.type !== "session.delete")
        ) {
          return json(response, 400, { error: "Invalid request" })
        }
        const text = typeof input.text === "string" ? input.text.trim() : ""
        const uploadIds = input.uploadIds === undefined
          ? []
          : Array.isArray(input.uploadIds) && input.uploadIds.every((id): id is string => typeof id === "string")
            ? input.uploadIds
            : undefined
        const validUploads = uploadIds !== undefined && uploadIds.length <= 4 &&
          new Set(uploadIds).size === uploadIds.length &&
          uploadIds.every((id) => /^upl_[A-Za-z0-9_-]{32}$/.test(id))
        const agent = typeof input.agent === "string" ? input.agent.trim() : undefined
        const variant = typeof input.variant === "string" ? input.variant.trim() : undefined
        const rawModel = input.model && typeof input.model === "object" ? input.model as Record<string, unknown> : undefined
        const model = rawModel && typeof rawModel.providerId === "string" && typeof rawModel.modelId === "string"
          ? { providerId: rawModel.providerId.trim(), modelId: rawModel.modelId.trim() }
          : undefined
        const validSelection =
          (input.agent === undefined || Boolean(agent && agent.length <= 100 && !/[\u0000-\u001f]/.test(agent))) &&
          (input.variant === undefined || Boolean(variant && variant.length <= 50 && /^[A-Za-z0-9_.-]+$/.test(variant))) &&
          (input.model === undefined || Boolean(model && model.providerId && model.providerId.length <= 200 && model.modelId && model.modelId.length <= 200)) &&
          (!variant || Boolean(model))
        if (input.type !== "session.prompt" && (input.uploadIds !== undefined || input.agent !== undefined || input.model !== undefined || input.variant !== undefined)) {
          return json(response, 400, { error: "Invalid request" })
        }
        if (input.type === "session.prompt" && ((!text && !uploadIds?.length) || text.length > 8_000 || !validUploads || !validSelection)) {
          return json(response, 400, { error: "Invalid request" })
        }
        const sessionId = decodeURIComponent(proposeRoute[1]!)
        authorizeMutation(options, request, session, input.type === "session.delete" ? "delete-proposal" : "proposal", input.type === "session.delete", input.type === "session.delete" ? 5 : 30)
        const proposal = input.type === "session.prompt"
          ? proposeAction({
              ...session,
              sessionId,
              type: "session.prompt",
              text,
              ...(uploadIds?.length ? { uploadIds } : {}),
              ...(agent ? { agent } : {}),
              ...(model ? { model } : {}),
              ...(variant ? { variant } : {}),
            })
          : input.type === "session.abort"
            ? proposeAction({ ...session, sessionId, type: "session.abort" })
            : proposeAction({ ...session, sessionId, type: "session.delete" })
        return json(response, 202, {
          ...proposal,
          summary: {
            type: input.type,
            ...(text ? { text } : {}),
            ...(uploadIds?.length ? { attachments: uploadIds.length } : {}),
            ...(agent ? { agent } : {}),
            ...(model ? { model } : {}),
            ...(variant ? { variant } : {}),
          },
        })
      } catch (error) {
        if (error instanceof SecurityError) throw error
        if (error instanceof Error && error.message === "payload-too-large") {
          return json(response, 413, { error: "Payload too large" })
        }
        return json(response, 400, { error: "Invalid request" })
      }
    }

    const decisionRoute = request.url?.match(/^\/api\/v1\/actions\/([^/]+)\/decision$/)
    if (request.method === "POST" && decisionRoute) {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!decideAction) return json(response, 503, { error: "Actions unavailable" })
      try {
        const body = await readBody(request)
        const decision = (body as { decision?: unknown } | undefined)?.decision
        if (decision !== "approve" && decision !== "deny") {
          return json(response, 400, { error: "Invalid request" })
        }
        const actionId = decodeURIComponent(decisionRoute[1]!)
        reauthorizeRequest(options, request, session)
        const sensitive = Boolean(options.actionRequiresPrivilege?.(actionId, session))
        authorizeMutation(options, request, session, sensitive ? "sensitive-decision" : "decision", sensitive && decision === "approve", sensitive ? 5 : 20)
        return json(response, 200, await decideAction({
          ...session,
          actionId,
          decision,
          sessionHash: createHash("sha256").update(sessionToken(request)!).digest("hex"),
          revalidate: () => {
            reauthorizeRequest(options, request, session)
            if (sensitive && decision === "approve") options.requirePrivilege?.(session, sessionToken(request), privilegedToken(request))
          },
        }))
      } catch (error) {
        if (error instanceof SecurityError) throw error
        if (error instanceof GitActionError) return json(response, 409, { error: error.message, stagingMayHaveChanged: error.stagingMayHaveChanged })
        return json(response, 409, { error: "Action unavailable" })
      }
    }

    const permissionRoute = request.url?.match(/^\/api\/v1\/permissions\/([^/]+)\/reply$/)
    if (request.method === "POST" && permissionRoute) {
      const session = authorizeSession?.(sessionToken(request))
      if (!session) return json(response, 401, { error: "Unauthorized" })
      if (!respondPermission) return json(response, 503, { error: "Permissions unavailable" })
      try {
        const body = await readBody(request)
        const reply = (body as { reply?: unknown } | undefined)?.reply
        if (reply !== "once" && reply !== "reject") {
          return json(response, 400, { error: "Invalid request" })
        }
        authorizeMutation(options, request, session, reply === "once" ? "permission-once" : "permission-reject", reply === "once", reply === "once" ? 5 : 20)
        await respondPermission({
          ...session,
          requestId: decodeURIComponent(permissionRoute[1]!),
          reply,
          revalidate: () => {
            reauthorizeRequest(options, request, session)
            if (reply === "once") options.requirePrivilege?.(session, sessionToken(request), privilegedToken(request))
          },
        })
        return json(response, 200, { status: "resolved" })
      } catch (error) {
        if (error instanceof SecurityError) throw error
        return json(response, 409, { error: "Permission unavailable" })
      }
    }

    return json(response, 404, { error: "Not found" })
    } catch (error) {
      if (error instanceof SecurityError) return json(response, error.status, { error: error.publicMessage }, error.retryAfter ? { "retry-after": String(error.retryAfter) } : {})
      if (error instanceof Error && error.message === "payload-too-large") return json(response, 413, { error: "Payload too large" })
      return json(response, 400, { error: "Invalid request" })
    }
  }
}

