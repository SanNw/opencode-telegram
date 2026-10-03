import { useCallback, useEffect, useState } from "react"
import { AccessGate, type GateState } from "./AccessGate.js"
import { Dashboard } from "./Dashboard.js"
import {
  createStoredDeviceKey,
  getDeviceCredential,
  setDeviceCredential,
  signDeviceMessage,
} from "./device-auth.js"
import { stateAfterUnauthorized, stateForTelegramAuthStatus } from "./auth-status.js"
import { recoverDevice } from "./recovery-auth.js"

async function post(path: string, body: unknown) {
  return fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

export function App() {
  const [state, setState] = useState<GateState>({ kind: "authenticating" })

  const authenticate = useCallback(async () => {
    setState({ kind: "authenticating" })
    const initData = window.Telegram?.WebApp.initData
    if (!initData) return setState({ kind: "denied", reason: "missing_context" })

    try {
      const response = await post("/api/v1/auth/telegram", { initData })
      const immediateState = stateForTelegramAuthStatus(response.status)
      if (immediateState) return setState(immediateState)

      const credential = await getDeviceCredential()
      if (!credential) return setState({ kind: "untrusted" })
      const challengeResponse = await post("/api/v1/auth/challenge", {
        initData,
        deviceId: credential.deviceId,
      })
      if (!challengeResponse.ok) return setState({ kind: "untrusted" })
      const challenge = await challengeResponse.json() as { challengeId: string; nonce: string }
      const signature = await signDeviceMessage(
        credential.privateKey,
        `opencode-telegram:challenge:${challenge.challengeId}:${challenge.nonce}`,
      )
      const sessionResponse = await post("/api/v1/auth/session", {
        initData,
        deviceId: credential.deviceId,
        challengeId: challenge.challengeId,
        signature,
      })
      setState(sessionResponse.ok
        ? { kind: "authorized" }
        : { kind: "denied", reason: "invalid_session", status: sessionResponse.status })
    } catch {
      setState({ kind: "offline" })
    }
  }, [])

  const pair = useCallback(async (pairingCode: string) => {
    setState({ kind: "authenticating" })
    const webApp = window.Telegram?.WebApp
    if (!webApp?.initData) return setState({ kind: "denied", reason: "missing_context" })
    try {
      const keys = await createStoredDeviceKey()
      const proof = await signDeviceMessage(keys.privateKey, `opencode-telegram:pair:${pairingCode}`)
      const response = await post("/api/v1/devices/pair", {
        initData: webApp.initData,
        pairingCode,
        publicKey: keys.publicKey,
        label: `Telegram ${webApp.platform || "device"}`,
        proof,
      })
      if (!response.ok) return setState(response.status === 401
        ? { kind: "untrusted" }
        : { kind: "denied", reason: "invalid_session", status: response.status })
      const result = await response.json() as { deviceId: string }
      await setDeviceCredential({ deviceId: result.deviceId, privateKey: keys.privateKey })
      setState({ kind: "authorized" })
    } catch {
      setState({ kind: "offline" })
    }
  }, [])

  useEffect(() => {
    window.Telegram?.WebApp.ready()
    window.Telegram?.WebApp.expand()
    void authenticate()
  }, [authenticate])

  return (
    <AccessGate
      state={state}
      onRetry={() => void authenticate()}
      onPair={(code) => void pair(code)}
      onRecover={async (key) => {
        await recoverDevice(key, `Telegram ${window.Telegram?.WebApp.platform || "recovery device"}`)
        setState({ kind: "authorized" })
      }}
      onClose={() => window.Telegram?.WebApp.close()}
    >
      <Dashboard onUnauthorized={() => setState(stateAfterUnauthorized)} onLocked={(telegramCompromised) => setState({ kind: "locked", telegramCompromised })} />
    </AccessGate>
  )
}

