import { t } from "../i18n.js"
import { CodeBlock } from "./CodeBlock.js"
import { DiffViewer } from "./DiffViewer.js"
import { Icon } from "./Icon.js"
import { MarkdownRenderer } from "./MarkdownRenderer.js"
import { ToolActivity } from "./ToolActivity.js"
import type { ChatMessage, FileChange, MessagePart } from "./chat-types.js"

export type MessageRendererProps = {
  parts: MessagePart[]
  onOpenFile?: ((fileId: string) => void) | undefined
  onOpenDiff?: ((change: FileChange) => void) | undefined
}

function attachmentSource(attachmentId: string): string | undefined {
  if (!/^att_[A-Za-z0-9_-]{32}$/.test(attachmentId)) return undefined
  return `/api/v1/attachments/${encodeURIComponent(attachmentId)}`
}

export function MessageRenderer({ parts, onOpenFile, onOpenDiff }: MessageRendererProps) {
  return <div className="message-parts">{parts.map((part, index) => {
    const key = `${part.type}-${index}`
    if (part.type === "markdown") return <MarkdownRenderer content={part.content} key={key} />
    if (part.type === "code") return <CodeBlock content={part.content} language={part.language} filename={part.filename} key={key} />
    if (part.type === "tool") return <ToolActivity {...part} key={key} />
    if (part.type === "diff") return <DiffViewer {...part} onOpenFile={onOpenDiff ? () => onOpenDiff(part) : onOpenFile} key={key} />
    if (part.type === "status") return <p className={`message-status message-status--${part.tone ?? "neutral"}`} role={part.tone === "error" ? "alert" : "status"} key={key}>{part.content}</p>
    if (part.type === "file") return <button className="file-attachment" type="button" disabled={!onOpenFile} onClick={() => onOpenFile?.(part.fileId)} key={key}><Icon name="file" /><span><strong>{part.name}</strong><small>{part.mime ?? part.path}{part.size !== undefined ? ` · ${part.size.toLocaleString()} bytes` : ""}</small></span></button>
    const src = attachmentSource(part.attachmentId)
    if (!src) return <div className="image-attachment image-attachment--unavailable" key={key}>{t("Image preview unavailable")}</div>
    return <a className="image-attachment" href={src} target="_blank" rel="noopener noreferrer" key={key}><img src={src} alt={part.alt ?? part.name ?? "Attached image"} loading="lazy" /></a>
  })}</div>
}

export type ChatMessageViewProps = Omit<MessageRendererProps, "parts"> & { message: ChatMessage; locale?: string }

function formatTime(value: string | number, locale?: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)
}

export function ChatMessageView({ message, locale, onOpenFile, onOpenDiff }: ChatMessageViewProps) {
  const visibleParts = message.parts.filter((part) => {
    if (part.type === "markdown" || part.type === "status") return part.content.trim().length > 0
    return true
  })
  if (visibleParts.length === 0) return null
  const time = formatTime(message.createdAt, locale)
  const status = message.status ?? "completed"
  return <article className={`chat-message chat-message--${message.role} chat-message--${status}`} data-message-id={message.id} aria-label={`${message.role} message${time ? ` at ${time}` : ""}`}>
    <div className="chat-message__content"><MessageRenderer parts={visibleParts} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} /></div>
    <footer className="chat-message__meta">{time && <time dateTime={new Date(message.createdAt).toISOString()}>{time}</time>}<span className="chat-message__state">{status === "sending" ? t("Sending") : status === "streaming" ? t("Streaming") : status === "failed" ? t("Failed") : ""}</span></footer>
  </article>
}
