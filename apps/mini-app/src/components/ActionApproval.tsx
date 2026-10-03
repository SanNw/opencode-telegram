import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { controlErrorMessage, controlRequest, secondsRemaining, type ControlContext, type Proposal } from "../control-api.js"
import { isolateModalBackground } from "../modal-boundary.js"

export function FocusDialog({ children, titleId, className = "approval" }: { children: React.ReactNode; titleId: string; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    if (typeof element.showModal === "function") element.showModal()
    else element.setAttribute("open", "")
    const restoreBackground = isolateModalBackground(element)
    const focusInside = () => (element.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled),a[href],[tabindex='0']") ?? element).focus()
    focusInside()
    const guardFocus = (event: FocusEvent) => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) focusInside()
    }
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return
      const controls = [...element.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),a[href],[tabindex='0']")]
      if (!controls.length) { event.preventDefault(); return }
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      if (!element.contains(document.activeElement)) { event.preventDefault(); focusInside() }
    }
    document.addEventListener("keydown", trap)
    document.addEventListener("focusin", guardFocus)
    return () => {
      document.removeEventListener("keydown", trap); document.removeEventListener("focusin", guardFocus)
      if (element.open && typeof element.close === "function") element.close()
      restoreBackground()
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return <dialog ref={dialog} className="control-modal" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby={titleId} onCancel={(event) => event.preventDefault()}><section className={className}>{children}</section></dialog>
}

export const approvalSecondaryAction = (expired: boolean, error: string): "dismiss" | "deny" => expired || error ? "dismiss" : "deny"

export function ActionApproval({ proposal, context, onDone, onDismiss, onFailure }: { proposal: Proposal; context: ControlContext; onDone: (decision: "approve" | "deny") => void; onDismiss: () => void; onFailure?: (error: unknown) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const expired = proposal.expiresAt !== undefined && secondsRemaining(proposal.expiresAt, now) === 0
  const decide = async (decision: "approve" | "deny") => {
    setBusy(true); setError("")
    try {
      await controlRequest(`/api/v1/actions/${encodeURIComponent(proposal.actionId)}/decision`, context, { decision })
      onDone(decision)
    } catch (failure) { setError(controlErrorMessage(failure)); onFailure?.(failure) }
    finally { setBusy(false) }
  }
  return <FocusDialog titleId="action-approval-title"><small>Permission required</small><h2 id="action-approval-title">Review this action</h2><blockquote>{proposal.summary}</blockquote><p className="tiny muted">Requires a current privileged session. {expired ? "This proposal expired. Dismiss it and review a new action." : "Approval applies only to this action."}</p>{error && <p role="alert">{error}</p>}<div><button type="button" disabled={busy} onClick={() => approvalSecondaryAction(expired, error) === "dismiss" ? onDismiss() : void decide("deny")}>{error || expired ? "Dismiss" : "Deny"}</button><button type="button" className="primary" disabled={busy || expired || Boolean(error)} onClick={() => void decide("approve")}>{busy ? "Working…" : "Approve"}</button></div></FocusDialog>
}
