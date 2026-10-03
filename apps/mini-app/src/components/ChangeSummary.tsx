import { t } from "../i18n.js"
import { useMemo } from "react"
import { countDiffLines } from "./DiffViewer.js"
import type { FileChange, FileChangeStatus } from "./chat-types.js"

const statusLabel: Record<FileChangeStatus, string> = { created: t("Created"), modified: t("Modified"), deleted: t("Deleted"), renamed: t("Renamed") }

export type ChangeSummaryProps = { changes: FileChange[]; title?: string; onSelect?: (change: FileChange) => void }

export function ChangeSummary({ changes, title = t("Changes made"), onSelect }: ChangeSummaryProps) {
  const totals = useMemo(() => changes.reduce((result, change) => {
    const counted = countDiffLines(change.diff)
    return { additions: result.additions + (change.additions ?? counted.additions), deletions: result.deletions + (change.deletions ?? counted.deletions) }
  }, { additions: 0, deletions: 0 }), [changes])

  return <section className="change-summary">
    <header className="change-summary__header"><div><strong>{title}</strong><p>{changes.length} {t(changes.length === 1 ? "file" : "files")} {t("changed")} · <b>+{totals.additions}</b> <b>−{totals.deletions}</b></p></div></header>
    <div className="change-summary__files">
      {changes.map((change) => {
        const content = <><span className="change-summary__path">{change.file}</span><span className="change-summary__status">{statusLabel[change.status ?? "modified"]}</span></>
        return onSelect
          ? <button type="button" className="change-summary__file" key={`${change.file}-${change.status}`} onClick={() => onSelect(change)}>{content}</button>
          : <div className="change-summary__file" key={`${change.file}-${change.status}`}>{content}</div>
      })}
    </div>
  </section>
}
