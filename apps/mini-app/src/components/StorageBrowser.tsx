import { useCallback, useEffect, useMemo, useState } from "react"
import { CodeBlock } from "./CodeBlock.js"
import { Icon } from "./Icon.js"

type StorageEntry =
  | { id: string; type: "directory"; name: string }
  | { id: string; type: "file"; name: string; mime: string; size: number; preview: "image" | "text" | "download" }

type StorageListing = {
  directory: { id: string; name: string; parentId?: string }
  entries: StorageEntry[]
  nextCursor?: string
}

export function StorageBrowser({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [listing, setListing] = useState<StorageListing>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [preview, setPreview] = useState<{ entry: Extract<StorageEntry, { type: "file" }>; content?: string; loading?: boolean; error?: string }>()

  const loadDirectory = useCallback(async (directoryId: string, cursor?: string) => {
    setLoading(true); setError("")
    try {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : "?limit=50"
      const response = await fetch(`/api/v1/storage/directories/${encodeURIComponent(directoryId)}${suffix}`, { credentials: "include" })
      if (response.status === 401) return onUnauthorized()
      if (!response.ok) throw new Error("directory-unavailable")
      const next = await response.json() as StorageListing
      setListing((current) => cursor && current?.directory.id === next.directory.id
        ? { ...next, entries: [...current.entries, ...next.entries] }
        : next)
      if (!cursor) setQuery("")
    } catch {
      setError("This folder could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [onUnauthorized])

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/v1/storage/root", { credentials: "include" })
        if (response.status === 401) return onUnauthorized()
        if (!response.ok) throw new Error("root-unavailable")
        const body = await response.json() as { root: { id: string } }
        await loadDirectory(body.root.id)
      } catch {
        setLoading(false); setError("Workspace storage is unavailable.")
      }
    })()
  }, [loadDirectory, onUnauthorized])

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return listing?.entries.filter(({ name }) => !normalized || name.toLocaleLowerCase().includes(normalized)) ?? []
  }, [listing?.entries, query])
  const openFile = (id: string) => {
    if (!/^att_[A-Za-z0-9_-]{32}$/.test(id)) return
    window.open(`/api/v1/attachments/${encodeURIComponent(id)}`, "_blank", "noopener,noreferrer")
  }
  const openEntry = async (entry: StorageEntry) => {
    if (entry.type === "directory") return loadDirectory(entry.id)
    if (entry.preview === "download" && !entry.mime.startsWith("text/html")) return openFile(entry.id)
    setPreview({ entry, ...(entry.preview === "text" ? { loading: true } : {}) })
    if (entry.preview !== "text") return
    try {
      const response = await fetch(`/api/v1/attachments/${encodeURIComponent(entry.id)}`, { credentials: "include" })
      if (response.status === 401) return onUnauthorized()
      if (!response.ok) throw new Error("preview-unavailable")
      const content = await response.text()
      setPreview((current) => current?.entry.id === entry.id ? { entry, content } : current)
    } catch {
      setPreview((current) => current?.entry.id === entry.id ? { entry, error: "Preview could not be loaded." } : current)
    }
  }

  return <div className="storage-browser">
    <div className="storage-toolbar">
      <button className="iconbtn" type="button" disabled={!listing?.directory.parentId || loading} aria-label="Parent folder" onClick={() => listing?.directory.parentId && void loadDirectory(listing.directory.parentId)}><Icon name="arrow-left" /></button>
      <div className="grow truncate"><strong>{listing?.directory.name ?? "Workspace"}</strong><div className="tiny muted">Authorized workspace</div></div>
      <button className="iconbtn" type="button" disabled={!listing || loading} aria-label="Refresh folder" onClick={() => listing && void loadDirectory(listing.directory.id)}><Icon name="refresh" /></button>
    </div>
    <label className="sr-only" htmlFor="storage-search">Filter files</label>
    <input id="storage-search" className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter this folder" />
    {error && <div className="notice storage-notice" role="alert"><span>{error}</span><button className="btn" type="button" onClick={() => listing && void loadDirectory(listing.directory.id)}>Try again</button></div>}
    {loading && !listing && <p className="loading" role="status">Loading workspace…</p>}
    {!loading && !error && visible.length === 0 && <div className="empty-state"><strong>{query ? "No matching files" : "This folder is empty"}</strong><span>{query ? "Change the filter to see other entries." : "OpenCode has no visible files here."}</span></div>}
    <div className="storage-list">{visible.map((entry) => <button className="storage-entry" type="button" key={entry.id} onClick={() => void openEntry(entry)}>
      <span className={`storage-entry__icon storage-entry__icon--${entry.type}`}><Icon name={entry.type === "directory" ? "folder" : entry.preview === "image" ? "image" : "file"} /></span>
      <span className="grow truncate"><strong className="truncate">{entry.name}</strong><small>{entry.type === "directory" ? "Folder" : `${entry.mime} · ${entry.size.toLocaleString()} bytes`}</small></span>
      <Icon name={entry.type === "directory" ? "chevron-right" : "external"} />
    </button>)}</div>
    {listing?.nextCursor && !query && <button className="btn wfull" type="button" disabled={loading} onClick={() => void loadDirectory(listing.directory.id, listing.nextCursor)}>{loading ? "Loading…" : "Load more"}</button>}
    {preview && <section className="storage-preview" role="dialog" aria-modal="true" aria-labelledby="storage-preview-title">
      <div className="storage-preview__head"><strong className="grow truncate" id="storage-preview-title">{preview.entry.name}</strong><button className="iconbtn" type="button" autoFocus aria-label="Close preview" onClick={() => setPreview(undefined)}><Icon name="close" /></button></div>
      <div className="storage-preview__body">{preview.loading ? <p className="loading">Loading preview…</p> : preview.error ? <p className="conversation-error" role="alert">{preview.error}</p> : preview.entry.mime.startsWith("text/html") ? <><p className="tiny muted">Static preview · scripts, forms and external resources are blocked.</p><iframe className="html-preview" title={preview.entry.name} sandbox="" referrerPolicy="no-referrer" src={`/api/v1/attachments/${encodeURIComponent(preview.entry.id)}/preview`} /></> : preview.entry.preview === "image" ? <img src={`/api/v1/attachments/${encodeURIComponent(preview.entry.id)}`} alt={preview.entry.name} /> : <CodeBlock content={preview.content ?? ""} filename={preview.entry.name} />}</div>
      <div className="storage-preview__actions"><button className="btn" type="button" onClick={() => openFile(preview.entry.id)}>Open original</button><button className="btn primary" type="button" onClick={() => setPreview(undefined)}>Close</button></div>
    </section>}
  </div>
}
