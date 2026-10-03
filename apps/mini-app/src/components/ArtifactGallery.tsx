import { t, stateLabel } from "../i18n.js"
import { useCallback, useEffect, useRef, useState } from "react"
import { attachmentUrl, controlErrorMessage, controlRequest, type ControlContext } from "../control-api.js"
import { FocusDialog } from "./ActionApproval.js"
import { CodeBlock } from "./CodeBlock.js"
import { Icon } from "./Icon.js"
import { MarkdownRenderer } from "./MarkdownRenderer.js"
type Artifact = { id: string; name: string; mime: string; size: number; preview: string; sessionId: string; createdAt: number; category: string }
type Listing = { artifacts: Artifact[]; nextCursor?: string }
export function ArtifactGallery({ context }: { context: ControlContext }) {
  const [category, setCategory] = useState("all"), [listing, setListing] = useState<Listing>(), [loading, setLoading] = useState(true), [error, setError] = useState(""), [preview, setPreview] = useState<Artifact>(), [content, setContent] = useState<string>(), [previewError, setPreviewError] = useState("")
  const generation = useRef(0)
  const load = useCallback(async (cursor?: string) => {
    const version = ++generation.current
    setLoading(true); setError("")
    try {
      const next = await controlRequest<Listing>(`/api/v1/artifacts?category=${category}&limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, context)
      if (version === generation.current) setListing((current) => cursor && current ? { ...next, artifacts: [...current.artifacts, ...next.artifacts] } : next)
    } catch (failure) { if (version === generation.current) setError(controlErrorMessage(failure)) } finally { if (version === generation.current) setLoading(false) }
  }, [category, context])
  useEffect(() => { setListing(undefined); void load(); return () => { generation.current++ } }, [load])
  useEffect(() => {
    setContent(undefined); setPreviewError("")
    if (!preview || preview.preview !== "text" || preview.mime.startsWith("text/html")) return
    const controller = new AbortController(), url = attachmentUrl(preview.id)
    if (!url) { setPreviewError(t("This artifact reference is invalid.")); return }
    void (async () => {
      try {
        const response = await fetch(url, { credentials: "include", signal: controller.signal })
        if (response.status === 401) return context.onUnauthorized()
        if (!response.ok) throw new Error("preview-unavailable")
        // Attachment reads are bounded server-side; enforce an additional browser rendering bound.
        if (Number(response.headers.get("content-length")) > 1_000_000) throw new Error("preview-too-large")
        const text = await response.text()
        if (text.length > 1_000_000) throw new Error("preview-too-large")
        if (!controller.signal.aborted) setContent(text)
      } catch { if (!controller.signal.aborted) setPreviewError(t("Preview unavailable or too large. Download the original artifact.")) }
    })()
    return () => controller.abort()
  }, [preview, context])
  return <div className="control-surface"><p className="small muted">{t("Useful outputs registered from OpenCode sessions in the authorized workspace.")}</p><div className="tabs" aria-label={t("Artifact categories")}>{(["all", "documents", "images", "code"] as const).map((value) => <button className={`tab ${category === value ? "active" : ""}`} type="button" aria-pressed={category === value} onClick={() => setCategory(value)} key={value}>{stateLabel(value)}</button>)}</div>{error && <div className="notice" role="alert"><span>{t(error)}</span><button className="btn" type="button" onClick={() => void load()}>{t("Try again")}</button></div>}{loading && !listing && <p className="loading" role="status">{t("Loading artifacts…")}</p>}{listing?.artifacts.length === 0 && <div className="card empty-state"><strong>{t(category === "all" ? "No artifacts yet" : category === "documents" ? "No documents yet" : category === "images" ? "No images yet" : "No code yet")}</strong><span>{t("Outputs appear when OpenCode shares files in a session. Browse Files for the complete workspace.")}</span></div>}<div className="grid2">{listing?.artifacts.map((artifact) => <article className="card artifact-card" key={artifact.id}><div className="flex"><Icon name={artifact.category === "images" ? "image" : "file"} /><strong className="grow truncate">{artifact.name}</strong></div><p className="tiny muted">{artifact.mime} · {artifact.size.toLocaleString()} {t("bytes")}</p><p className="tiny muted">{new Date(artifact.createdAt * 1000).toLocaleString()}</p><div className="control-actions"><button className="btn" type="button" disabled={!attachmentUrl(artifact.id)} onClick={() => setPreview(artifact)}>{t("Preview")}</button>{attachmentUrl(artifact.id) && <a className="btn" href={attachmentUrl(artifact.id)} target="_blank" rel="noopener noreferrer" download={artifact.name}>{t("Download")}</a>}</div></article>)}</div>{listing?.nextCursor && <button className="btn wfull mt" type="button" disabled={loading} onClick={() => void load(listing.nextCursor)}>{loading ? t("Loading…") : t("Load more artifacts")}</button>}{preview && <FocusDialog className="storage-preview" titleId="artifact-preview-title"><div className="storage-preview__head"><strong className="grow truncate" id="artifact-preview-title">{preview.name}</strong><button className="iconbtn" type="button" aria-label={t("Close artifact preview")} onClick={() => setPreview(undefined)}><Icon name="close" /></button></div><div className="storage-preview__body">{preview.mime.startsWith("text/html") ? <><p className="tiny muted">{t("Isolated preview · scripts and external resources blocked.")}</p><iframe className="html-preview" title={preview.name} sandbox="" referrerPolicy="no-referrer" src={attachmentUrl(preview.id, true)} /></> : preview.preview === "image" ? <img src={attachmentUrl(preview.id)} alt={preview.name} /> : previewError ? <p role="alert">{t(previewError)}</p> : preview.preview === "text" ? content === undefined ? <p role="status">{t("Loading preview…")}</p> : /\.(md|markdown)$/i.test(preview.name) ? <MarkdownRenderer content={content} /> : <CodeBlock content={content} filename={preview.name} /> : <p className="muted">{t("This format has no inline preview. Download the original file.")}</p>}</div><div className="storage-preview__actions"><a className="btn" href={attachmentUrl(preview.id)} target="_blank" rel="noopener noreferrer" download={preview.name}>{t("Download")}</a><button className="btn primary" type="button" onClick={() => setPreview(undefined)}>{t("Close")}</button></div></FocusDialog>}</div>
}
