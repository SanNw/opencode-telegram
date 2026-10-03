import { redactText } from "./redact.js"

/** Persistable metadata only. Credentials deliberately cannot be represented here. */
export type ManagementMutation =
  | { type: "skill.url.add" | "skill.url.remove"; url: string }
  | { type: "mcp.remote.add"; name: string; url: string }
  | { type: "mcp.connect" | "mcp.disconnect" | "mcp.disable" | "mcp.remove"; name: string }
  | { type: "plugin.add" | "plugin.remove"; package: string }
  | { type: "provider.key.connect" | "provider.credential.remove"; providerId: string }

export const managementTypes = ["skill.url.add", "skill.url.remove", "mcp.remote.add", "mcp.connect", "mcp.disconnect", "mcp.disable", "mcp.remove", "plugin.add", "plugin.remove", "provider.key.connect", "provider.credential.remove"] as const
export const isManagementType = (value: string): value is ManagementMutation["type"] => managementTypes.some((type) => type === value)

export function normalizeManagementName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value.toLowerCase())) throw new Error("Invalid management name")
  return value
}

/** One bounded policy for read, proposal and dispatch; never rewrite a secret URL. */
export function assertManagementUrlSecretFree(value: string, knownSecrets: readonly string[] = []): void {
  const url = new URL(value)
  const representations = new Set([value, url.href, url.pathname, ...url.pathname.split("/")])
  for (const original of [...representations]) {
    let decoded = original
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = decodeURIComponent(decoded)
      representations.add(next)
      if (next === decoded) break
      decoded = next
    }
    if (/%[a-f0-9]{2}/i.test(decoded)) throw new Error("Nested URL encoding is unsupported")
  }
  for (const representation of representations) {
    if (redactText(representation, knownSecrets) !== representation || knownSecrets.some((secret) => secret.length > 0 && representation.includes(secret)) ||
      /(?:api[_-]?key|token|secret|password|authorization)[=:/]/i.test(representation)) throw new Error("Credential-bearing URLs are unsupported")
  }
}

export function normalizeManagementUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid management URL")
  const url = new URL(value)
  assertManagementUrlSecretFree(value)
  const hostname = url.hostname.toLowerCase()
  // Only public HTTPS endpoints. Query credentials, local hosts and literal IPs
  // are outside this API; DNS/network policy remains the OpenCode host's boundary.
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    (url.port && url.port !== "443") || !hostname.includes(".") || hostname.endsWith(".") ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(":") ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname)) throw new Error("Invalid management URL")
  return url.href
}

export function normalizePluginPackage(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)?$/.test(value)) throw new Error("Invalid plugin package")
  return value
}

/** Whitelist fields again when recovering persisted metadata. */
export function normalizeManagementMutation(input: unknown): ManagementMutation {
  if (!input || typeof input !== "object") throw new Error("Invalid management mutation")
  const item = input as Record<string, unknown>
  if (typeof item.type !== "string" || !isManagementType(item.type)) throw new Error("Invalid management mutation")
  switch (item.type) {
    case "skill.url.add": case "skill.url.remove": return { type: item.type, url: normalizeManagementUrl(item.url) }
    case "mcp.remote.add": return { type: item.type, name: normalizeManagementName(item.name), url: normalizeManagementUrl(item.url) }
    case "mcp.connect": case "mcp.disconnect": case "mcp.disable": case "mcp.remove": return { type: item.type, name: normalizeManagementName(item.name) }
    case "plugin.add": case "plugin.remove": return { type: item.type, package: normalizePluginPackage(item.package) }
    case "provider.key.connect": case "provider.credential.remove": return { type: item.type, providerId: normalizeManagementName(item.providerId) }
  }
}
