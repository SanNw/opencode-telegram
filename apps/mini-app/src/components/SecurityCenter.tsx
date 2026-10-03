import { t, tf } from "../i18n.js"
import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from "react"
import { controlErrorMessage, controlRequest, secondsRemaining, type ControlContext } from "../control-api.js"
import { FocusDialog } from "./ActionApproval.js"
type SecurityState = { recoveryConfigured: boolean; locked: boolean; telegramCompromised: boolean }
export function SecurityCenter({ context, children, requested = false, expiresAt, onElevation, onLocked }: { context: ControlContext; children: ReactNode; requested?: boolean; expiresAt?: number | undefined; onElevation: (expiresAt: number | undefined) => void; onLocked: (telegramCompromised: boolean) => void }) {
  const [security, setSecurity] = useState<SecurityState>(), [key, setKey] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState(""), [now, setNow] = useState(Date.now()), [confirm, setConfirm] = useState<"lock" | "telegram-compromised">()
  const input = useRef<HTMLInputElement>(null)
  const [setupPending, setSetupPending] = useState(false)
  const load = useCallback(async () => { setSecurity(await controlRequest<SecurityState>("/api/v1/security", context)) }, [context])
  useEffect(() => { void load().catch((failure) => setError(controlErrorMessage(failure))) }, [load])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  useEffect(() => { if (requested) input.current?.focus() }, [requested, security])
  const setup = async () => {
    setSetupPending(true); setBusy(true); setError(""); setResult("")
    try { const response = await controlRequest<{ recoveryKey: string }>("/api/v1/security/recovery/setup", context, {}); setKey(response.recoveryKey); await load() }
    catch (failure) { setError(controlErrorMessage(failure)) } finally { setBusy(false); setSetupPending(false) }
  }
  const elevate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const recoveryKey = input.current?.value.trim() ?? ""
    event.currentTarget.reset(); setBusy(true); setError(""); setResult("")
    try {
      // An invalid independent factor is a 401 without invalidating the normal session.
      const response = await controlRequest<{ expiresAt: number }>("/api/v1/security/step-up", { ...context, onUnauthorized: () => undefined }, { recoveryKey })
      onElevation(response.expiresAt); setNow(Date.now()); setResult("Privileged session active. Return to your action and review it again.")
    } catch (failure) { onElevation(undefined); setError(controlErrorMessage(failure)) } finally { setBusy(false) }
  }
  const lock = async () => {
    setBusy(true); setError("")
    try { const state = await controlRequest<SecurityState>(`/api/v1/security/${confirm}`, context, {}); if (!state.locked) throw new Error("lock-not-confirmed"); setKey(undefined); onLocked(state.telegramCompromised) }
    catch (failure) { setError(controlErrorMessage(failure)); setConfirm(undefined) } finally { setBusy(false) }
  }
  const remaining = secondsRemaining(expiresAt, now)
  return <div className="security-center control-surface">
    <div className="card mb"><div className="flex"><strong className="grow">{t("OpenCode Lock")}</strong><span className="pill">{security ? security.telegramCompromised ? t("Telegram compromised") : security.locked ? t("Locked") : t("Remote access active") : t("Loading…")}</span></div><p className="small muted">{t("Independent recovery protects your OpenCode access and security changes.")}</p><div className="row"><span className="grow">{t("Recovery Key")}</span><span className="pill">{security?.recoveryConfigured ? t("Configured") : t("Not configured")}</span></div>{security && !security.recoveryConfigured && <button type="button" className="btn" disabled={busy} onClick={() => void setup()}>{t("Set up Recovery Key")}</button>}<p className="tiny muted">{t("Keep the key outside Telegram in your password manager. It is never sent to a conversation.")}</p></div>
    <div className="card mb"><strong>{t("Step-up authentication")}</strong><p className="small muted" role="status">{remaining ? tf("Privileged session: {time} remaining", { time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` }) : expiresAt ? t("Privileged session expired. Authenticate again for sensitive actions.") : t("Sensitive actions require a temporary five-minute privileged session.")}</p><form className="control-form" onSubmit={elevate}><label htmlFor="step-up-key">{t("Recovery Key")}</label><input ref={input} id="step-up-key" className="input" type="password" autoComplete="off" spellCheck={false} required maxLength={128} disabled={!security?.recoveryConfigured || busy} /><button type="submit" className="btn primary" disabled={!security?.recoveryConfigured || busy}>{t("Authenticate")}</button></form>{result && <p className="small" role="status">{t(result)}</p>}</div>
    <div className="card mb"><strong>{t("Remote access controls")}</strong><p className="small muted">{t("These controls revoke remote sessions and freeze pending actions. Unlock requires your independent Recovery Key.")}</p><div className="control-actions"><button type="button" className="btn danger" disabled={!security?.recoveryConfigured || busy} onClick={() => setConfirm("lock")}>{t("Lock remote access")}</button><button type="button" className="btn danger" disabled={!security?.recoveryConfigured || busy} onClick={() => setConfirm("telegram-compromised")}>{t("Telegram account compromised")}</button></div></div>
    {error && <p className="conversation-error" role="alert">{t(error)}</p>}{children}
    {(setupPending || key) && <FocusDialog titleId="recovery-key-title"><h2 id="recovery-key-title">{key ? t("Save your Recovery Key now") : t("Creating your Recovery Key")}</h2>{!key ? <p role="status">{t("Keep this screen open while the independent recovery credential is created…")}</p> : <><p className="small">{t("This key is displayed only once. Save it outside Telegram, preferably in a password manager.")}</p><code className="recovery-key">{key}</code><p className="tiny muted" role="status">{t(result)}</p><div><button type="button" onClick={() => void navigator.clipboard.writeText(key).then(() => setResult("Copied. Save it in your password manager.")).catch(() => setResult("Copy unavailable. Select and save the displayed key."))}>{t("Copy key")}</button><button type="button" className="primary" onClick={() => { setKey(undefined); setResult("") }}>{t("I saved my key")}</button></div></>}</FocusDialog>}
    {confirm && <FocusDialog titleId="lock-confirm-title"><h2 id="lock-confirm-title">{confirm === "lock" ? t("Lock remote access?") : t("Mark Telegram as compromised?")}</h2><p className="small">{t("Remote sessions will be revoked, pending actions frozen, and write integrations blocked. Recovery revokes existing devices and creates a new trusted device. Local project data and audit evidence are preserved.")}</p><div><button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>{t("Cancel")}</button><button type="button" className="danger-button" disabled={busy} onClick={() => void lock()}>{busy ? t("Locking…") : t("Confirm lock")}</button></div></FocusDialog>}
  </div>
}
