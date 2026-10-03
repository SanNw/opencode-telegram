import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { normalizeManagementUrl } from "./management-actions.js"

export type ManagementResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>

/** Conservative public-unicast classification: ambiguous/reserved ranges fail closed. */
export function isPublicManagementAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number]
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 168) || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) !== 6 || address.includes("%")) return false
  // Only allocated global unicast, excluding mapped IPv4, transition mechanisms,
  // special-purpose 2001 ranges and documentation allocations.
  const [first = "", second = "0"] = address.toLowerCase().split(":")
  const a = Number.parseInt(first || "0", 16), b = Number.parseInt(second || "0", 16)
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && a !== 0x3fff && !(a === 0x2001 && (b <= 0x01ff || b === 0x0db8))
}

export function createManagementEgress(allowedHosts: readonly string[], resolver: ManagementResolver = (hostname) => lookup(hostname, { all: true, verbatim: true })) {
  const allowed = new Set(allowedHosts)
  return async (value: string) => {
    const url = new URL(normalizeManagementUrl(value))
    if (!allowed.has(url.hostname)) throw new Error("Remote host is outside the management allowlist")
    const results = await resolver(url.hostname)
    if (!results.length || results.some((item) => !isPublicManagementAddress(item.address))) throw new Error("Remote host does not resolve exclusively to public addresses")
  }
}
