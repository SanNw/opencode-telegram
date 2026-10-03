import { t } from "../i18n.js"
import { useCallback, useEffect, useState } from "react"

type Cache = { uploads: { count: number; bytes: number }; expiredUploads: { count: number; bytes: number }; expiredHandles: number }
export function CachePanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [cache, setCache] = useState<Cache>(), [proposal, setProposal] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState("")
  const load = useCallback(async () => {
    const response = await fetch("/api/v1/storage/cache", { credentials: "include" })
    if (response.status === 401) return onUnauthorized()
    if (!response.ok) throw new Error("cache")
    setCache(await response.json() as Cache)
  }, [onUnauthorized])
  useEffect(() => { void load().catch(() => setError("Cache information is unavailable.")) }, [load])
  const act = async (decision?: "approve" | "deny") => {
    if (busy) return
    setBusy(true); setError(""); setResult("")
    try {
      const response = await fetch(decision ? `/api/v1/actions/${encodeURIComponent(proposal!)}/decision` : "/api/v1/storage/cache/actions", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(decision ? { decision } : { type: "cache.cleanup" }),
      })
      if (response.status === 401) return onUnauthorized()
      if (!response.ok) throw new Error("cleanup")
      if (!decision) setProposal((await response.json() as { actionId: string }).actionId)
      else { setProposal(undefined); await load(); if (decision === "approve") setResult("Expired Bridge cache cleared. Workspace files and active uploads were preserved.") }
    } catch { setError("The cache action could not be completed. Refresh and try again.") }
    finally { setBusy(false) }
  }
  return <div className="card mb">
    <strong>{t("Bridge cache")}</strong>
    {cache ? <><div className="row"><span className="grow">Temporary uploads ({cache.uploads.count})</span><span>{cache.uploads.bytes.toLocaleString()} bytes</span></div><div className="row"><span className="grow">Expired uploads ({cache.expiredUploads.count})</span><span>{cache.expiredUploads.bytes.toLocaleString()} bytes</span></div><div className="row"><span className="grow">{t("Expired file/folder references")}</span><span>{cache.expiredHandles}</span></div></> : !error && <p className="loading">{t("Loading cache…")}</p>}
    <p className="tiny muted">{t("Only expired Bridge records can be removed here. OpenCode and plugin caches remain managed by OpenCode. Database disk space may be reused rather than immediately released.")}</p>
    <button className="btn" type="button" disabled={busy} onClick={() => void load().catch(() => setError("Cache information is unavailable."))}>{t("Refresh")}</button>{" "}
    <button className="btn" type="button" disabled={busy || !cache || cache.expiredUploads.count + cache.expiredHandles === 0} onClick={() => void act()}>{t("Clear expired cache")}</button>
    {error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
    {proposal && <section className="approval" role="dialog" aria-modal="true" aria-labelledby="cache-confirm-title"><h2 id="cache-confirm-title">{t("Clear expired Bridge cache?")}</h2><p>{t("This removes expired uploads and temporary file references. Deleted temporary records cannot be recovered. Your workspace files and conversations remain intact.")}</p><div><button type="button" autoFocus disabled={busy} onClick={() => void act("deny")}>{t("Cancel")}</button><button type="button" className="danger-button" disabled={busy} onClick={() => void act("approve")}>{t("Clear cache")}</button></div></section>}
  </div>
}
