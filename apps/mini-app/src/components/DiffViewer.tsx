import { t } from "../i18n.js"
import { useMemo, useState } from "react"
import { Icon } from "./Icon.js"
import type { DiffData, FileChangeStatus } from "./chat-types.js"

type DiffLine = { content: string; kind: "addition" | "deletion" | "context" | "meta"; oldNumber?: number; newNumber?: number }
export const MAX_DIFF_CHARACTERS = 300_000
export const MAX_DIFF_LINES = 5_000

function boundedDiff(diff: string): { content: string; truncated: boolean } {
  const characterBounded = diff.slice(0, MAX_DIFF_CHARACTERS)
  const lines = characterBounded.split("\n")
  const truncated = diff.length > MAX_DIFF_CHARACTERS || lines.length > MAX_DIFF_LINES
  return { content: lines.slice(0, MAX_DIFF_LINES).join("\n"), truncated }
}

export function parseUnifiedDiff(diff: string): DiffLine[] {
  let oldNumber = 0, newNumber = 0
  return boundedDiff(diff).content.split("\n").map((content) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(content)
    if (hunk) { oldNumber = Number(hunk[1]); newNumber = Number(hunk[2]); return { content, kind: "meta" } }
    if (content.startsWith("+++ ") || content.startsWith("--- ") || content.startsWith("diff ") || content.startsWith("index ")) return { content, kind: "meta" }
    if (content.startsWith("+")) return { content, kind: "addition", newNumber: newNumber++ }
    if (content.startsWith("-")) return { content, kind: "deletion", oldNumber: oldNumber++ }
    if (content.startsWith("\\")) return { content, kind: "meta" }
    return { content, kind: "context", oldNumber: oldNumber++, newNumber: newNumber++ }
  })
}

export function countDiffLines(diff: string): { additions: number; deletions: number } {
  return parseUnifiedDiff(diff).reduce((total, line) => ({ additions: total.additions + Number(line.kind === "addition"), deletions: total.deletions + Number(line.kind === "deletion") }), { additions: 0, deletions: 0 })
}

const statusLabel: Record<FileChangeStatus, string> = { created: t("Created"), modified: t("Modified"), deleted: t("Deleted"), renamed: t("Renamed") }

export type DiffViewerProps = DiffData & { defaultOpen?: boolean; onOpenFile?: ((fileId: string) => void) | undefined }

export function DiffViewer({ file, fileId, diff, status = "modified", additions, deletions, defaultOpen = false, onOpenFile }: DiffViewerProps) {
  const [open, setOpen] = useState(defaultOpen)
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const counts = useMemo(() => countDiffLines(diff), [diff])

  return <section className={`diff-viewer diff-viewer--${status}`}>
    <header className="diff-viewer__header">
      <button className="diff-viewer__toggle" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} /><strong>{file}</strong>
      </button>
      <span className="diff-viewer__status">{statusLabel[status]}</span>
      <span className="diff-viewer__counts"><b>+{additions ?? counts.additions}</b> <b>−{deletions ?? counts.deletions}</b></span>
      {onOpenFile && fileId && <button className="diff-viewer__open" type="button" onClick={() => onOpenFile(fileId)}>{t("Open file")}</button>}
    </header>
    {open && <div className="diff-viewer__body" role="table" aria-label={`Changes in ${file}`} tabIndex={0}>
      {lines.map((line, index) => <div className={`diff-line diff-line--${line.kind}`} role="row" key={`${index}-${line.content}`}>
        <span className="diff-line__number" role="cell">{line.oldNumber ?? ""}</span>
        <span className="diff-line__number" role="cell">{line.newNumber ?? ""}</span>
        <code role="cell">{line.content || " "}</code>
      </div>)}
      {boundedDiff(diff).truncated && <p className="content-truncated" role="status">{t("Diff truncated for safe display.")}</p>}
    </div>}
  </section>
}
