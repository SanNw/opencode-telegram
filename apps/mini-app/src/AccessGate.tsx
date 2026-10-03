import { t } from "./i18n.js"
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"

export type GateState =
  | { kind: "authenticating" }
  | { kind: "untrusted" }
  | { kind: "denied"; reason?: "missing_context" | "invalid_session"; status?: number }
  | { kind: "offline" }
  | { kind: "authorized" }
  | { kind: "locked"; telegramCompromised: boolean }

type AccessGateProps = {
  state: GateState
  onRetry: () => void
  onPair: (code: string) => void
  onClose: () => void
  onRecover?: (key: string) => Promise<void>
  children: ReactNode
}

export function AccessGate({ state, onRetry, onPair, onClose, onRecover, children }: AccessGateProps) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [pairingCode, setPairingCode] = useState("")
  const [recovering, setRecovering] = useState(false), [recoveryError, setRecoveryError] = useState("")

  useEffect(() => {
    if (state.kind !== "authorized") heading.current?.focus()
  }, [state.kind])

  if (state.kind === "authorized") return children

  const submitPairing = (event: FormEvent) => {
    event.preventDefault()
    if (pairingCode.trim()) onPair(pairingCode.trim())
  }

  return (
    <main className="access-gate" aria-busy={state.kind === "authenticating"}>
      <section className="access-card" aria-labelledby="access-title">
        <div className="access-mark" aria-hidden="true">OC</div>

        {state.kind === "authenticating" && (
          <>
            <h1 id="access-title" ref={heading} tabIndex={-1}>{t("Connecting securely")}</h1>
            <p role="status" aria-live="polite">{t("Verifying your Telegram session and device…")}</p>
            <span className="spinner" aria-hidden="true" />
          </>
        )}

        {state.kind === "untrusted" && (
          <>
            <h1 id="access-title" ref={heading} tabIndex={-1}>{t("New device")}</h1>
            <p>{t("Telegram account verified.")}</p>
            <p>{t("Enter the one-time code shown by the Bridge on the OpenCode host.")}</p>
            <form onSubmit={submitPairing}>
              <label htmlFor="pairing-code">{t("Pairing code")}</label>
              <input
                id="pairing-code"
                name="pairing-code"
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value)}
                autoComplete="one-time-code"
                spellCheck={false}
                required
              />
              <button className="primary" type="submit">{t("Trust this device")}</button>
            </form>
            <button className="secondary" type="button" onClick={onClose}>{t("Close")}</button>
          </>
        )}

        {state.kind === "denied" && (
          <>
            <h1 id="access-title" ref={heading} tabIndex={-1}>{t("Access unavailable")}</h1>
            <p>{state.reason === "missing_context"
              ? "Telegram did not provide an authenticated Mini App context. Open this page from the bot menu inside Telegram."
              : `Telegram opened the Mini App, but the signed session could not be validated${state.status ? ` (HTTP ${state.status})` : ""}.`}</p>
            <button className="primary" type="button" onClick={onClose}>{t("Close")}</button>
          </>
        )}

        {state.kind === "offline" && (
          <>
            <h1 id="access-title" ref={heading} tabIndex={-1}>{t("Bridge offline")}</h1>
            <p>{t("The secure Bridge could not be reached. No OpenCode data was loaded.")}</p>
            <button className="primary" type="button" onClick={onRetry}>{t("Try again")}</button>
          </>
        )}
        {state.kind === "locked" && <>
          <h1 id="access-title" ref={heading} tabIndex={-1}>{state.telegramCompromised ? "Telegram marked as compromised" : t("Remote access locked")}</h1>
          <p role="status">{state.telegramCompromised ? "Your Telegram-compromised action succeeded. Remote access is locked, sessions were revoked and pending actions frozen." : "Your lock action succeeded. Remote sessions were revoked and pending actions frozen."}</p>
          <p>{t("Unlock with your independent Recovery Key below. Local OpenCode data and audit evidence are preserved.")}</p>
          <button className="secondary" type="button" onClick={onClose}>{t("Close")}</button>
        </>}
        {onRecover && state.kind !== "authenticating" && <details className="gate-recovery">
          <summary>{t("Recover or unlock access")}</summary>
          <p>{t("Use your independent Recovery Key. Existing devices will be revoked and this device will become trusted.")}</p>
          <form onSubmit={(event) => {
            event.preventDefault()
            const form = event.currentTarget, key = String(new FormData(form).get("recoveryKey") ?? "").trim()
            form.reset(); setRecovering(true); setRecoveryError("")
            void onRecover(key).catch((failure: unknown) => setRecoveryError(failure instanceof Error ? failure.message : "Recovery unavailable.")).finally(() => setRecovering(false))
          }}>
            <label htmlFor="access-recovery-key">{t("Recovery Key")}</label>
            <input id="access-recovery-key" name="recoveryKey" type="password" autoComplete="off" spellCheck={false} maxLength={128} required disabled={recovering} />
            <button className="primary" type="submit" disabled={recovering}>{recovering ? t("Recovering…") : t("Recover this device")}</button>
          </form>
          {recoveryError && <p role="alert">{recoveryError}</p>}
        </details>}
      </section>
    </main>
  )
}

