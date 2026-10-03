import Markdown, { defaultUrlTransform, type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { CodeBlock } from "./CodeBlock.js"

export type MarkdownRendererProps = { content: string; className?: string }
export const MAX_MARKDOWN_CHARACTERS = 100_000

function safeUrlTransform(url: string): string {
  const normalized = defaultUrlTransform(url)
  return /^(?:https?:|mailto:|tel:|#)/i.test(normalized) || /^\/(?!\/)/.test(normalized) ? normalized : ""
}

const components: Components = {
  a({ href, children, ...props }) {
    if (!href) return <span>{children}</span>
    return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  },
  code({ className, children, ...props }) {
    const content = String(children).replace(/\n$/, "")
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1]
    if (language || content.includes("\n")) return <CodeBlock content={content} language={language} />
    return <code {...props} className={className}>{children}</code>
  },
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const truncated = content.length > MAX_MARKDOWN_CHARACTERS
  const safeContent = truncated ? content.slice(0, MAX_MARKDOWN_CHARACTERS) : content
  return <div className={["markdown", className].filter(Boolean).join(" ")}>
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={safeUrlTransform}
      disallowedElements={["img", "iframe", "object", "embed", "script", "style"]}
      unwrapDisallowed
      components={components}
    >{safeContent}</Markdown>
    {truncated && <p className="content-truncated" role="status">Message truncated for safe display.</p>}
  </div>
}
