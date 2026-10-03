import { createPublicKey, verify, type JsonWebKey as NodeJsonWebKey } from "node:crypto"
import { TelegramAuthError } from "./telegram.js"

export function normalizeDevicePublicKey(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TelegramAuthError()
  try {
    const key = createPublicKey({ key: value as NodeJsonWebKey, format: "jwk" })
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new TelegramAuthError()
    }
    return JSON.stringify(key.export({ format: "jwk" }))
  } catch (error) {
    if (error instanceof TelegramAuthError) throw error
    throw new TelegramAuthError()
  }
}

export function normalizeDeviceLabel(value: unknown): string {
  if (typeof value !== "string") throw new TelegramAuthError()
  const label = value.trim()
  if (!label || label.length > 64) throw new TelegramAuthError()
  return label
}

export function verifyDeviceSignature(publicKeyJwk: string, message: string, signature: unknown) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    throw new TelegramAuthError()
  }
  const bytes = Buffer.from(signature, "base64url")
  if (bytes.length !== 64) throw new TelegramAuthError()
  try {
    const key = createPublicKey({ key: JSON.parse(publicKeyJwk) as NodeJsonWebKey, format: "jwk" })
    if (!verify("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" }, bytes)) {
      throw new TelegramAuthError()
    }
  } catch (error) {
    if (error instanceof TelegramAuthError) throw error
    throw new TelegramAuthError()
  }
}

