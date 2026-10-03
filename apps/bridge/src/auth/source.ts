import { isIP } from "node:net"

function canonicalIp(value: string | undefined): string | undefined {
  if (!value || value.includes("%")) return undefined
  const family = isIP(value)
  if (family === 4) return value
  if (family === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1)
  return undefined
}

/** Bridge accepts loopback peers; only that proxy boundary may supply Cloudflare's IP. */
export function trustedClientIp(remoteAddress: string | undefined, cloudflareIp: string | string[] | undefined): string {
  const socket = canonicalIp(remoteAddress)
  const loopback = socket && (socket.startsWith("127.") || socket === "::1" || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(socket))
  const forwarded = loopback && typeof cloudflareIp === "string" ? canonicalIp(cloudflareIp) : undefined
  return forwarded || socket || "unknown"
}
