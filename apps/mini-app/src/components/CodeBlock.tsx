import { t } from "../i18n.js"
import { useState } from "react"

export type CodeBlockProps = {
  content: string
  language?: string | undefined
  filename?: string | undefined
}

export function CodeBlock({ content, language, filename }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_600)
    } catch {
      setCopied(false)
    }
  }

  return <figure className="code-block">
    <figcaption className="code-block__header">
      <span className="code-block__label">{filename ?? language ?? t("Code")}</span>
      <button className="code-block__copy" type="button" onClick={() => void copy()} aria-label={copied ? t("Code copied") : t("Copy code")}>
        {copied ? t("Copied") : t("Copy")}
      </button>
    </figcaption>
    <pre tabIndex={0}><code className={language ? `language-${language}` : undefined}>{content}</code></pre>
  </figure>
}
