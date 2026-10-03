import { t } from "./i18n.js"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type UIEvent } from "react"
import type { Session } from "./Dashboard.js"
import { controlErrorMessage, replyOpenCodePermission } from "./control-api.js"
import { ChangeSummary, ChatMessageView, DiffViewer, Icon, type ChatMessage, type FileChange, type MessagePart } from "./components/index.js"

type PendingUpload = { id: string; name: string; mime: string; size: number }
type ModelOption = { id: string; name: string; providerId: string; providerName: string; status: string; limits: { context: number; output: number }; variants: string[] }
type AgentOption = { name: string; description?: string; mode: "subagent" | "primary" | "all"; color?: string; native: boolean; model?: { id: string; providerId: string }; variant?: string }
type Proposal = {
  actionId: string
  type: "session.prompt" | "session.abort"
  text?: string
  uploads?: PendingUpload[]
  agent?: string
  model?: ModelOption
  variant?: string
}
type ConversationTab = "chat" | "changes" | "agents" | "logs"
type TokenUsage = { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
type ServerFilePart = {
  id: string
  type: "file"
  mime: string
  filename?: string
  source?: { label: string }
  attachmentId?: string
  size?: number
  preview?: "image" | "text" | "download"
}
type ServerPart =
  | { id: string; type: "text"; text: string; synthetic?: boolean }
  | ServerFilePart
  | { id: string; type: "tool"; callId: string; tool: string; status: "pending" | "running" | "completed" | "error"; title?: string }
  | { id: string; type: "status"; status: string }
type ServerMessage = {
  id: string; role: "user" | "assistant"; createdAt: number; completedAt?: number; text: string
  content?: ServerPart[]; cost?: number; tokens?: TokenUsage
  summary?: { diffs: ServerDiff[] }
}
type ServerDiff = { file?: string; patch?: string; additions: number; deletions: number; status?: "added" | "deleted" | "modified" }

export type ConversationEvent = {
  sequence: number
  type: "message.started" | "message.text" | "message.delta" | "message.file" | "tool.updated" | "session.diff" | "file.edited" | "session.status" | "session.idle" | "session.error" | "permission.requested" | "permission.resolved"
  sessionId: string
  message?: { id: string; role: "user" | "assistant"; createdAt: number; completedAt?: number; cost?: number; tokens?: TokenUsage }
  messageId?: string; partId?: string; text?: string; delta?: string; callId?: string; tool?: string; title?: string
  part?: Omit<ServerFilePart, "type">
  diff?: ServerDiff[]
  status?: "idle" | "busy" | "retry" | "pending" | "running" | "completed" | "error"
  requestId?: string; action?: string; resources?: string[]
}

function fileMessagePart(part: Omit<ServerFilePart, "type">): MessagePart {
  const name = part.filename ?? part.source?.label ?? "file"
  if (part.attachmentId && part.preview === "image") {
    return { type: "image", attachmentId: part.attachmentId, name, alt: name }
  }
  if (part.attachmentId) {
    return {
      type: "file",
      fileId: part.attachmentId,
      name,
      path: part.source?.label ?? name,
      mime: part.mime,
      ...(part.size !== undefined ? { size: part.size } : {}),
    }
  }
  return { type: "status", content: `Attachment: ${name}. Secure preview is unavailable for this item.` }
}

function messageParts(message: ServerMessage): MessagePart[] {
  const content = message.content?.flatMap((part): MessagePart[] => {
    if (part.type === "text") return [{ type: "markdown", id: part.id, content: part.text }]
    if (part.type === "tool") return [{ type: "tool", id: part.callId, name: part.tool, status: part.status, ...(part.title ? { title: part.title } : {}) }]
    if (part.type === "file") return [fileMessagePart(part)]
    return [{ type: "status", content: part.status }]
  }) ?? []
  return content.length ? content : message.text ? [{ type: "markdown", content: message.text }] : []
}

function toChatMessage(message: ServerMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    status: message.completedAt || message.role === "user" ? "completed" : "streaming",
    parts: messageParts(message),
  }
}

function toFileChange(diff: ServerDiff): FileChange {
  return {
    file: diff.file ?? "Changed file",
    diff: diff.patch ?? "",
    status: diff.status === "added" ? "created" : diff.status === "deleted" ? "deleted" : "modified",
    additions: diff.additions,
    deletions: diff.deletions,
  }
}

function messageText(message: ChatMessage): string {
  return message.parts.flatMap((part) => part.type === "markdown" ? [part.content] : []).join("\n")
}

function compactModelName(name: string): string {
  return /^Gateway \((.+)\)$/.exec(name)?.[1] ?? name
}

export function Conversation({ session, onBack, onUnauthorized, onStepUp, event, connectionEpoch, status, onDelete, availableModels, availableAgents, initialAgent }: {
  session: Session; onBack: () => void; onUnauthorized: () => void; onStepUp: () => void; event?: ConversationEvent
  connectionEpoch: number; status: "idle" | "busy" | "retry"; onDelete: () => void
  availableModels: ModelOption[]
  availableAgents: AgentOption[]
  initialAgent?: string
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]), [draft, setDraft] = useState("")
  const [todos, setTodos] = useState<Array<{ content: string; status: string; priority: string }>>([])
  const [changes, setChanges] = useState<FileChange[]>([]), [proposal, setProposal] = useState<Proposal>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [working, setWorking] = useState(status !== "idle")
  const [activeTab, setActiveTab] = useState<ConversationTab>("chat"), [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState("")
  const modelMenu = useRef<HTMLDivElement>(null), modelSearch = useRef<HTMLInputElement>(null), modelTrigger = useRef<HTMLButtonElement>(null)
  const [newMessages, setNewMessages] = useState(false)
  const [uploads, setUploads] = useState<PendingUpload[]>([]), [uploading, setUploading] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState(session.agent ?? "")
  const [selectedModel, setSelectedModel] = useState<ModelOption | undefined>(() => availableModels.find(({ id, providerId }) => id === session.model?.id && providerId === session.model?.providerId))
  const [selectedVariant, setSelectedVariant] = useState(session.model?.variant ?? "")
  const approvalHeading = useRef<HTMLHeadingElement>(null), scrollArea = useRef<HTMLDivElement>(null), atBottom = useRef(true), fileInput = useRef<HTMLInputElement>(null)
  const [permission, setPermission] = useState<{ requestId: string; action: string; resources: string[] }>()

  const load = useCallback(async () => {
    const [messagesResponse, diffResponse] = await Promise.all([
      fetch(`/api/v1/sessions/${encodeURIComponent(session.id)}/messages`, { credentials: "include" }),
      fetch(`/api/v1/sessions/${encodeURIComponent(session.id)}/diff`, { credentials: "include" }),
    ])
    if (messagesResponse.status === 401 || diffResponse.status === 401) return onUnauthorized()
    if (!messagesResponse.ok) throw new Error("messages-unavailable")
    const body = await messagesResponse.json() as { messages: ServerMessage[]; permissions: Array<{ requestId: string; action: string; resources: string[] }>; todos?: Array<{ content: string; status: string; priority: string }> }
    setMessages(body.messages.map(toChatMessage)); setPermission(body.permissions[0]); setTodos(body.todos ?? [])
    if (diffResponse.ok) setChanges(((await diffResponse.json() as { diff: ServerDiff[] }).diff ?? []).map(toFileChange))
    setError("")
  }, [onUnauthorized, session.id])

  useEffect(() => { void load().catch(() => setError("Conversation is unavailable.")) }, [connectionEpoch, load])
  useEffect(() => { setWorking(status !== "idle") }, [status])
  useEffect(() => {
    if (!modelMenuOpen) { setModelQuery(""); return }
    modelSearch.current?.focus()
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!modelMenu.current?.contains(target) && !modelTrigger.current?.contains(target)) setModelMenuOpen(false)
    }
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setModelMenuOpen(false); modelTrigger.current?.focus() }
    }
    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", closeEscape)
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape) }
  }, [modelMenuOpen])
  useEffect(() => {
    const currentModel = availableModels.find(({ id, providerId }) => id === session.model?.id && providerId === session.model?.providerId)
    const currentAgent = initialAgent && availableAgents.some(({ name }) => name === initialAgent)
      ? initialAgent
      : session.agent && availableAgents.some(({ name }) => name === session.agent) ? session.agent : undefined
    setSelectedAgent(currentAgent ?? availableAgents.find(({ mode }) => mode === "primary" || mode === "all")?.name ?? "")
    setSelectedModel(currentModel)
    setSelectedVariant(session.model?.variant && currentModel?.variants.includes(session.model.variant)
      ? session.model.variant
      : currentModel?.variants.includes("medium") ? "medium" : "")
  }, [session.id, initialAgent])
  useEffect(() => { if (proposal || permission) approvalHeading.current?.focus() }, [permission, proposal])

  useLayoutEffect(() => {
    if (activeTab !== "chat" || !scrollArea.current) return
    if (atBottom.current) scrollArea.current.scrollTo({ top: scrollArea.current.scrollHeight, behavior: "smooth" })
    else setNewMessages(true)
  }, [activeTab, messages])

  useEffect(() => {
    if (!event || event.sessionId !== session.id) return
    if (event.type === "message.started" && event.message) {
      const incoming = event.message
      setMessages((current) => current.some(({ id }) => id === incoming.id) ? current : [...current, {
        id: incoming.id,
        role: incoming.role,
        createdAt: incoming.createdAt,
        status: incoming.completedAt || incoming.role === "user" ? "completed" : "streaming",
        parts: [],
      }])
    }
    if ((event.type === "message.text" || event.type === "message.delta") && event.messageId && event.partId && (event.text !== undefined || event.delta)) {
      const messageId = event.messageId, partId = event.partId
      const incoming = event.text ?? event.delta ?? ""
      setMessages((current) => {
        let found = false
        const updated = current.map((message) => {
          if (message.id !== messageId) return message
          found = true
          const index = message.parts.findIndex((part) => part.type === "markdown" && part.id === partId)
          const previous = index >= 0 && message.parts[index]?.type === "markdown" ? message.parts[index].content : ""
          const content = event.type === "message.delta" ? previous + incoming : incoming
          const nextPart: MessagePart = { type: "markdown", content, id: partId }
          const parts = index < 0 ? [...message.parts, nextPart] : message.parts.map((part, partIndex) => partIndex === index ? nextPart : part)
          return { ...message, status: message.role === "assistant" ? "streaming" as const : "completed" as const, parts }
        })
        const withMessage = found ? updated : [...updated, { id: messageId, role: "assistant" as const, createdAt: Date.now(), status: "streaming" as const, parts: [{ type: "markdown" as const, id: partId, content: incoming }] }]
        return withMessage.filter((message) => !(event.type === "message.text" && message.id.startsWith("local-") && message.status === "sending" && messageText(message) === incoming))
      })
    }
    if (event.type === "message.file" && event.messageId && event.part) setMessages((current) => current.map((message) => message.id === event.messageId ? { ...message, parts: [...message.parts, fileMessagePart(event.part!)] } : message))
    if (event.type === "tool.updated" && event.messageId && event.callId && event.tool && event.status) {
      const messageId = event.messageId, callId = event.callId, tool = event.tool, toolStatus = event.status
      setMessages((current) => current.map((message) => {
      if (message.id !== messageId) return message
      const toolPart: MessagePart = { type: "tool", id: callId, name: tool, status: toolStatus as "pending" | "running" | "completed" | "error", ...(event.title ? { title: event.title } : {}) }
      const index = message.parts.findIndex((part) => part.type === "tool" && part.id === callId)
      return { ...message, parts: index < 0 ? [...message.parts, toolPart] : message.parts.map((part, partIndex) => partIndex === index ? toolPart : part) }
      }))
    }
    if (event.type === "session.diff" && event.diff) setChanges(event.diff.map(toFileChange))
    if (event.type === "session.status") setWorking(event.status !== "idle")
    if (event.type === "session.idle") { setWorking(false); setMessages((current) => current.map((message) => message.status === "streaming" ? { ...message, status: "completed" } : message)) }
    if (event.type === "session.error") { setWorking(false); setMessages((current) => current.map((message, index) => index === current.length - 1 && message.status === "streaming" ? { ...message, status: "failed" } : message)); setError("OpenCode reported an error for this session.") }
    if (event.type === "permission.requested" && event.requestId && event.action) setPermission({ requestId: event.requestId, action: event.action, resources: event.resources ?? [] })
    if (event.type === "permission.resolved") setPermission((current) => event.requestId === current?.requestId ? undefined : current)
  }, [event, session.id])

  const onScroll = (scrollEvent: UIEvent<HTMLDivElement>) => {
    const target = scrollEvent.currentTarget
    atBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 72
    if (atBottom.current) setNewMessages(false)
  }
  const scrollToLatest = () => { if (scrollArea.current) scrollArea.current.scrollTo({ top: scrollArea.current.scrollHeight, behavior: "smooth" }); atBottom.current = true; setNewMessages(false) }
  const openAttachment = (attachmentId: string) => {
    if (!/^att_[A-Za-z0-9_-]{32}$/.test(attachmentId)) return
    window.open(`/api/v1/attachments/${encodeURIComponent(attachmentId)}`, "_blank", "noopener,noreferrer")
  }

  const uploadFiles = async (changeEvent: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(changeEvent.target.files ?? []).slice(0, Math.max(0, 4 - uploads.length))
    changeEvent.target.value = ""
    if (!selected.length || uploading) return
    if (selected.some((file) => file.size > 10 * 1024 * 1024)) { setError("Each attachment must be 10 MB or smaller."); return }
    setUploading(true); setError("")
    try {
      const added: PendingUpload[] = []
      for (const file of selected) {
        const response = await fetch("/api/v1/uploads", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
          body: file,
        })
        if (response.status === 401) return onUnauthorized()
        if (!response.ok) throw new Error(response.status === 413 ? "too-large" : response.status === 415 ? "unsupported" : "upload-failed")
        const body = await response.json() as { upload: { attachmentId: string; name: string; mime: string; size: number } }
        added.push({ id: body.upload.attachmentId, name: body.upload.name, mime: body.upload.mime, size: body.upload.size })
      }
      setUploads((current) => [...current, ...added].slice(0, 4))
    } catch (uploadError) {
      setError(uploadError instanceof Error && uploadError.message === "too-large"
        ? "The attachment is too large."
        : uploadError instanceof Error && uploadError.message === "unsupported"
          ? "This file type is not supported."
          : "The attachment could not be uploaded.")
    } finally { setUploading(false) }
  }

  const requestProposal = async (type: Proposal["type"], text?: string, attached: PendingUpload[] = []) => {
    if (busy) return; setBusy(true); setError("")
    try {
      const selection = type === "session.prompt" ? {
        ...(selectedAgent ? { agent: selectedAgent } : {}),
        ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.id } } : {}),
        ...(selectedModel && selectedVariant ? { variant: selectedVariant } : {}),
      } : {}
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(session.id)}/actions`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, ...(text ? { text } : {}), ...(attached.length ? { uploadIds: attached.map(({ id }) => id) } : {}), ...selection }) })
      if (response.status === 401) return onUnauthorized(); if (!response.ok) throw new Error("proposal-failed")
      const body = await response.json() as { actionId: string }; setProposal({ actionId: body.actionId, type, ...(text ? { text } : {}), ...(attached.length ? { uploads: attached } : {}), ...(selectedAgent ? { agent: selectedAgent } : {}), ...(selectedModel ? { model: selectedModel } : {}), ...(selectedModel && selectedVariant ? { variant: selectedVariant } : {}) })
    } catch { setError("The action could not be proposed.") } finally { setBusy(false) }
  }
  const propose = (formEvent: FormEvent) => { formEvent.preventDefault(); const text = draft.trim(); if (text || uploads.length) void requestProposal("session.prompt", text, uploads) }
  const decide = async (decision: "approve" | "deny") => {
    if (!proposal || busy) return; setBusy(true); setError("")
    try {
      const response = await fetch(`/api/v1/actions/${encodeURIComponent(proposal.actionId)}/decision`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) })
      if (response.status === 401) return onUnauthorized(); if (!response.ok) throw new Error("decision-failed")
      if (decision === "approve" && proposal.type === "session.prompt") {
        const parts: MessagePart[] = [
          ...(proposal.text ? [{ type: "markdown" as const, content: proposal.text }] : []),
          ...(proposal.uploads ?? []).map(({ name }) => ({ type: "status" as const, content: `Attached: ${name}` })),
        ]
        setMessages((current) => [...current, { id: `local-${proposal.actionId}`, role: "user", createdAt: Date.now(), status: "sending", parts }])
        setWorking(true); setDraft(""); setUploads([]); atBottom.current = true
      }
      if (decision === "approve" && proposal.type === "session.abort") setWorking(false)
      setProposal(undefined)
    } catch { setError("The action is no longer available.") } finally { setBusy(false) }
  }
  const replyPermission = async (reply: "once" | "reject") => {
    if (!permission || busy) return; setBusy(true); setError("")
    try {
      await replyOpenCodePermission(permission.requestId, reply, { onUnauthorized, onStepUp })
      setPermission(undefined)
    } catch (failure) { setError(controlErrorMessage(failure)) } finally { setBusy(false) }
  }

  const model = selectedModel ? `${selectedModel.providerName} / ${selectedModel.name}` : session.model ? `${session.model.providerId} / ${session.model.id}` : "Model unavailable"
  const effortVariants = selectedModel?.variants ?? []
  const filteredModels = availableModels.filter((item) => `${item.name} ${item.id} ${item.providerName} ${item.providerId}`.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()))
  const modelGroups = Array.from(new Set(filteredModels.map((item) => item.providerId))).map((providerId) => ({ providerId, items: filteredModels.filter((item) => item.providerId === providerId) }))
  const totalTokens = session.tokens ? session.tokens.total ?? session.tokens.input + session.tokens.output + session.tokens.reasoning : undefined
  const activity = messages.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "tool" ? [{ ...part, createdAt: message.createdAt }] : []
  )).reverse()
  return <section className="page active conversation-page"><div className="chat">
    <div className="chathead"><button className="backbtn" type="button" onClick={onBack} aria-label={t("Back to dashboard")}><Icon name="arrow-left" /></button><div className="grow truncate"><strong className="truncate">{session.title}</strong><div className="tiny muted"><span className={working ? "dot" : "session-glyph"} /> {working ? t("Working") : t("Idle")} · {selectedAgent || session.agent || "OpenCode"}</div></div><button ref={modelTrigger} className="btn modelbtn" type="button" title={model} aria-label={t("Choose model")} aria-controls="model-selector" aria-expanded={modelMenuOpen} onClick={() => setModelMenuOpen((open) => !open)}><span>{compactModelName(selectedModel?.name ?? session.model?.id ?? "Model")}</span><Icon name="chevron-down" /></button><button className="iconbtn danger-text" type="button" onClick={onDelete} aria-label={t("Delete session")}><Icon name="close" /></button></div>
    <div ref={modelMenu} id="model-selector" className="soft mb model-menu" hidden={!modelMenuOpen} role="region" aria-labelledby="model-selector-title">
      <div className="model-menu__header"><strong id="model-selector-title">{t("Available Models")}</strong><button className="iconbtn" type="button" aria-label={t("Close model selector")} onClick={() => { setModelMenuOpen(false); modelTrigger.current?.focus() }}><Icon name="close" /></button></div>
      <label className="model-menu__search"><span className="sr-only">{t("Search models")}</span><input ref={modelSearch} className="input" type="search" placeholder={t("Search models…")} value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} /></label>
      <div className="model-options">{modelGroups.map(({ providerId, items }) => <section className="model-group" key={providerId} aria-label={items[0]?.providerName}><h3>{items[0]?.providerName}</h3>{items.map((item) => {
        const active = selectedModel?.id === item.id && selectedModel.providerId === item.providerId
        return <button className={`navbtn model-option ${active ? "active" : ""}`} type="button" title={`${item.name} · ${item.providerName}`} aria-pressed={active} key={`${item.providerId}/${item.id}`} onClick={() => { setSelectedModel(item); setSelectedVariant(item.variants.includes(selectedVariant) ? selectedVariant : item.variants.includes("medium") ? "medium" : ""); setModelMenuOpen(false); modelTrigger.current?.focus() }}><span className="model-option__text"><span className="model-option__name">{item.name}</span><small>{item.providerName}</small></span>{active && <Icon name="check" />}</button>
      })}</section>)}{filteredModels.length === 0 && <p className="tiny muted model-menu__empty">{availableModels.length === 0 ? t("No connected models were reported by OpenCode.") : t("No models found.")}</p>}</div>
    </div>
    <div className="flex tiny mb conversation-pills"><span className="pill">Effort {selectedVariant || t("default")}</span><span className="pill">{totalTokens === undefined ? "Tokens unavailable" : `${totalTokens.toLocaleString()} tokens`}</span><span className="pill">{session.cost === undefined ? "Cost unavailable" : `$${session.cost.toFixed(4)}`}</span><span className="pill">{session.parentId ? t("Subagent") : t("Primary session")}</span></div>
    <div className="tabs" role="tablist" aria-label="Session views">{([['chat','Conversation'],['changes','Changes'],['agents','Agents'],['logs','Logs']] as const).map(([id,label]) => <button className={`tab ${activeTab === id ? "active" : ""}`} role="tab" aria-selected={activeTab === id} type="button" key={id} onClick={() => setActiveTab(id)}>{label}</button>)}</div>
    <div className="conversation-content" key={activeTab}>
      {activeTab === "chat" && <div className="tabpane active conversation-stream" ref={scrollArea} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions text">
        {messages.length === 0 && !error && <div className="empty-state"><strong>{t("No messages in this session yet.")}</strong><span>{t("Ask OpenCode to begin.")}</span></div>}
        {messages.map((message) => <ChatMessageView message={message} onOpenFile={openAttachment} key={message.id} />)}
        {working && <p className="working" role="status"><span className="dot" />{t("OpenCode is working…")}</p>}{error && <p className="conversation-error" role="alert">{error}</p>}
      </div>}
      {activeTab === "changes" && <div className="tabpane active conversation-scroll">{changes.length ? <><ChangeSummary changes={changes} /><div className="diff-stack">{changes.map((change) => <DiffViewer {...change} key={`${change.file}-${change.status}`} />)}</div></> : <div className="card empty-state"><strong>{t("No file changes")}</strong><span>{t("This session has no structured diff data.")}</span></div>}</div>}
      {activeTab === "agents" && <div className="tabpane active conversation-scroll"><div className="card"><div className="row"><span className={working ? "dot" : "session-glyph"} /><div className="grow"><strong>{session.agent ?? "OpenCode"}</strong><div className="tiny muted">{model} · {session.parentId ? "Child session" : "Main agent"}</div></div><span className="pill">{working ? t("Working") : t("Idle")}</span></div></div><div className="card"><strong>{t("Tasks")}</strong>{todos.length === 0 ? <div className="empty-state compact"><span>{t("No tasks reported by OpenCode.")}</span></div> : todos.map((todo, index) => <div className="row" key={`${todo.content}-${index}`}><span className={todo.status === "completed" ? "session-glyph" : todo.status === "in_progress" ? "dot" : "session-glyph"} /><div className="grow"><span>{todo.content}</span><div className="tiny muted">{todo.priority} priority</div></div><span className="pill">{todo.status.replaceAll("_", " ")}</span></div>)}</div></div>}
      {activeTab === "logs" && <div className="tabpane active conversation-scroll"><div className="card"><strong>{t("Tool activity")}</strong>{activity.length === 0 ? <div className="empty-state compact"><strong>{t("No tool activity")}</strong><span>{t("This session has not reported structured tool events.")}</span></div> : activity.map((item) => <div className="row" key={`${item.id ?? item.name}-${item.createdAt}`}><div className="grow"><span className="tool-command">{item.title ?? item.name}</span><div className="tiny muted">{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(item.createdAt))}</div></div><span className="pill">{item.status}</span></div>)}</div></div>}
      {newMessages && activeTab === "chat" && <button className="new-messages" type="button" onClick={scrollToLatest}>{t("New messages ↓")}</button>}
    </div>
    {activeTab === "chat" && <form className="composer" onSubmit={propose}>
      <div className="prompt-controls">
        <label className="agent-control"><span>{t("Agent")}</span><select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)} aria-label="Agent for the next message"><option value="">{t("Session default")}</option>{availableAgents.map((agent) => <option value={agent.name} key={agent.name}>{agent.name}{agent.mode === "subagent" ? " · subagent" : ""}</option>)}</select></label>
        <div className="effort-control" aria-label="Reasoning effort"><span>{t("Effort")}</span><div>{effortVariants.length ? effortVariants.map((variant) => <button className={selectedVariant === variant ? "active" : ""} type="button" aria-pressed={selectedVariant === variant} onClick={() => setSelectedVariant(variant)} key={variant}>{variant}</button>) : <button className="active" type="button" disabled>{t("default")}</button>}</div></div>
      </div>
      {uploads.length > 0 && <div className="composer-attachments" aria-label="Attachments ready to send">{uploads.map((upload) => <span className="composer-attachment" key={upload.id}><Icon name="file" /><span><strong>{upload.name}</strong><small>{Math.max(1, Math.ceil(upload.size / 1024)).toLocaleString()} KB</small></span><button type="button" aria-label={`Remove ${upload.name}`} onClick={() => setUploads((current) => current.filter(({ id }) => id !== upload.id))}><Icon name="close" /></button></span>)}</div>}
      <div className="composer-row"><input ref={fileInput} className="sr-only" type="file" multiple accept=".txt,.md,.json,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.cc,.cpp,.h,.hpp,.css,.csv,.log,.sh,.sql,.toml,.xml,.yaml,.yml,.png,.jpg,.jpeg,.webp,.pdf" onChange={(event) => void uploadFiles(event)} /><button className="iconbtn" type="button" disabled={busy || uploading || uploads.length >= 4} title={uploads.length >= 4 ? "Maximum of 4 attachments" : t("Attach files")} aria-label={t("Attach files")} onClick={() => fileInput.current?.click()}>{uploading ? <span className="button-progress" /> : <Icon name="plus" />}</button><label className="sr-only" htmlFor="prompt">{t("Ask OpenCode")}</label><textarea id="prompt" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("Ask OpenCode...")} maxLength={8_000} rows={1} /><button className="iconbtn sendbtn" type="submit" disabled={busy || uploading || (!draft.trim() && uploads.length === 0)} aria-label={t("Review prompt")}><Icon name="send" /></button></div>
    </form>}
  </div>
  {proposal && <section className="approval" role="dialog" aria-modal="true" aria-labelledby="approval-title"><small>{t("PERMISSION REQUIRED")}</small><h2 id="approval-title" ref={approvalHeading} tabIndex={-1}>{proposal.type === "session.prompt" ? t("Send this prompt to OpenCode?") : t("Stop the current OpenCode run?")}</h2><blockquote>{proposal.type === "session.prompt" ? <>{proposal.text && <span>{proposal.text}</span>}<span className="approval-attachment">Agent: {proposal.agent ?? "session default"} · Model: {proposal.model?.name ?? "session default"} · Effort: {proposal.variant ?? t("default")}</span>{proposal.uploads?.map(({ id, name, size }) => <span className="approval-attachment" key={id}>{name} · {Math.max(1, Math.ceil(size / 1024)).toLocaleString()} KB</span>)}</> : "The active generation or tool execution will be interrupted."}</blockquote><div><button type="button" disabled={busy} onClick={() => void decide("deny")}>{t("Deny")}</button><button className="primary" type="button" disabled={busy} onClick={() => void decide("approve")}>{proposal.type === "session.prompt" ? t("Send") : t("Stop")}</button></div></section>}
  {permission && !proposal && <section className="approval" role="dialog" aria-modal="true" aria-labelledby="permission-title"><small>{t("OPENCODE PERMISSION")}</small><h2 id="permission-title" ref={approvalHeading} tabIndex={-1}>Allow {permission.action}?</h2><div className="permission-resources">{permission.resources.length === 0 ? "No resource details provided." : permission.resources.join("\n")}</div><div><button type="button" disabled={busy} onClick={() => void replyPermission("reject")}>{t("Deny")}</button><button className="primary" type="button" disabled={busy} onClick={() => void replyPermission("once")}>{t("Allow once")}</button></div></section>}
  </section>
}
