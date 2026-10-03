import { createHmac, timingSafeEqual } from "node:crypto"

export type TelegramIdentity = {
  userId: string
  authDate: number
  queryId?: string
  replayKey: string
}

export type TelegramValidationOptions = {
  botToken: string
  ownerId: string
  maxAgeSeconds?: number
  nowSeconds?: number
}

export class TelegramAuthError extends Error {
  constructor() {
    super("Invalid Telegram authorization")
  }
}

type TelegramUser = { id?: unknown }

function parseStrictForm(raw: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const component of raw.split("&")) {
    const separator = component.indexOf("=")
    if (separator < 1) throw new TelegramAuthError()
    let key: string
    let value: string
    try {
      key = decodeURIComponent(component.slice(0, separator).replace(/\+/g, " "))
      value = decodeURIComponent(component.slice(separator + 1).replace(/\+/g, " "))
    } catch {
      throw new TelegramAuthError()
    }
    if (!key || values.has(key)) throw new TelegramAuthError()
    values.set(key, value)
  }
  return values
}

export function validateTelegramInitData(
  raw: string,
  options: TelegramValidationOptions,
): TelegramIdentity {
  if (!raw || Buffer.byteLength(raw, "utf8") > 16_384) throw new TelegramAuthError()

  const values = parseStrictForm(raw)

  const receivedHash = values.get("hash")
  const authDateRaw = values.get("auth_date")
  const userRaw = values.get("user")
  if (!receivedHash || !/^[a-f\d]{64}$/i.test(receivedHash) || !authDateRaw || !userRaw) {
    throw new TelegramAuthError()
  }

  values.delete("hash")
  const dataCheckString = [...values]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  const secretKey = createHmac("sha256", "WebAppData").update(options.botToken).digest()
  const calculatedHash = createHmac("sha256", secretKey).update(dataCheckString).digest()
  const receivedHashBytes = Buffer.from(receivedHash, "hex")
  if (!timingSafeEqual(calculatedHash, receivedHashBytes)) throw new TelegramAuthError()

  if (!/^\d+$/.test(authDateRaw)) throw new TelegramAuthError()
  const authDate = Number(authDateRaw)
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const maxAge = options.maxAgeSeconds ?? 300
  if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > maxAge) {
    throw new TelegramAuthError()
  }

  let user: TelegramUser
  try {
    user = JSON.parse(userRaw) as TelegramUser
  } catch {
    throw new TelegramAuthError()
  }
  if (
    !user ||
    typeof user !== "object" ||
    Array.isArray(user) ||
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    String(user.id) !== options.ownerId
  ) {
    throw new TelegramAuthError()
  }

  const queryId = values.get("query_id")

  return {
    userId: String(user.id),
    authDate,
    replayKey: receivedHash.toLowerCase(),
    ...(queryId ? { queryId } : {}),
  }
}

