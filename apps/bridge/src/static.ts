import { readFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { extname, resolve, sep } from "node:path"

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
}

const securityHeaders = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors https://web.telegram.org https://*.telegram.org",
  ].join("; "),
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
}

export function createStaticHandler(directory: string) {
  const root = resolve(directory)
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.method !== "GET" && request.method !== "HEAD") return false
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
    } catch {
      return false
    }
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`)
    if (file !== root && !file.startsWith(`${root}${sep}`)) return false
    try {
      const body = await readFile(file)
      response.writeHead(200, {
        ...securityHeaders,
        "cache-control": extname(file) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
        "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
      })
      response.end(request.method === "HEAD" ? undefined : body)
      return true
    } catch {
      return false
    }
  }
}
