import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { open, readdir, realpath } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import type { BridgeStore, FileHandleRecord } from "./storage/database.js"

const HANDLE_TTL_SECONDS = 24 * 60 * 60
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024
const MAX_READS_PER_MINUTE = 60
const MAX_BYTES_PER_MINUTE = 64 * 1024 * 1024
const MAX_UPLOADS_PER_MINUTE = 12
const MAX_UPLOAD_BYTES_PER_MINUTE = 32 * 1024 * 1024

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".ini", ".java",
  ".js", ".json", ".jsx", ".log", ".md", ".mjs", ".py", ".rs", ".sh", ".sql", ".toml",
  ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
])

const BLOCKED_NAMES = [
  /^\.env(?:\.|$)/i,
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^credentials(?:\.|$)/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:key|pem|p12|pfx)$/i,
]
const BLOCKED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv"])

export type RegisteredAttachment = {
  attachmentId: string
  name: string
  mime: string
  size: number
  preview: "image" | "text" | "download"
}

export type AttachmentContent = RegisteredAttachment & {
  content: Buffer
  disposition: "inline" | "attachment"
}

export type StorageEntry =
  | { id: string; type: "directory"; name: string }
  | ({ id: string; type: "file" } & Omit<RegisteredAttachment, "attachmentId">)

export type StorageListing = {
  directory: { id: string; name: string; parentId?: string }
  entries: StorageEntry[]
  nextCursor?: string
}

export class AttachmentError extends Error {
  constructor(
    readonly status: 404 | 413 | 415 | 429,
    readonly publicMessage: string,
  ) {
    super(publicMessage)
  }
}

type Delivery = {
  mime: string
  preview: "image" | "text" | "download"
  maxBytes: number
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function safeName(value: string): string {
  const name = basename(value.replaceAll("\\", "/")).replace(/[\r\n"\\]/g, "_").trim()
  return (name || "attachment").slice(0, 255)
}

function isBlockedName(name: string): boolean {
  return BLOCKED_NAMES.some((pattern) => pattern.test(name))
}

function detectDelivery(header: Buffer, filename: string): Delivery {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: "image/png", preview: "image", maxBytes: MAX_IMAGE_BYTES }
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { mime: "image/jpeg", preview: "image", maxBytes: MAX_IMAGE_BYTES }
  }
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", preview: "image", maxBytes: MAX_IMAGE_BYTES }
  }
  if (header.length >= 5 && header.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { mime: "application/pdf", preview: "download", maxBytes: MAX_DOWNLOAD_BYTES }
  }
  const extension = extname(filename).toLowerCase()
  if ((extension === ".html" || extension === ".htm") && !header.includes(0)) {
    return { mime: "text/html; charset=utf-8", preview: "download", maxBytes: MAX_TEXT_BYTES }
  }
  if (TEXT_EXTENSIONS.has(extension) && !header.includes(0)) {
    return { mime: "text/plain; charset=utf-8", preview: "text", maxBytes: MAX_TEXT_BYTES }
  }
  return { mime: "application/octet-stream", preview: "download", maxBytes: MAX_DOWNLOAD_BYTES }
}

export class AttachmentService {
  readonly #store: BridgeStore
  readonly #rootPromise: Promise<string>
  readonly #limits = new Map<string, { minute: number; reads: number; bytes: number }>()
  readonly #uploadLimits = new Map<string, { minute: number; uploads: number; bytes: number }>()

  constructor(store: BridgeStore, root: string) {
    this.#store = store
    this.#rootPromise = realpath(resolve(root))
  }

  async register(input: {
    userId: string
    sessionId: string
    sourcePath: string
    filename?: string
  }): Promise<RegisteredAttachment | undefined> {
    // Windows absolute paths are valid only on a native Windows host. The
    // canonical workspace containment check below still rejects other drives.
    if (!input.sourcePath || input.sourcePath.includes("\0") || (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(input.sourcePath))) {
      return undefined
    }
    const root = await this.#rootPromise
    const unresolved = isAbsolute(input.sourcePath)
      ? input.sourcePath
      : resolve(root, input.sourcePath)
    let canonical: string
    try {
      canonical = await realpath(unresolved)
    } catch {
      return undefined
    }
    if (!isInside(root, canonical)) return undefined

    const name = safeName(input.filename ?? canonical)
    if (isBlockedName(name)) return undefined

    let file
    try {
      file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      return undefined
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile()) return undefined
      const header = Buffer.alloc(Math.min(512, stat.size))
      if (header.length) await file.read(header, 0, header.length, 0)
      const delivery = detectDelivery(header, name)
      if (stat.size > delivery.maxBytes) return undefined
      const relativePath = relative(root, canonical).replaceAll("\\", "/")
      if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) return undefined
      const lookupKey = createHash("sha256")
        .update(`${input.userId}\0${input.sessionId}\0${relativePath}`)
        .digest("hex")
      const stored = this.#store.upsertFileHandle({
        id: `att_${randomBytes(24).toString("base64url")}`,
        lookupKey,
        userId: input.userId,
        sessionId: input.sessionId,
        relativePath,
        name,
        mime: delivery.mime,
        size: stat.size,
        preview: delivery.preview,
        expiresAt: Math.floor(Date.now() / 1_000) + HANDLE_TTL_SECONDS,
      })
      return this.#publicRecord(stored)
    } finally {
      await file.close()
    }
  }

  async storageRoot(userId: string): Promise<{ id: string; name: string }> {
    const root = await this.#rootPromise
    return this.#registerDirectory(userId, root)
  }

  createUpload(userId: string, filename: string, content: Buffer): RegisteredAttachment {
    const name = safeName(filename)
    if (isBlockedName(name) || content.length === 0) throw new AttachmentError(415, "Unsupported attachment")
    const delivery = detectDelivery(content.subarray(0, 512), name)
    if (delivery.mime === "application/octet-stream" || delivery.mime.startsWith("text/html")) throw new AttachmentError(415, "Unsupported attachment")
    if (content.length > delivery.maxBytes) throw new AttachmentError(413, "Attachment is too large")
    const minute = Math.floor(Date.now() / 60_000)
    const current = this.#uploadLimits.get(userId)
    const limit = current?.minute === minute ? current : { minute, uploads: 0, bytes: 0 }
    if (limit.uploads + 1 > MAX_UPLOADS_PER_MINUTE || limit.bytes + content.length > MAX_UPLOAD_BYTES_PER_MINUTE) {
      throw new AttachmentError(429, "Upload rate limit exceeded")
    }
    limit.uploads += 1
    limit.bytes += content.length
    this.#uploadLimits.set(userId, limit)
    const id = `upl_${randomBytes(24).toString("base64url")}`
    this.#store.createUpload({ id, userId, name, mime: delivery.mime, size: content.length, content, expiresAt: Math.floor(Date.now() / 1_000) + 15 * 60 })
    return { attachmentId: id, name, mime: delivery.mime, size: content.length, preview: delivery.preview }
  }

  promptFiles(userId: string, ids: string[]) {
    if (ids.length > 4 || ids.some((id) => !/^upl_[A-Za-z0-9_-]{32}$/.test(id))) throw new AttachmentError(404, "Upload not found")
    const records = this.#store.getUploads(ids, userId)
    if (records.length !== ids.length) throw new AttachmentError(404, "Upload not found")
    const byId = new Map(records.map((record) => [record.id, record]))
    return ids.map((id) => {
      const record = byId.get(id)!
      return { type: "file" as const, mime: record.mime.split(";")[0]!, filename: record.name, url: `data:${record.mime.split(";")[0]};base64,${record.content.toString("base64")}` }
    })
  }

  consumeUploads(userId: string, ids: string[]) {
    this.#store.deleteUploads(ids, userId)
  }

  async listDirectory(
    userId: string,
    directoryId: string,
    cursor = 0,
    limit = 50,
  ): Promise<StorageListing> {
    if (!/^dir_[A-Za-z0-9_-]{32}$/.test(directoryId)) {
      throw new AttachmentError(404, "Directory not found")
    }
    const handle = this.#store.getDirectoryHandle(directoryId, userId)
    if (!handle) throw new AttachmentError(404, "Directory not found")
    const root = await this.#rootPromise
    let canonical: string
    try {
      canonical = await realpath(resolve(root, handle.relativePath))
    } catch {
      throw new AttachmentError(404, "Directory not found")
    }
    if (!isInside(root, canonical)) throw new AttachmentError(404, "Directory not found")
    const boundedCursor = Math.max(0, Math.trunc(cursor))
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
    const children = (await readdir(canonical, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink() && !BLOCKED_DIRECTORIES.has(entry.name) && !isBlockedName(entry.name))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
    const page = children.slice(boundedCursor, boundedCursor + boundedLimit)
    const entries = (await Promise.all(page.map(async (entry): Promise<StorageEntry | undefined> => {
      const child = resolve(canonical, entry.name)
      if (entry.isDirectory()) {
        const directory = await this.#registerDirectory(userId, child)
        return { id: directory.id, type: "directory", name: directory.name }
      }
      const attachment = await this.register({
        userId,
        sessionId: "storage",
        sourcePath: child,
        filename: entry.name,
      })
      return attachment ? {
        id: attachment.attachmentId,
        type: "file",
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        preview: attachment.preview,
      } : undefined
    }))).filter((entry): entry is StorageEntry => Boolean(entry))
    const parentPath = dirname(canonical)
    const parent = canonical === root ? undefined : await this.#registerDirectory(userId, parentPath)
    return {
      directory: {
        id: directoryId,
        name: handle.name,
        ...(parent ? { parentId: parent.id } : {}),
      },
      entries,
      ...(boundedCursor + boundedLimit < children.length ? { nextCursor: String(boundedCursor + boundedLimit) } : {}),
    }
  }

  async read(userId: string, attachmentId: string): Promise<AttachmentContent> {
    if (!/^att_[A-Za-z0-9_-]{32}$/.test(attachmentId)) {
      throw new AttachmentError(404, "Attachment not found")
    }
    const stored = this.#store.getFileHandle(attachmentId, userId)
    if (!stored) throw new AttachmentError(404, "Attachment not found")
    this.#consumeLimit(userId, 0)

    const root = await this.#rootPromise
    const unresolved = resolve(root, stored.relativePath)
    let canonical: string
    try {
      canonical = await realpath(unresolved)
    } catch {
      this.#store.recordFileAccess(userId, "rejected")
      throw new AttachmentError(404, "Attachment not found")
    }
    if (!isInside(root, canonical)) {
      this.#store.recordFileAccess(userId, "rejected")
      throw new AttachmentError(404, "Attachment not found")
    }

    let file
    try {
      file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await file.stat()
      if (!stat.isFile()) throw new AttachmentError(404, "Attachment not found")
      const header = Buffer.alloc(Math.min(512, stat.size))
      if (header.length) await file.read(header, 0, header.length, 0)
      const delivery = detectDelivery(header, stored.name)
      if (stat.size > delivery.maxBytes) throw new AttachmentError(413, "Attachment is too large")
      this.#consumeLimit(userId, stat.size)
      const content = await file.readFile()
      this.#store.recordFileAccess(userId, "accepted")
      return {
        attachmentId: stored.id,
        name: stored.name,
        mime: delivery.mime,
        size: stat.size,
        preview: delivery.preview,
        disposition: delivery.preview === "download" ? "attachment" : "inline",
        content,
      }
    } catch (error) {
      this.#store.recordFileAccess(userId, "rejected")
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError(404, "Attachment not found")
    } finally {
      await file?.close()
    }
  }

  #publicRecord(record: FileHandleRecord): RegisteredAttachment {
    return {
      attachmentId: record.id,
      name: record.name,
      mime: record.mime,
      size: record.size,
      preview: record.preview,
    }
  }

  async #registerDirectory(userId: string, path: string): Promise<{ id: string; name: string }> {
    const root = await this.#rootPromise
    let canonical: string
    try {
      canonical = await realpath(path)
    } catch {
      throw new AttachmentError(404, "Directory not found")
    }
    if (!isInside(root, canonical)) throw new AttachmentError(404, "Directory not found")
    const relativePath = canonical === root ? "." : relative(root, canonical).replaceAll("\\", "/")
    const lookupKey = createHash("sha256").update(`${userId}\0${relativePath}`).digest("hex")
    const stored = this.#store.upsertDirectoryHandle({
      id: `dir_${randomBytes(24).toString("base64url")}`,
      lookupKey,
      userId,
      relativePath,
      name: canonical === root ? basename(root) || "Workspace" : safeName(canonical),
      expiresAt: Math.floor(Date.now() / 1_000) + HANDLE_TTL_SECONDS,
    })
    return { id: stored.id, name: stored.name }
  }

  #consumeLimit(userId: string, bytes: number) {
    const minute = Math.floor(Date.now() / 60_000)
    const current = this.#limits.get(userId)
    const bucket = current?.minute === minute ? current : { minute, reads: 0, bytes: 0 }
    if (bytes === 0) {
      if (bucket.reads >= MAX_READS_PER_MINUTE) throw new AttachmentError(429, "Too many attachment requests")
      bucket.reads += 1
    } else {
      if (bucket.bytes + bytes > MAX_BYTES_PER_MINUTE) throw new AttachmentError(429, "Attachment bandwidth limit exceeded")
      bucket.bytes += bytes
    }
    this.#limits.set(userId, bucket)
  }
}
