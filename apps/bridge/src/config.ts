export type BridgeConfig = {
  bridgeHost: string
  bridgePort: number
  databasePath: string
  openCodeUrl: URL
  openCodeDirectory: string
  openCodeUsername: string
  openCodePassword?: string
  /** Exact trusted remote destinations; empty means no new skill/MCP egress. */
  managementAllowedHosts?: string[]
  telegram?: {
    botToken: string
    ownerId: string
    miniAppUrl?: string
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])

export function readConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const bridgeHost = env.BRIDGE_HOST ?? "127.0.0.1"
  if (!LOOPBACK_HOSTS.has(bridgeHost)) {
    throw new Error("BRIDGE_HOST must be loopback until Bridge authentication is implemented")
  }

  const bridgePort = Number(env.BRIDGE_PORT ?? 8787)
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65_535) {
    throw new Error("BRIDGE_PORT must be an integer between 1 and 65535")
  }

  const databasePath = env.BRIDGE_DATABASE_PATH ?? "./data/bridge.sqlite"
  if (!databasePath.trim() || databasePath.includes("\0")) {
    throw new Error("BRIDGE_DATABASE_PATH must be a valid path")
  }

  const openCodeUrl = new URL(env.OPENCODE_URL ?? "http://127.0.0.1:4096")
  if (!new Set(["http:", "https:"]).has(openCodeUrl.protocol)) {
    throw new Error("OPENCODE_URL must use http or https")
  }
  if (openCodeUrl.username || openCodeUrl.password) {
    throw new Error("Keep OpenCode credentials out of OPENCODE_URL")
  }
  const openCodeDirectory = env.OPENCODE_DIRECTORY ?? process.cwd()
  if (!openCodeDirectory.trim() || openCodeDirectory.includes("\0")) {
    throw new Error("OPENCODE_DIRECTORY must be a valid server-side path")
  }
  const managementAllowedHosts = [...new Set((env.MANAGEMENT_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))]
  if (managementAllowedHosts.some((host) => !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host))) throw new Error("MANAGEMENT_ALLOWED_HOSTS must contain exact DNS hostnames")

  const botToken = env.TELEGRAM_BOT_TOKEN
  const ownerId = env.TELEGRAM_OWNER_ID
  const miniAppUrl = env.TELEGRAM_MINI_APP_URL
  if (Boolean(botToken) !== Boolean(ownerId)) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID must be configured together")
  }
  if (botToken && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    throw new Error("TELEGRAM_BOT_TOKEN has an invalid format")
  }
  if (ownerId && !/^\d{1,16}$/.test(ownerId)) {
    throw new Error("TELEGRAM_OWNER_ID must be a positive numeric Telegram user ID")
  }
  if (!botToken && env.ALLOW_INSECURE_LOCAL_DEV !== "true") {
    throw new Error("Telegram authentication is required unless ALLOW_INSECURE_LOCAL_DEV=true")
  }
  if (miniAppUrl && (new URL(miniAppUrl).protocol !== "https:" || new URL(miniAppUrl).username || new URL(miniAppUrl).password)) {
    throw new Error("TELEGRAM_MINI_APP_URL must be an HTTPS URL without credentials")
  }

  return {
    bridgeHost,
    bridgePort,
    databasePath,
    openCodeUrl,
    openCodeDirectory,
    managementAllowedHosts,
    openCodeUsername: env.OPENCODE_SERVER_USERNAME ?? "opencode",
    ...(env.OPENCODE_SERVER_PASSWORD ? { openCodePassword: env.OPENCODE_SERVER_PASSWORD } : {}),
    ...(botToken && ownerId ? { telegram: { botToken, ownerId, ...(miniAppUrl ? { miniAppUrl } : {}) } } : {}),
  }
}

