import { createStoredDeviceKey, getDeviceCredential, setDeviceCredential, signDeviceMessage } from "./device-auth.js"
type RecoveryDependencies = {
  prepareStorage: typeof getDeviceCredential
  createKey: typeof createStoredDeviceKey
  sign: typeof signDeviceMessage
  store: typeof setDeviceCredential
  request: typeof fetch
}
export const recoveryRequest: typeof fetch = (...args) => fetch(...args)
const dependencies: RecoveryDependencies = { prepareStorage: getDeviceCredential, createKey: createStoredDeviceKey, sign: signDeviceMessage, store: setDeviceCredential, request: recoveryRequest }
export async function recoverDevice(recoveryKey: string, label: string, services: RecoveryDependencies = dependencies): Promise<void> {
  // Select native secure storage or the non-exportable IndexedDB fallback even
  // when Telegram initData and every previous device/session are unavailable.
  await services.prepareStorage()
  const keys = await services.createKey()
  const proof = await services.sign(keys.privateKey, `opencode-telegram:recover:${recoveryKey}`)
  const response = await services.request("/api/v1/security/recovery/unlock", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ recoveryKey, publicKey: keys.publicKey, label, proof }) })
  if (!response.ok) throw new Error(response.status === 429 ? "Too many recovery attempts. Wait before trying again." : "Recovery could not be verified. Check your key and try again.")
  const result = await response.json() as { deviceId: string }
  if (!result.deviceId) throw new Error("Recovery returned no device credential.")
  await services.store({ deviceId: result.deviceId, privateKey: keys.privateKey })
}
