import { useState } from "react"
import { Icon } from "./Icon.js"
import type { ToolActivityData } from "./chat-types.js"

const statusLabel = { pending: "Pending", running: "Running", completed: "Completed", error: "Failed" } as const

export type ToolActivityProps = ToolActivityData & { defaultOpen?: boolean }

export function ToolActivity({ name, title, status, input, output, defaultOpen = false }: ToolActivityProps) {
  const [open, setOpen] = useState(defaultOpen)
  const hasDetails = Boolean(input || output)
  const label = title ?? name

  return <section className={`tool-activity tool-activity--${status}`} aria-label={`${label}: ${statusLabel[status]}`}>
    <button className="tool-activity__summary" type="button" disabled={!hasDetails} aria-expanded={hasDetails ? open : undefined} onClick={() => setOpen((value) => !value)}>
      <span className={`tool-activity__icon tool-activity__icon--${status}`} aria-hidden="true">{status === "completed" ? <Icon name="check" /> : status === "error" ? <Icon name="close" /> : null}</span>
      <span className="tool-command">{label}</span>
      <span className="tool-activity__status">{statusLabel[status]}</span>
      {hasDetails && <Icon name={open ? "chevron-down" : "chevron-right"} />}
    </button>
    {open && hasDetails && <div className="tool-activity__details">
      {input && <div><span>Input</span><pre>{input}</pre></div>}
      {output && <div><span>Output</span><pre>{output}</pre></div>}
    </div>}
  </section>
}
