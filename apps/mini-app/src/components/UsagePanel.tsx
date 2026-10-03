import { useEffect, useState } from "react"

type Totals = { messages: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number }
type Usage = {
  totals: Totals; daily: (Totals & { label: string })[]
  breakdown: Record<string, (Totals & { label: string })[]>
  collection: { running: boolean; failed: boolean; lastSyncedAt: string | null }
}
export function UsagePanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [period, setPeriod] = useState("today"), [data, setData] = useState<Usage>(), [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    setData(undefined); setError(false)
    const load = async () => {
      try {
        const response = await fetch(`/api/v1/usage?period=${period}`, { credentials: "include" })
        if (response.status === 401) return onUnauthorized()
        if (!response.ok) throw new Error("usage")
        const next = await response.json() as Usage
        if (active) { setData(next); setError(false) }
      } catch { if (active) setError(true) }
    }
    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => { active = false; clearInterval(timer) }
  }, [period, onUnauthorized])
  return <div className="card usage-panel">
    <strong>Usage history</strong>
    <div className="tabs" aria-label="Usage period">{[["today", "Today"], ["week", "7 days"], ["month", "30 days"]].map(([id, label]) => <button className={`tab ${period === id ? "active" : ""}`} key={id} type="button" aria-pressed={period === id} onClick={() => setPeriod(id!)}>{label}</button>)}</div>
    {error && <p role="alert">Usage could not be refreshed.</p>}
    {!data && !error && <p className="loading">Loading usage…</p>}
    {data && <>
      <p className="tiny muted">UTC · OpenCode-reported cost, not a billing statement.</p>
      <div className="usage-values"><div><span>Input</span><strong>{data.totals.input.toLocaleString()}</strong></div><div><span>Output</span><strong>{data.totals.output.toLocaleString()}</strong></div><div><span>Reasoning</span><strong>{data.totals.reasoning.toLocaleString()}</strong></div></div>
      <p className="small">{data.totals.messages} completed messages · ${data.totals.cost.toFixed(4)}</p>
      <p className="tiny muted">Cache read: {data.totals.cacheRead.toLocaleString()} · write: {data.totals.cacheWrite.toLocaleString()}</p>
      {data.collection.failed ? <p role="status">Collection interrupted. Showing previously collected records.</p> : data.collection.running ? <p role="status">Synchronizing message history…</p> : null}
      {data.collection.lastSyncedAt && <p className="tiny muted">Last sync: {new Date(data.collection.lastSyncedAt).toLocaleString()}</p>}
      {!data.totals.messages && <p className="muted">No completed messages collected in this period.</p>}
      <details><summary>Daily usage and breakdown</summary>
        {[['Daily (UTC)', data.daily], ...Object.entries(data.breakdown)].map(([label, rows]) => <section key={String(label)}><div className="sectionTitle">{label === "projectId" ? "Project" : String(label)}</div><div className="catalog-list">{(rows as Usage["daily"]).map((row) => <div className="row" key={row.label}><span className="grow truncate" title={row.label}>{row.label || "Not reported"}</span><span className="tiny">{(row.input + row.output + row.reasoning).toLocaleString()} tokens · ${row.cost.toFixed(4)}</span></div>)}</div></section>)}
      </details>
    </>}
  </div>
}
