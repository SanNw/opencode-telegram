import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AttachmentError, AttachmentService } from "./attachments.js"
import { BridgeStore } from "./storage/database.js"

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "opencode-attachments-"))
  const workspace = join(base, "workspace")
  await mkdir(workspace)
  const store = new BridgeStore(":memory:")
  store.ensureAuthorizedUser("owner")
  return { base, workspace, store, service: new AttachmentService(store, workspace) }
}

test("opaque attachment handles deliver a validated workspace image only to their owner", async () => {
  const { base, workspace, store, service } = await fixture()
  try {
    const image = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("test-image"),
    ])
    await writeFile(join(workspace, "preview.png"), image)
    const registered = await service.register({
      userId: "owner",
      sessionId: "session-1",
      sourcePath: "preview.png",
    })
    assert(registered)
    assert.match(registered.attachmentId, /^att_[A-Za-z0-9_-]{32}$/)
    assert.equal(registered.mime, "image/png")
    assert.equal(registered.preview, "image")
    assert.equal(JSON.stringify(registered).includes(workspace), false)

    const content = await service.read("owner", registered.attachmentId)
    assert.equal(content.disposition, "inline")
    assert.deepEqual(content.content, image)
    await assert.rejects(
      service.read("someone-else", registered.attachmentId),
      (error: unknown) => error instanceof AttachmentError && error.status === 404,
    )
  } finally {
    store.close()
    await rm(base, { recursive: true, force: true })
  }
})

test("attachment registration rejects traversal, escaping symlinks and credential files", async () => {
  const { base, workspace, store, service } = await fixture()
  try {
    const outside = join(base, "outside.txt")
    await writeFile(outside, "outside")
    await symlink(outside, join(workspace, "escape.txt"))
    await writeFile(join(workspace, ".env"), "TOKEN=secret")

    assert.equal(await service.register({
      userId: "owner",
      sessionId: "session-1",
      sourcePath: "../outside.txt",
    }), undefined)
    assert.equal(await service.register({
      userId: "owner",
      sessionId: "session-1",
      sourcePath: "escape.txt",
    }), undefined)
    assert.equal(await service.register({
      userId: "owner",
      sessionId: "session-1",
      sourcePath: ".env",
    }), undefined)
  } finally {
    store.close()
    await rm(base, { recursive: true, force: true })
  }
})

test("active content is forced to download instead of being rendered inline", async () => {
  const { base, workspace, store, service } = await fixture()
  try {
    await writeFile(join(workspace, "preview.svg"), "<svg onload=alert(1)></svg>")
    const registered = await service.register({
      userId: "owner",
      sessionId: "session-1",
      sourcePath: "preview.svg",
    })
    assert(registered)
    assert.equal(registered.mime, "application/octet-stream")
    assert.equal(registered.preview, "download")
    assert.equal((await service.read("owner", registered.attachmentId)).disposition, "attachment")
  } finally {
    store.close()
    await rm(base, { recursive: true, force: true })
  }
})

test("native absolute workspace paths are accepted without allowing paths outside the workspace", async () => {
  const { base, workspace, store, service } = await fixture()
  try {
    const path = join(workspace, "native.txt")
    await writeFile(path, "native file")
    const registered = await service.register({ userId: "owner", sessionId: "session-1", sourcePath: path })
    assert(registered)
    assert.equal((await service.read("owner", registered.attachmentId)).content.toString(), "native file")
    const outside = join(base, "outside.txt")
    await writeFile(outside, "not authorized")
    assert.equal(await service.register({ userId: "owner", sessionId: "session-1", sourcePath: outside }), undefined)
    assert.equal(await service.register({ userId: "owner", sessionId: "session-1", sourcePath: "Z:/not-authorized/file.txt" }), undefined)
  } finally {
    store.close()
    await rm(base, { recursive: true, force: true })
  }
})

test("storage browsing returns only opaque handles for workspace children", async () => {
  const { base, workspace, store, service } = await fixture()
  try {
    await mkdir(join(workspace, "src"))
    await writeFile(join(workspace, "README.md"), "# Project")
    await writeFile(join(workspace, ".env"), "TOKEN=secret")
    const root = await service.storageRoot("owner")
    assert.match(root.id, /^dir_[A-Za-z0-9_-]{32}$/)
    const listing = await service.listDirectory("owner", root.id, 0, 50)
    assert.equal(listing.directory.parentId, undefined)
    assert.deepEqual(listing.entries.map(({ name, type }) => ({ name, type })), [
      { name: "src", type: "directory" },
      { name: "README.md", type: "file" },
    ])
    assert.equal(JSON.stringify(listing).includes(workspace), false)
    const directory = listing.entries.find((entry) => entry.type === "directory")
    assert(directory?.type === "directory")
    const child = await service.listDirectory("owner", directory.id)
    assert.equal(child.directory.parentId, root.id)
  } finally {
    store.close()
    await rm(base, { recursive: true, force: true })
  }
})

test("temporary uploads are owner-bound, converted to file parts and consumed", async () => {
  const { base, store, service } = await fixture()
  try {
    const upload = service.createUpload("owner", "notes.md", Buffer.from("# Review this"))
    assert.match(upload.attachmentId, /^upl_[A-Za-z0-9_-]{32}$/)
    assert.equal(upload.preview, "text")
    const [part] = service.promptFiles("owner", [upload.attachmentId])
    assert.equal(part?.type, "file")
    assert.equal(part?.filename, "notes.md")
    assert.equal(part?.mime, "text/plain")
    assert.equal(part?.url, `data:text/plain;base64,${Buffer.from("# Review this").toString("base64")}`)
    assert.throws(
      () => service.promptFiles("someone-else", [upload.attachmentId]),
      (error: unknown) => error instanceof AttachmentError && error.status === 404,
    )
    service.consumeUploads("owner", [upload.attachmentId])
    assert.throws(
      () => service.promptFiles("owner", [upload.attachmentId]),
      (error: unknown) => error instanceof AttachmentError && error.status === 404,
    )
  } finally {
    store.close()
    await rm(base, { recursive: true, force: true })
  }
})

test("uploads reject executable content and more than four prompt files", async () => {
  const { base, store, service } = await fixture()
  try {
    assert.throws(
      () => service.createUpload("owner", "run.exe", Buffer.from("MZ executable")),
      (error: unknown) => error instanceof AttachmentError && error.status === 415,
    )
    const ids = Array.from({ length: 5 }, (_, index) => service.createUpload("owner", `note-${index}.txt`, Buffer.from("safe")).attachmentId)
    assert.throws(
      () => service.promptFiles("owner", ids),
      (error: unknown) => error instanceof AttachmentError && error.status === 404,
    )
  } finally {
    store.close()
    await rm(base, { recursive: true, force: true })
  }
})
