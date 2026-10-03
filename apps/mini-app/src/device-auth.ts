export type DeviceCredential = {
  deviceId: string
  privateKey: JsonWebKey | CryptoKey
}

const storageKey = "opencode_device"
const encoder = new TextEncoder()
let selectedStorage: "secure" | "local" | undefined

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = ""
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function secureStorage(): TelegramSecureStorage {
  const storage = window.Telegram?.WebApp.SecureStorage
  if (!storage) throw new Error("secure-storage-unavailable")
  return storage
}

export function hasSecureStorage(): boolean {
  return Boolean(window.Telegram?.WebApp.SecureStorage)
}

function localDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("opencode_telegram", 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("credentials")) {
        request.result.createObjectStore("credentials")
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("indexeddb-unavailable"))
  })
}

export async function localGetCredential(): Promise<DeviceCredential | undefined> {
  const database = await localDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction("credentials", "readonly").objectStore("credentials").get(storageKey)
      request.onsuccess = () => {
        const value = request.result as Partial<DeviceCredential> | undefined
        resolve(typeof value?.deviceId === "string" && value.privateKey instanceof CryptoKey
          ? value as DeviceCredential
          : undefined)
      }
      request.onerror = () => reject(request.error ?? new Error("indexeddb-read-failed"))
    })
  } finally {
    database.close()
  }
}

export async function localSetCredential(credential: DeviceCredential): Promise<void> {
  const database = await localDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("credentials", "readwrite")
      transaction.objectStore("credentials").put(credential, storageKey)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("indexeddb-write-failed"))
      transaction.onabort = () => reject(transaction.error ?? new Error("indexeddb-write-aborted"))
    })
  } finally {
    database.close()
  }
}

export async function getDeviceCredential(): Promise<DeviceCredential | undefined> {
  if (hasSecureStorage()) {
    try {
      const credential = await secureGetCredential()
      selectedStorage = "secure"
      return credential
    } catch {
      // Telegram Desktop may expose the API surface while reporting that the
      // native secure store is unsupported. Use a non-exportable local key.
    }
  }
  selectedStorage = "local"
  return localGetCredential()
}

export function setDeviceCredential(credential: DeviceCredential): Promise<void> {
  return selectedStorage === "secure" ? secureSetCredential(credential) : localSetCredential(credential)
}

export function secureGetCredential(): Promise<DeviceCredential | undefined> {
  return new Promise((resolve, reject) => secureStorage().getItem(storageKey, (error, value) => {
    if (error) return reject(new Error(error))
    if (!value) return resolve(undefined)
    try {
      const credential = JSON.parse(value) as Partial<DeviceCredential>
      resolve(typeof credential.deviceId === "string" && credential.privateKey ? credential as DeviceCredential : undefined)
    } catch {
      resolve(undefined)
    }
  }))
}

export function secureSetCredential(credential: DeviceCredential): Promise<void> {
  if (credential.privateKey instanceof CryptoKey) throw new Error("non-exportable-key")
  return new Promise((resolve, reject) => secureStorage().setItem(
    storageKey,
    JSON.stringify(credential),
    (error, stored) => error || !stored ? reject(new Error(error ?? "secure-storage-failed")) : resolve(),
  ))
}

export async function createNonExtractableDeviceKey(): Promise<{ publicKey: JsonWebKey; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )
  return {
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: pair.privateKey,
  }
}

export function createStoredDeviceKey() {
  return selectedStorage === "secure" ? createDeviceKey() : createNonExtractableDeviceKey()
}

export async function createDeviceKey(): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )
  return {
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  }
}

export async function signDeviceMessage(privateKey: JsonWebKey | CryptoKey, message: string): Promise<string> {
  const key = privateKey instanceof CryptoKey ? privateKey : await crypto.subtle.importKey(
    "jwk", privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  )
  return toBase64Url(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(message),
  ))
}
