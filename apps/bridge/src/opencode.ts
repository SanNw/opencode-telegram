import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { Event, Part, Project, Session, SnapshotFileDiff } from "@opencode-ai/sdk/v2/client"
import { basename, isAbsolute, relative, resolve } from "node:path"
import type { BridgeConfig } from "./config.js"
import { redactText } from "./redact.js"
import type { UsageRecord } from "./storage/database.js"

export function createUsageCollector(config: BridgeConfig, save: (records: UsageRecord[]) => void) {
  const client = createClient(config)
  const seen = new Map<string, number>()
  let running = false
  let lastSyncedAt: string | undefined
  let failed = false
  return {
    status: () => ({ running, failed, lastSyncedAt: lastSyncedAt ?? null }),
    async sync() {
      if (running) return
      running = true
      try {
        const sessions = await client.session.list({ directory: config.openCodeDirectory }, { signal: AbortSignal.timeout(15_000) })
        if (!sessions.data) throw new Error("Usage sessions unavailable")
        for (const session of sessions.data) {
          if (resolve(session.directory) !== resolve(config.openCodeDirectory) || seen.get(session.id) === session.time.updated) continue
          const response = await client.session.messages({ sessionID: session.id, directory: config.openCodeDirectory }, { signal: AbortSignal.timeout(30_000) })
          if (!response.data) throw new Error("Usage messages unavailable")
          const records = response.data.flatMap(({ info }): UsageRecord[] => info.role === "assistant" && info.time.completed ? [{
            id: info.id, sessionId: session.id, projectId: session.projectID, createdAt: info.time.created,
            provider: info.providerID, model: info.modelID, agent: info.agent,
            input: info.tokens.input, output: info.tokens.output, reasoning: info.tokens.reasoning,
            cacheRead: info.tokens.cache.read, cacheWrite: info.tokens.cache.write, cost: info.cost,
          }] : [])
          save(records)
          if (response.data.every(({ info }) => info.role !== "assistant" || Boolean(info.time.completed))) seen.set(session.id, session.time.updated)
        }
        lastSyncedAt = new Date().toISOString()
        failed = false
      } catch { failed = true } finally { running = false }
    },
  }
}

export type OpenCodeSnapshot = {
  statuses?: Record<string, "idle" | "busy" | "retry">
  online: true
  version: string
  syncedAt: string
  projects: Array<{
    id: string
    name?: string
    worktree: string
    updatedAt: number
  }>
  sessions: Array<{
    id: string
    projectId: string
    parentId?: string
    title: string
    directory: string
    agent?: string
    model?: { id: string; providerId: string; variant?: string }
    summary?: SessionSummary
    cost?: number
    tokens?: TokenUsage
    updatedAt: number
  }>
}

export type TokenUsage = {
  total?: number
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type SessionDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export type SessionTodo = {
  content: string
  status: string
  priority: string
}

export type SessionSummary = {
  additions: number
  deletions: number
  files: number
  diffs?: SessionDiff[]
}

export type CapabilityState =
  | { status: "available"; mode?: string }
  | { status: "disabled"; reason: string }
  | { status: "unsupported"; reason: string }

export type OpenCodeCapabilities = {
  version: 1
  capabilities: {
    messageHistory: CapabilityState
    structuredParts: CapabilityState
    tools: CapabilityState
    agents: CapabilityState
    skills: CapabilityState
    mcp: CapabilityState
    plugins: CapabilityState
    diffs: CapabilityState
    files: CapabilityState
    images: CapabilityState
    models: CapabilityState
    providers: CapabilityState
    tokens: CapabilityState
    costs: CapabilityState
    storage: CapabilityState
    streaming: CapabilityState
    htmlPreview: CapabilityState
    git: CapabilityState
  }
}

export type ProviderCatalog = {
  providers: Array<{
    id: string
    name: string
    connected: boolean
    defaultModelId?: string
    models: Array<{
      id: string
      name: string
      family?: string
      status: "alpha" | "beta" | "deprecated" | "active"
      capabilities: {
        reasoning: boolean
        attachments: boolean
        tools: boolean
        input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
        output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
      }
      limits: { context: number; input?: number; output: number }
      variants: string[]
    }>
  }>
  skills?: Array<{ name: string; description?: string }>
  mcpServers?: Array<{
    name: string
    status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"
  }>
  plugins?: Array<{ name: string }>
}

export type AgentCatalog = {
  agents: Array<{
    name: string
    description?: string
    mode: "subagent" | "primary" | "all"
    color?: string
    native: boolean
    model?: { id: string; providerId: string }
    variant?: string
  }>
}

export type NormalizedOpenCodeEvent =
  | { type: "system.online"; at: string }
  | { type: "system.offline"; at: string }
  | { type: "system.heartbeat"; at: string }
  | { type: "session.updated"; session: OpenCodeSnapshot["sessions"][number] }
  | { type: "session.deleted"; sessionId: string }
  | { type: "session.idle"; sessionId: string }
  | { type: "session.error"; sessionId?: string }
  | { type: "session.status"; sessionId: string; status: "idle" | "busy" | "retry" }
  | {
      type: "message.started"
      sessionId: string
      message: {
        id: string
        role: "user" | "assistant"
        createdAt: number
        completedAt?: number
        providerId?: string
        modelId?: string
        agent?: string
        cost?: number
        tokens?: TokenUsage
      }
    }
  | { type: "message.text"; sessionId: string; messageId: string; partId: string; text: string }
  | { type: "message.delta"; sessionId: string; messageId: string; partId: string; delta: string }
  | {
      type: "message.reasoning"
      sessionId: string
      messageId: string
      partId: string
      status: "completed"
      startedAt: number
      completedAt: number
    }
  | { type: "message.file"; sessionId: string; messageId: string; part: SafeFilePart }
  | {
      type: "tool.updated"
      sessionId: string
      messageId: string
      callId: string
      tool: string
      status: "pending" | "running" | "completed" | "error"
      title?: string
      startedAt?: number
      completedAt?: number
    }
  | { type: "session.diff"; sessionId: string; diff: SessionDiff[] }
  | { type: "file.edited"; file: string }
  | {
      type: "permission.requested"
      sessionId: string
      requestId: string
      action: string
      resources: string[]
    }
  | { type: "permission.resolved"; sessionId: string; requestId: string }

export type ConversationMessage = {
  id: string
  role: "user" | "assistant"
  createdAt: number
  text: string
  parts: Record<string, string>
  content: ConversationPart[]
  completedAt?: number
  providerId?: string
  modelId?: string
  agent?: string
  cost?: number
  tokens?: TokenUsage
  summary?: { title?: string; body?: string; diffs: SessionDiff[] }
}

export type SafeFilePart = {
  id: string
  type: "file"
  mime: string
  filename?: string
  source?: { type: "file" | "symbol" | "resource"; label: string }
  attachmentId?: string
  size?: number
  preview?: "image" | "text" | "download"
}

export type FileRegistrar = (input: {
  userId: string
  sessionId: string
  sourcePath: string
  dataUrl?: string
  filename?: string
}) => Promise<{
  attachmentId: string
  name: string
  mime: string
  size: number
  preview: "image" | "text" | "download"
} | undefined>

export type ConversationPart =
  | { id: string; type: "text"; text: string; synthetic?: boolean }
  | { id: string; type: "reasoning"; status: "running" | "completed"; startedAt?: number; completedAt?: number }
  | SafeFilePart
  | {
      id: string
      type: "tool"
      callId: string
      tool: string
      status: "pending" | "running" | "completed" | "error"
      title?: string
      startedAt?: number
      completedAt?: number
    }

export type PendingPermission = {
  requestId: string
  sessionId: string
  action: string
  resources: string[]
}

function safeMetric(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function portableBasename(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? ""
}

function mapProject(project: Project): OpenCodeSnapshot["projects"][number] {
  return {
    id: project.id,
    worktree: portableBasename(project.worktree),
    updatedAt: project.time.updated,
    ...(project.name ? { name: project.name } : {}),
  }
}

function mapSession(
  session: Session,
  knownSecrets: readonly string[] = [],
  workspace?: string,
): OpenCodeSnapshot["sessions"][number] {
  return {
    id: session.id,
    projectId: session.projectID,
    title: session.title,
    directory: safePath(session.directory, workspace),
    updatedAt: session.time.updated,
    ...(session.parentID ? { parentId: session.parentID } : {}),
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.summary ? { summary: mapSummary(session.summary, knownSecrets, workspace) } : {}),
    ...(typeof session.cost === "number" ? { cost: safeMetric(session.cost) } : {}),
    ...(session.tokens ? { tokens: mapTokens(session.tokens) } : {}),
    ...(session.model ? {
      model: {
        id: session.model.id,
        providerId: session.model.providerID,
        ...(session.model.variant ? { variant: session.model.variant } : {}),
      },
    } : {}),
  }
}

function mapTokens(tokens: TokenUsage): TokenUsage {
  return {
    ...(typeof tokens.total === "number" ? { total: safeMetric(tokens.total) } : {}),
    input: safeMetric(tokens.input),
    output: safeMetric(tokens.output),
    reasoning: safeMetric(tokens.reasoning),
    cache: { read: safeMetric(tokens.cache.read), write: safeMetric(tokens.cache.write) },
  }
}

function safePath(path: string, workspace?: string): string {
  const normalized = path.replaceAll("\\", "/")
  const windowsAbsolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
  if (windowsAbsolute) return portableBasename(normalized)
  if (!workspace || !isAbsolute(path)) {
    if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return basename(normalized)
    return normalized.replace(/^\.\//, "")
  }
  const candidate = relative(workspace, path)
  if (!candidate.startsWith("..") && !isAbsolute(candidate)) return candidate ? candidate.replaceAll("\\", "/") : "."
  return basename(path)
}

function safeResource(value: string, knownSecrets: readonly string[]): string {
  return redactText(value, knownSecrets).slice(0, 512)
}

function mapDiff(diff: SnapshotFileDiff, knownSecrets: readonly string[] = [], workspace?: string): SessionDiff {
  const safePatch = diff.patch
    ? redactText(diff.patch, knownSecrets).split("\n", 5_001).slice(0, 5_000).join("\n").slice(0, 262_144)
    : undefined
  return {
    ...(diff.file ? { file: safePath(diff.file, workspace) } : {}),
    ...(safePatch ? { patch: safePatch } : {}),
    additions: safeMetric(diff.additions),
    deletions: safeMetric(diff.deletions),
    ...(diff.status ? { status: diff.status } : {}),
  }
}

function mapSummary(summary: NonNullable<Session["summary"]>, knownSecrets: readonly string[] = [], workspace?: string): SessionSummary {
  return {
    additions: safeMetric(summary.additions),
    deletions: safeMetric(summary.deletions),
    files: safeMetric(summary.files),
    ...(summary.diffs ? { diffs: summary.diffs.slice(0, 200).map((diff) => mapDiff(diff, knownSecrets, workspace)) } : {}),
  }
}

function mapFilePart(
  part: Extract<Part, { type: "file" }>,
  workspace?: string,
  knownSecrets: readonly string[] = [],
): SafeFilePart {
  const source = part.source
    ? {
        type: part.source.type,
        label: redactText(part.source.type === "resource"
          ? part.source.clientName
          : safePath(part.source.path, workspace), knownSecrets).slice(0, 512),
      }
    : undefined
  return {
    id: part.id,
    type: "file",
    mime: part.mime.slice(0, 128),
    ...(part.filename ? { filename: redactText(portableBasename(part.filename), knownSecrets).slice(0, 255) } : {}),
    ...(source ? { source } : {}),
  }
}

async function mapRegisteredFilePart(
  part: Extract<Part, { type: "file" }>,
  workspace: string,
  knownSecrets: readonly string[],
  userId: string | undefined,
  registerFile: FileRegistrar | undefined,
): Promise<SafeFilePart> {
  const safe = mapFilePart(part, workspace, knownSecrets)
  if (!userId || !registerFile) return safe
  const inlineImage = part.url?.startsWith("data:image/")
  if (!inlineImage && (!part.source || part.source.type === "resource")) return safe
  const registered = await registerFile({
    userId,
    sessionId: part.sessionID,
    sourcePath: part.source && part.source.type !== "resource" ? part.source.path : "",
    ...(inlineImage ? { dataUrl: part.url } : {}),
    ...(part.filename ? { filename: part.filename } : {}),
  })
  if (!registered) return safe
  return {
    ...safe,
    filename: registered.name,
    mime: registered.mime,
    attachmentId: registered.attachmentId,
    size: registered.size,
    preview: registered.preview,
  }
}

function mapToolPart(part: Extract<Part, { type: "tool" }>, knownSecrets: readonly string[] = []): Extract<ConversationPart, { type: "tool" }> {
  const state = part.state
  const exit = state.status === "completed" && part.tool === "bash" ? state.metadata?.exit : undefined
  const failedExit = typeof exit === "number" && Number.isInteger(exit) && exit !== 0
  return {
    id: part.id,
    type: "tool",
    callId: part.callID,
    tool: part.tool,
    status: failedExit ? "error" : state.status,
    ...((state.status === "running" || state.status === "completed") && state.title
      ? { title: redactText(state.title, knownSecrets) }
      : {}),
    ...(state.status === "running" || state.status === "completed" || state.status === "error"
      ? { startedAt: state.time.start }
      : {}),
    ...(state.status === "completed" || state.status === "error" ? { completedAt: state.time.end } : {}),
  }
}

export function createOpenCodeSession(config: BridgeConfig) {
  const client = createClient(config)
  const knownSecrets = [config.openCodePassword, config.telegram?.botToken].filter((value): value is string => Boolean(value))
  return async (title?: string): Promise<OpenCodeSnapshot["sessions"][number]> => {
    const response = await client.session.create({
      directory: config.openCodeDirectory,
      ...(title ? { title } : {}),
    }, { signal: AbortSignal.timeout(5_000) })
    if (!response.data) throw new Error("OpenCode did not return the created session")
    return mapSession(response.data, knownSecrets, config.openCodeDirectory)
  }
}

export function normalizeEvent(
  event: Event,
  knownSecrets: readonly string[] = [],
  workspace?: string,
): NormalizedOpenCodeEvent | undefined {
  const type = (event as { type: string }).type
  if (type === "server.heartbeat") return { type: "system.heartbeat", at: new Date().toISOString() }
  if (event.type === "server.connected") return { type: "system.online", at: new Date().toISOString() }
  if (event.type === "session.created" || event.type === "session.updated") {
    return {
      type: "session.updated",
      session: mapSession(event.properties.info, knownSecrets, workspace),
    }
  }
  if (event.type === "session.deleted") {
    return { type: "session.deleted", sessionId: event.properties.sessionID }
  }
  if (event.type === "session.idle") {
    return { type: "session.idle", sessionId: event.properties.sessionID }
  }
  if (event.type === "session.error") {
    return {
      type: "session.error",
      ...(event.properties.sessionID ? { sessionId: event.properties.sessionID } : {}),
    }
  }
  if (event.type === "session.status") {
    return {
      type: "session.status",
      sessionId: event.properties.sessionID,
      status: event.properties.status.type,
    }
  }
  if (event.type === "message.updated") {
    const info = event.properties.info
    return {
      type: "message.started",
      sessionId: event.properties.sessionID,
      message: {
        id: info.id,
        role: info.role,
        createdAt: info.time.created,
        ...(info.role === "assistant" && info.time.completed ? { completedAt: info.time.completed } : {}),
        ...(info.role === "assistant" ? {
          providerId: info.providerID,
          modelId: info.modelID,
          agent: info.agent,
          cost: safeMetric(info.cost),
          tokens: mapTokens(info.tokens),
        } : {}),
      },
    }
  }
  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.type === "text" && !part.ignored) {
      // An in-progress full-part update can still end halfway through a secret.
      // Only completed text parts (or legacy parts without timing metadata) are emitted.
      if (part.time && !part.time.end) return undefined
      return {
        type: "message.text",
        sessionId: event.properties.sessionID,
        messageId: part.messageID,
        partId: part.id,
        text: redactText(part.text, knownSecrets),
      }
    }
    if (part.type === "reasoning") {
      if (!part.time.end) return undefined
      return {
        type: "message.reasoning",
        sessionId: event.properties.sessionID,
        messageId: part.messageID,
        partId: part.id,
        status: "completed",
        startedAt: part.time.start,
        completedAt: part.time.end,
      }
    }
    if (part.type === "file") {
      return {
        type: "message.file",
        sessionId: event.properties.sessionID,
        messageId: part.messageID,
        part: mapFilePart(part, workspace, knownSecrets),
      }
    }
    if (part.type === "tool") {
      const safe = mapToolPart(part, knownSecrets)
      return {
        type: "tool.updated",
        sessionId: event.properties.sessionID,
        messageId: part.messageID,
        callId: part.callID,
        tool: part.tool,
        status: safe.status,
        ...(safe.title ? { title: safe.title } : {}),
        ...(safe.startedAt ? { startedAt: safe.startedAt } : {}),
        ...(safe.completedAt ? { completedAt: safe.completedAt } : {}),
      }
    }
  }
  // Raw deltas can split a credential across multiple events, which makes
  // reliable redaction impossible. Full message-part updates are used instead.
  if (event.type === "message.part.delta") return undefined
  if (event.type === "session.diff") {
    return {
      type: "session.diff",
      sessionId: event.properties.sessionID,
      diff: event.properties.diff.slice(0, 200).map((diff) => mapDiff(diff, knownSecrets, workspace)),
    }
  }
  if (event.type === "file.edited") {
    return { type: "file.edited", file: safePath(event.properties.file, workspace) }
  }
  if (event.type === "permission.v2.asked") {
    return {
      type: "permission.requested",
      sessionId: event.properties.sessionID,
      requestId: event.properties.id,
      action: event.properties.action,
      resources: event.properties.resources.slice(0, 50).map((resource) => safeResource(resource, knownSecrets)),
    }
  }
  if (event.type === "permission.asked") {
    return {
      type: "permission.requested",
      sessionId: event.properties.sessionID,
      requestId: event.properties.id,
      action: event.properties.permission,
      resources: event.properties.patterns.slice(0, 50).map((resource) => safeResource(resource, knownSecrets)),
    }
  }
  if (event.type === "permission.v2.replied" || event.type === "permission.replied") {
    return {
      type: "permission.resolved",
      sessionId: event.properties.sessionID,
      requestId: event.properties.requestID,
    }
  }
}

const STREAM_TAIL_SIZE = 1_024
const STREAM_MAX_PARTS = 256
const STREAM_MAX_TEXT_SIZE = 1_048_576
const STREAM_BUFFER_TTL_MS = 300_000

type StreamState = { emitted: string; touchedAt: number }

/**
 * Converts cumulative text-part updates into safe append-only chunks. Raw SDK
 * deltas never enter the public stream. A tail large enough for every known
 * secret is retained, and the current non-whitespace token is retained too,
 * so credential-like values cannot be exposed before redaction can identify
 * the complete value.
 */
export function createSecureEventNormalizer(
  knownSecrets: readonly string[] = [],
  workspace?: string,
): (event: Event) => NormalizedOpenCodeEvent | undefined {
  const states = new Map<string, StreamState>()
  const tailSize = Math.max(STREAM_TAIL_SIZE, ...knownSecrets.map((secret) => secret.length + 1))

  const prune = (now: number) => {
    for (const [key, state] of states) {
      if (now - state.touchedAt > STREAM_BUFFER_TTL_MS) states.delete(key)
    }
  }

  return (event) => {
    const now = Date.now()
    prune(now)
    if (event.type !== "message.part.updated" || event.properties.part.type !== "text") {
      return normalizeEvent(event, knownSecrets, workspace)
    }

    const part = event.properties.part
    if (part.ignored) return undefined
    const key = `${event.properties.sessionID}\0${part.messageID}\0${part.id}`
    if (part.time?.end) {
      states.delete(key)
      return normalizeEvent(event, knownSecrets, workspace)
    }
    if (part.text.length > STREAM_MAX_TEXT_SIZE) {
      states.delete(key)
      return undefined
    }
    let state = states.get(key)
    if (!state) {
      if (states.size >= STREAM_MAX_PARTS) return undefined
      state = { emitted: "", touchedAt: now }
      states.set(key, state)
    }
    state.touchedAt = now

    const provisionalEnd = Math.max(0, part.text.length - tailSize)
    const whitespace = part.text.lastIndexOf(" ", provisionalEnd)
    const lineBreak = part.text.lastIndexOf("\n", provisionalEnd)
    const stableEnd = Math.max(whitespace, lineBreak) + 1
    const safePrefix = redactText(part.text.slice(0, stableEnd), knownSecrets)
    if (!safePrefix.startsWith(state.emitted)) {
      // A newly completed redaction changed already-buffered content. Withhold
      // the update; the completed full-part event will reconcile it safely.
      return undefined
    }
    const delta = safePrefix.slice(state.emitted.length)
    if (!delta) return undefined
    state.emitted = safePrefix
    return {
      type: "message.delta",
      sessionId: event.properties.sessionID,
      messageId: part.messageID,
      partId: part.id,
      delta,
    }
  }
}

function waitForRetry(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export function createClient(config: BridgeConfig, beforeWrite?: () => void) {
  const authorization = config.openCodePassword
    ? `Basic ${Buffer.from(`${config.openCodeUsername}:${config.openCodePassword}`).toString("base64")}`
    : undefined

  const authenticatedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    if (authorization) headers.set("Authorization", authorization)
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) beforeWrite?.()
    return fetch(input, { ...init, headers, redirect: "error" })
  }

  return createOpencodeClient({
    baseUrl: config.openCodeUrl.href.replace(/\/$/, ""),
    fetch: authenticatedFetch,
    throwOnError: true,
  })
}

async function assertSessionScope(
  client: ReturnType<typeof createClient>,
  config: BridgeConfig,
  sessionId: string,
): Promise<void> {
  const response = await client.session.get(
    { sessionID: sessionId, directory: config.openCodeDirectory },
    { signal: AbortSignal.timeout(5_000) },
  )
  if (!response.data || relative(resolve(config.openCodeDirectory), resolve(response.data.directory)) !== "") {
    throw new Error("Session is outside the configured workspace")
  }
}

export function createSnapshotLoader(config: BridgeConfig) {
  const client = createClient(config)
  const knownSecrets = [config.openCodePassword, config.telegram?.botToken].filter((value): value is string => Boolean(value))
  return async (): Promise<OpenCodeSnapshot> => {
    const [health, projects, sessions, statuses] = await Promise.all([
      client.global.health({ signal: AbortSignal.timeout(5_000) }),
      client.project.list(
        { directory: config.openCodeDirectory },
        { signal: AbortSignal.timeout(5_000) },
      ),
      client.session.list(
        { directory: config.openCodeDirectory },
        { signal: AbortSignal.timeout(5_000) },
      ),
      client.session.status({ directory: config.openCodeDirectory }, { signal: AbortSignal.timeout(5_000) }),
    ])

    if (!health.data?.healthy) throw new Error("OpenCode health check failed")
    if (!sessions.data || !projects.data || !statuses.data) throw new Error("OpenCode snapshot incomplete")

    return {
      online: true,
      version: health.data.version,
      syncedAt: new Date().toISOString(),
      statuses: Object.fromEntries(sessions.data.map(({ id }) => [id, statuses.data?.[id]?.type ?? "idle"])),
      projects: (projects.data ?? []).map(mapProject),
      sessions: (sessions.data ?? []).map((session) => mapSession(session, knownSecrets, config.openCodeDirectory)),
    }
  }
}

export function createEventLoader(config: BridgeConfig, registerFile?: FileRegistrar) {
  const client = createClient(config)
  const knownSecrets = [config.openCodePassword, config.telegram?.botToken].filter((value): value is string => Boolean(value))
  const normalizeSecurely = createSecureEventNormalizer(knownSecrets, config.openCodeDirectory)

  return async function* (
    signal: AbortSignal,
    actor?: { userId: string },
  ): AsyncGenerator<NormalizedOpenCodeEvent> {
    while (!signal.aborted) {
      try {
        const { stream } = await client.event.subscribe(
          { directory: config.openCodeDirectory },
          {
            signal,
            sseDefaultRetryDelay: 1_000,
            sseMaxRetryDelay: 10_000,
          },
        )
        for await (const event of stream) {
          let normalized = normalizeSecurely(event)
          if (
            normalized?.type === "message.file" &&
            event.type === "message.part.updated" &&
            event.properties.part.type === "file"
          ) {
            normalized = {
              ...normalized,
              part: await mapRegisteredFilePart(
                event.properties.part,
                config.openCodeDirectory,
                knownSecrets,
                actor?.userId,
                registerFile,
              ),
            }
          }
          if (normalized) yield normalized
        }
      } catch {
        if (signal.aborted) return
        yield { type: "system.offline", at: new Date().toISOString() }
      }
      if (!signal.aborted) await waitForRetry(signal)
    }
  }
}

export function createMessageLoader(config: BridgeConfig, registerFile?: FileRegistrar) {
  const client = createClient(config)
  const knownSecrets = [config.openCodePassword, config.telegram?.botToken].filter((value): value is string => Boolean(value))
  return async (sessionId: string, actor?: { userId: string }): Promise<ConversationMessage[]> => {
    await assertSessionScope(client, config, sessionId)
    const response = await client.session.messages(
      { sessionID: sessionId, directory: config.openCodeDirectory, limit: 50 },
      { signal: AbortSignal.timeout(5_000) },
    )
    const messages = await Promise.all((response.data ?? []).map(async ({ info, parts }) => {
      const textParts = Object.fromEntries(parts.flatMap((part) => (
        part.type === "text" && !part.ignored ? [[part.id, part.text]] : []
      )))
      const content = (await Promise.all(parts.map(async (part): Promise<ConversationPart[]> => {
        if (part.type === "text" && !part.ignored) {
          return [{
            id: part.id,
            type: "text",
            text: redactText(part.text, knownSecrets),
            ...(part.synthetic ? { synthetic: true } : {}),
          }]
        }
        if (part.type === "reasoning") {
          return [{
            id: part.id,
            type: "reasoning",
            status: part.time?.end ? "completed" : "running",
            ...(part.time?.start ? { startedAt: part.time.start } : {}),
            ...(part.time?.end ? { completedAt: part.time.end } : {}),
          }]
        }
        if (part.type === "file") return [await mapRegisteredFilePart(
          part,
          config.openCodeDirectory,
          knownSecrets,
          actor?.userId,
          registerFile,
        )]
        if (part.type === "tool") return [mapToolPart(part, knownSecrets)]
        return []
      }))).flat()
      const summary = info.role === "user" && info.summary
        ? {
            ...(info.summary.title ? { title: redactText(info.summary.title, knownSecrets) } : {}),
            ...(info.summary.body ? { body: redactText(info.summary.body, knownSecrets) } : {}),
            diffs: info.summary.diffs.map((diff) => mapDiff(diff, knownSecrets, config.openCodeDirectory)),
          }
        : undefined
      return {
        id: info.id,
        role: info.role,
        createdAt: info.time.created,
        text: redactText(Object.values(textParts).join("\n"), knownSecrets),
        parts: Object.fromEntries(Object.entries(textParts).map(([id, text]) => [id, redactText(text, knownSecrets)])),
        content,
        ...(info.role === "assistant" && info.time.completed ? { completedAt: info.time.completed } : {}),
        ...(info.role === "assistant" ? {
          providerId: info.providerID,
          modelId: info.modelID,
          agent: info.agent,
          cost: safeMetric(info.cost),
          tokens: mapTokens(info.tokens),
        } : {}),
        ...(summary ? { summary } : {}),
      }
    }))
    return messages.filter((message) => message.content.length > 0)
  }
}

export function createCapabilitiesLoader(attachmentsEnabled = false, storageEnabled = false): () => Promise<OpenCodeCapabilities> {
  return async () => ({
    version: 1,
    capabilities: {
      messageHistory: { status: "available" },
      structuredParts: { status: "available" },
      tools: { status: "available" },
      agents: { status: "available", mode: "catalog" },
      skills: { status: "available", mode: "read-only-configuration-writes-unverified" },
      mcp: { status: "available", mode: "approved-runtime-only-management" },
      plugins: { status: "available", mode: "read-only-configuration-writes-unverified" },
      diffs: { status: "available" },
      files: attachmentsEnabled
        ? { status: "available", mode: "authenticated-opaque-handles" }
        : { status: "disabled", reason: "File metadata is available, but authenticated content delivery is not enabled." },
      images: attachmentsEnabled
        ? { status: "available", mode: "png-jpeg-webp" }
        : { status: "disabled", reason: "Image preview requires the authenticated attachment pipeline." },
      models: { status: "available" },
      providers: { status: "available" },
      tokens: { status: "available" },
      costs: { status: "available" },
      storage: storageEnabled
        ? { status: "available", mode: "authenticated-opaque-directory-handles" }
        : { status: "disabled", reason: "Workspace browsing is not enabled in this release." },
      streaming: { status: "available", mode: "redacted-cumulative-withheld-tail" },
      htmlPreview: attachmentsEnabled
        ? { status: "available", mode: "sandboxed-static-html" }
        : { status: "disabled", reason: "Authenticated file delivery is required." },
      git: { status: "available", mode: "read-only-status" },
    },
  })
}

export function createProviderCatalogLoader(config: BridgeConfig) {
  const client = createClient(config)
  return async (): Promise<ProviderCatalog> => {
    const request = { directory: config.openCodeDirectory }
    const options = { signal: AbortSignal.timeout(5_000) }
    const [response, skillsResult, mcpResult, configResult] = await Promise.all([
      client.provider.list(request, options),
      client.app.skills(request, options).catch(() => undefined),
      client.mcp.status(request, options).catch(() => undefined),
      client.config.get(request, options).catch(() => undefined),
    ])
    const catalog = response.data
    if (!catalog) throw new Error("OpenCode did not return the provider catalog")
    const connected = new Set(catalog.connected)
    const pluginName = (plugin: string | [string, Record<string, unknown>]) => {
      const value = Array.isArray(plugin) ? plugin[0] : plugin
      return /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:@[a-z0-9._-]+)?$/i.exec(value.trim())?.[1] ?? "Local plugin"
    }
    return {
      providers: [...catalog.all]
        .sort((left, right) => Number(connected.has(right.id)) - Number(connected.has(left.id)) || left.name.localeCompare(right.name))
        .slice(0, 100)
        .map((provider) => ({
        id: provider.id,
        name: provider.name,
        connected: connected.has(provider.id),
        ...(catalog.default[provider.id] ? { defaultModelId: catalog.default[provider.id] } : {}),
        models: Object.values(provider.models).slice(0, 500).map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.family ? { family: model.family } : {}),
          status: model.status,
          capabilities: {
            reasoning: model.capabilities.reasoning,
            attachments: model.capabilities.attachment,
            tools: model.capabilities.toolcall,
            input: { ...model.capabilities.input },
            output: { ...model.capabilities.output },
          },
          limits: {
            context: safeMetric(model.limit.context),
            ...(model.limit.input ? { input: safeMetric(model.limit.input) } : {}),
            output: safeMetric(model.limit.output),
          },
          variants: Object.entries(model.variants ?? {})
            .filter(([, settings]) => !settings.disabled)
            .map(([name]) => name)
            .sort(),
        })),
      })),
      ...(skillsResult?.data ? { skills: skillsResult.data.slice(0, 500).map((skill) => ({
        name: skill.name.slice(0, 100),
        ...(skill.description ? { description: skill.description.slice(0, 500) } : {}),
      })) } : {}),
      ...(mcpResult?.data ? { mcpServers: Object.entries(mcpResult.data).slice(0, 100).map(([name, server]) => ({
        name: name.slice(0, 100),
        status: server.status,
      })) } : {}),
      ...(configResult?.data?.plugin ? { plugins: [...new Set(configResult.data.plugin.map(pluginName))].slice(0, 100).map((name) => ({ name })) } : { plugins: [] }),
    }
  }
}

export function createAgentCatalogLoader(config: BridgeConfig) {
  const client = createClient(config)
  return async (): Promise<AgentCatalog> => {
    const response = await client.app.agents(
      { directory: config.openCodeDirectory },
      { signal: AbortSignal.timeout(5_000) },
    )
    if (!response.data) throw new Error("OpenCode did not return the agent catalog")
    return {
      agents: response.data
        .filter((agent) => !agent.hidden)
        .slice(0, 100)
        .map((agent) => ({
          name: agent.name,
          mode: agent.mode,
          native: agent.native === true,
          ...(agent.description ? { description: agent.description.slice(0, 500) } : {}),
          ...(agent.color ? { color: agent.color } : {}),
          ...(agent.model ? { model: { id: agent.model.modelID, providerId: agent.model.providerID } } : {}),
          ...(agent.variant ? { variant: agent.variant.slice(0, 100) } : {}),
        })),
    }
  }
}

export function createSessionDiffLoader(config: BridgeConfig) {
  const client = createClient(config)
  const knownSecrets = [config.openCodePassword, config.telegram?.botToken].filter((value): value is string => Boolean(value))
  return async (sessionId: string, messageId?: string): Promise<SessionDiff[]> => {
    await assertSessionScope(client, config, sessionId)
    const response = await client.session.diff(
      {
        sessionID: sessionId,
        directory: config.openCodeDirectory,
        ...(messageId ? { messageID: messageId } : {}),
      },
      { signal: AbortSignal.timeout(5_000) },
    )
    return (response.data ?? []).slice(0, 200).map((diff) => mapDiff(diff, knownSecrets, config.openCodeDirectory))
  }
}

export function createSessionTodoLoader(config: BridgeConfig) {
  const client = createClient(config)
  return async (sessionId: string): Promise<SessionTodo[]> => {
    await assertSessionScope(client, config, sessionId)
    const response = await client.session.todo(
      { sessionID: sessionId, directory: config.openCodeDirectory },
      { signal: AbortSignal.timeout(5_000) },
    )
    return (response.data ?? []).slice(0, 200).map(({ content, status, priority }) => ({
      content: content.slice(0, 2_000),
      status: status.slice(0, 50),
      priority: priority.slice(0, 50),
    }))
  }
}

export function createVcsLoader(config: BridgeConfig, readGit?: () => Promise<unknown>) {
  const client = createClient(config)
  const knownSecrets = [config.openCodePassword, config.telegram?.botToken].filter((value): value is string => Boolean(value))
  return async () => {
    const [info, status] = await Promise.all([
      client.vcs.get({ directory: config.openCodeDirectory }, { signal: AbortSignal.timeout(15_000) }),
      client.vcs.status({ directory: config.openCodeDirectory }, { signal: AbortSignal.timeout(15_000) }),
    ])
    return {
      branch: info.data?.branch ? safeResource(safePath(info.data.branch, config.openCodeDirectory), knownSecrets) : undefined,
      defaultBranch: info.data?.default_branch ? safeResource(safePath(info.data.default_branch, config.openCodeDirectory), knownSecrets) : undefined,
      files: (status.data ?? []).slice(0, 500).map((file) => ({
        additions: safeMetric(file.additions), deletions: safeMetric(file.deletions), status: file.status,
        file: safeResource(safePath(file.file, config.openCodeDirectory), knownSecrets),
      })),
      ...(readGit ? await readGit() as object : {}),
    }
  }
}

export function createVcsDiffLoader(config: BridgeConfig) {
  const client = createClient(config)
  const knownSecrets = [config.openCodePassword, config.telegram?.botToken].filter((value): value is string => Boolean(value))
  return async (mode: "git" | "branch") => {
    const response = await client.vcs.diff({ directory: config.openCodeDirectory, mode, context: 3 }, { signal: AbortSignal.timeout(15_000) })
    if (!response.data) throw new Error("VCS diff unavailable")
    return { mode, files: response.data.slice(0, 500).map((file) => {
      const mapped = mapDiff(file, knownSecrets, config.openCodeDirectory)
      return { ...mapped, ...(mapped.file ? { file: safeResource(mapped.file, knownSecrets) } : {}), ...(mapped.patch ? { patch: mapped.patch.replaceAll(config.openCodeDirectory, "[workspace]").replace(/(^|[\s"'=+(])(?:[A-Za-z]:[\\/]|\/)[^\s"')]+/gm, "$1[path]") } : {}) }
    }) }
  }
}

export function createPermissionLoader(config: BridgeConfig) {
  const client = createClient(config)
  const knownSecrets = [config.openCodePassword, config.telegram?.botToken].filter((value): value is string => Boolean(value))
  return async (sessionId: string): Promise<PendingPermission[]> => {
    await assertSessionScope(client, config, sessionId)
    const response = await client.permission.list(
      { directory: config.openCodeDirectory },
      { signal: AbortSignal.timeout(5_000) },
    )
    return (response.data ?? [])
      .filter((permission) => permission.sessionID === sessionId)
      .map((permission) => ({
        requestId: permission.id,
        sessionId: permission.sessionID,
        action: permission.permission,
        resources: permission.patterns.slice(0, 50).map((resource) => safeResource(resource, knownSecrets)),
      }))
  }
}

export function createWorkspacePermissionLoader(config: BridgeConfig) {
  const client = createClient(config)
  return async (): Promise<PendingPermission[]> => {
    const request = { directory: config.openCodeDirectory }, options = { signal: AbortSignal.timeout(5000) }
    const [sessions, permissions] = await Promise.all([client.session.list(request, options), client.permission.list(request, options)])
    if (!sessions.data || !permissions.data) throw new Error("Pending permissions unavailable")
    const ids = new Set(sessions.data.filter((session) => resolve(session.directory) === resolve(config.openCodeDirectory)).map((session) => session.id))
    return permissions.data.filter((permission) => ids.has(permission.sessionID)).map((permission) => ({
      requestId: permission.id, sessionId: permission.sessionID, action: permission.permission, resources: [],
    }))
  }
}

export function createWorkspaceExecutionLoader(config: BridgeConfig) {
  const client = createClient(config)
  return async (): Promise<string[]> => {
    const request = { directory: config.openCodeDirectory }, options = { signal: AbortSignal.timeout(5000) }
    const [sessions, statuses] = await Promise.all([client.session.list(request, options), client.session.status(request, options)])
    if (!sessions.data || !statuses.data) throw new Error("Active sessions unavailable")
    return sessions.data.filter((session) => resolve(session.directory) === resolve(config.openCodeDirectory) &&
      (statuses.data?.[session.id]?.type === "busy" || statuses.data?.[session.id]?.type === "retry")).map((session) => session.id)
  }
}

export function createPromptSender(config: BridgeConfig) {
  const client = createClient(config)
  return async (sessionId: string, text: string, files: Array<{
    type: "file"
    mime: string
    filename: string
    url: string
  }> = [], selection: {
    agent?: string
    model?: { providerId: string; modelId: string }
    variant?: string
  } = {}, revalidate: () => void = () => {}): Promise<void> => {
    await assertSessionScope(client, config, sessionId)
    if (selection.variant && !selection.model) throw new Error("A model is required when selecting a variant")
    if (selection.agent || selection.model) {
      const [agentsResponse, providersResponse] = await Promise.all([
        selection.agent
          ? client.app.agents({ directory: config.openCodeDirectory }, { signal: AbortSignal.timeout(5_000) })
          : Promise.resolve(undefined),
        selection.model
          ? client.provider.list({ directory: config.openCodeDirectory }, { signal: AbortSignal.timeout(5_000) })
          : Promise.resolve(undefined),
      ])
      if (selection.agent && !agentsResponse?.data?.some((agent) => agent.name === selection.agent && !agent.hidden)) {
        throw new Error("Selected agent is unavailable")
      }
      if (selection.model) {
        const connected = new Set(providersResponse?.data?.connected ?? [])
        const provider = providersResponse?.data?.all.find(({ id }) => id === selection.model!.providerId)
        const model = provider?.models[selection.model.modelId]
        if (!provider || !model || !connected.has(provider.id)) throw new Error("Selected model is unavailable")
        if (selection.variant) {
          const variant = model.variants?.[selection.variant]
          if (!variant || variant.disabled) throw new Error("Selected model variant is unavailable")
        }
      }
    }
    revalidate()
    await client.session.promptAsync({
      sessionID: sessionId,
      directory: config.openCodeDirectory,
      parts: [...(text ? [{ type: "text" as const, text }] : []), ...files],
      ...(config.imageGenerationProvider === "openai" ? { system: "Image-generation routing preference: use only the direct OpenAI Images API when an authorized, compatible OpenAI API key is available. Do not use 9Router or another gateway as a fallback for image generation. Do not assume OpenAI chat OAuth/ChatGPT credentials grant access to the Images API. If no compatible credential is available, explain that image generation is unavailable until configured; do not retry other providers or request repeated approvals for unsupported attempts. Never print credentials. This preference does not change the conversation model or authorize a paid generation by itself." } : {}),
      ...(selection.agent ? { agent: selection.agent } : {}),
      ...(selection.model ? { model: { providerID: selection.model.providerId, modelID: selection.model.modelId } } : {}),
      ...(selection.variant ? { variant: selection.variant } : {}),
    }, { signal: AbortSignal.timeout(5_000) })
  }
}

export function createSessionAborter(config: BridgeConfig) {
  const client = createClient(config)
  return async (sessionId: string, revalidate: () => void = () => {}): Promise<void> => {
    await assertSessionScope(client, config, sessionId)
    revalidate()
    await client.session.abort(
      { sessionID: sessionId, directory: config.openCodeDirectory },
      { signal: AbortSignal.timeout(5_000) },
    )
  }
}

export function createSessionDeleter(config: BridgeConfig) {
  const client = createClient(config)
  return async (sessionId: string, revalidate: () => void = () => {}): Promise<void> => {
    await assertSessionScope(client, config, sessionId)
    revalidate()
    const response = await client.session.delete(
      { sessionID: sessionId, directory: config.openCodeDirectory },
      { signal: AbortSignal.timeout(5_000) },
    )
    if (response.data !== true) throw new Error("OpenCode did not delete the session")
  }
}

export function createPermissionResponder(config: BridgeConfig) {
  const client = createClient(config)
  return async (requestId: string, reply: "once" | "reject", revalidate: () => void = () => {}): Promise<void> => {
    const pending = await client.permission.list(
      { directory: config.openCodeDirectory },
      { signal: AbortSignal.timeout(5_000) },
    )
    const permission = (pending.data ?? []).find((candidate) => candidate.id === requestId)
    if (!permission) throw new Error("Permission is outside the configured workspace")
    await assertSessionScope(client, config, permission.sessionID)
    revalidate()
    await client.permission.reply(
      { requestID: requestId, directory: config.openCodeDirectory, reply },
      { signal: AbortSignal.timeout(5_000) },
    )
  }
}

