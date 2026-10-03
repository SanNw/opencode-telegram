import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { createRequestHandler } from "./app.js"

test("snapshot reports offline without leaking the upstream error", async () => {
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("secret upstream details") },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/opencode/snapshot`)

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      online: false,
      error: "OpenCode is unavailable",
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("event stream emits normalized SSE without raw OpenCode payloads", async () => {
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    loadEvents: async function* () {
      yield { type: "system.online", at: "2026-09-27T00:00:00.000Z" }
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/opencode/events`)
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    assert.match(body, /event: system\.online/)
    assert.doesNotMatch(body, /properties|payload/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("snapshot requires a valid bridge session when authorization is configured", async () => {
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => ({
      online: true,
      version: "test",
      syncedAt: "2026-09-27T00:00:00.000Z",
      projects: [],
      sessions: [],
    }),
    authorizeSession: (token) => token === "valid-token" ? {
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
      userId: "1",
      deviceId: "device-1",
    } : false,
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const url = `http://127.0.0.1:${address.port}/api/v1/opencode/snapshot`
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { cookie: "bridge_session=valid-token" } })).status, 200)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("event stream closes when the bridge session expires", async () => {
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: () => ({
      expiresAt: Date.now() / 1_000 + 0.02,
      userId: "1",
      deviceId: "device-1",
    }),
    loadEvents: async function* (signal) {
      yield { type: "system.online", at: "2026-09-28T00:00:00.000Z" }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/opencode/events`, {
      headers: { cookie: "bridge_session=valid-token" },
    })
    assert.match(await response.text(), /system\.online/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("event stream stops emitting after its trusted device is revoked", async () => {
  let authorizationChecks = 0
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: () => ++authorizationChecks < 3
      ? { expiresAt: Math.floor(Date.now() / 1_000) + 60, userId: "1", deviceId: "device-1" }
      : false,
    loadEvents: async function* () {
      yield { type: "system.online", at: "2026-09-28T00:00:00.000Z" }
      yield { type: "system.heartbeat", at: "2026-09-28T00:00:01.000Z" }
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/opencode/events`, {
      headers: { cookie: "bridge_session=valid-token" },
    })
    const body = await response.text()
    assert.match(body, /system\.online/)
    assert.doesNotMatch(body, /system\.heartbeat/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("idle event streams also close when remote access is revoked", async () => {
  let active = true
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: () => active ? { expiresAt: Date.now() / 1000 + 60, userId: "1", deviceId: "device" } : false,
    loadEvents: async function* (signal) {
      yield { type: "system.online", at: "2026-09-30T00:00:00.000Z" }
      active = false
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address(); assert(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/opencode/events`, { signal: AbortSignal.timeout(3000) })
    assert.match(await response.text(), /system.online/)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test("prompt action executes only after an explicit approval", async () => {
  let executions = 0
  let permissionReplies = 0
  let proposedUploads: string[] = []
  let proposedSelection: { agent?: string; providerId?: string; modelId?: string; variant?: string } = {}
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: () => ({ expiresAt: 2_000_000_000, userId: "1", deviceId: "device-1" }),
    requirePrivilege: () => {},
    proposeAction: (input) => {
      if (input.type === "session.prompt") {
        proposedUploads = input.uploadIds ?? []
        proposedSelection = {
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.model ? { providerId: input.model.providerId, modelId: input.model.modelId } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
        }
      }
      return { actionId: "action-1", decision: "ASK" }
    },
    decideAction: async ({ decision }) => {
      assert.equal(decision, "approve")
      executions += 1
      return { status: "executed" }
    },
    respondPermission: async ({ reply }) => {
      assert.equal(reply, "once")
      permissionReplies += 1
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const base = `http://127.0.0.1:${address.port}/api/v1`
    const headers = { "content-type": "application/json", cookie: "bridge_session=valid-token" }
    const proposal = await fetch(`${base}/sessions/session-1/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "session.prompt",
        text: "Inspect the tests",
        uploadIds: [`upl_${"a".repeat(32)}`],
        agent: "OpenAgent",
        model: { providerId: "openai", modelId: "gpt-5.4" },
        variant: "high",
      }),
    })
    assert.equal(proposal.status, 202)
    assert.equal(executions, 0)
    assert.deepEqual(proposedUploads, [`upl_${"a".repeat(32)}`])
    assert.deepEqual(proposedSelection, { agent: "OpenAgent", providerId: "openai", modelId: "gpt-5.4", variant: "high" })
    assert.equal((await proposal.json() as { decision: string }).decision, "ASK")

    const approval = await fetch(`${base}/actions/action-1/decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "approve" }),
    })
    assert.equal(approval.status, 200)
    assert.equal(executions, 1)

    const permission = await fetch(`${base}/permissions/permission-1/reply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reply: "once" }),
    })
    assert.equal(permission.status, 200)
    assert.equal(permissionReplies, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("authenticated binary uploads decode the filename and stay opaque", async () => {
  let received: { filename: string; content: Buffer } | undefined
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: (token) => token === "valid-token"
      ? { expiresAt: 2_000_000_000, userId: "owner", deviceId: "device-1" }
      : false,
    createUpload: ({ filename, content }) => {
      received = { filename, content }
      return { attachmentId: `upl_${"b".repeat(32)}`, name: filename, mime: "text/plain", size: content.length, preview: "text" }
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const url = `http://127.0.0.1:${address.port}/api/v1/uploads`
    assert.equal((await fetch(url, { method: "POST", body: "secret" })).status, 401)
    const response = await fetch(url, {
      method: "POST",
      headers: { cookie: "bridge_session=valid-token", "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("análise.md") },
      body: "review me",
    })
    assert.equal(response.status, 201)
    assert.equal(received?.filename, "análise.md")
    assert.equal(received?.content.toString("utf8"), "review me")
    assert.equal(JSON.stringify(await response.json()).includes("review me"), false)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("session creation is proposed before OpenCode execution", async () => {
  let proposedTitle = ""
  let executions = 0
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: () => ({ expiresAt: 2_000_000_000, userId: "1", deviceId: "device-1" }),
    proposeAction: (input) => {
      assert.equal(input.type, "session.create")
      proposedTitle = input.type === "session.create" ? input.title ?? "" : ""
      return { actionId: "create-1", decision: "ASK" }
    },
    decideAction: async () => {
      executions += 1
      return {
        status: "executed",
        session: {
          id: "session-created",
          projectId: "project-1",
          title: "Remote task",
          directory: "/workspace",
          updatedAt: 1,
        },
      }
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const base = `http://127.0.0.1:${address.port}/api/v1`
    const headers = { "content-type": "application/json", cookie: "bridge_session=valid-token" }
    const proposal = await fetch(`${base}/sessions/actions`, {
      method: "POST", headers, body: JSON.stringify({ type: "session.create", title: "Remote task" }),
    })
    assert.equal(proposal.status, 202)
    assert.equal(proposedTitle, "Remote task")
    assert.equal(executions, 0)
    const approval = await fetch(`${base}/actions/create-1/decision`, {
      method: "POST", headers, body: JSON.stringify({ decision: "approve" }),
    })
    assert.equal(approval.status, 200)
    assert.equal((await approval.json() as { session: { id: string } }).session.id, "session-created")
    assert.equal(executions, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("session deletion requires an explicit approval and returns its session id", async () => {
  let proposalType = ""
  let executions = 0
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: () => ({ expiresAt: 2_000_000_000, userId: "1", deviceId: "device-1" }),
    requirePrivilege: () => {},
    actionRequiresPrivilege: () => true,
    proposeAction: (input) => {
      proposalType = input.type
      return { actionId: "delete-1", decision: "ASK" }
    },
    decideAction: async ({ decision }) => {
      assert.equal(decision, "approve")
      executions += 1
      return { status: "executed", sessionId: "session-1" }
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const base = `http://127.0.0.1:${address.port}/api/v1`
    const headers = { "content-type": "application/json", cookie: "bridge_session=valid-token" }
    const proposal = await fetch(`${base}/sessions/session-1/actions`, {
      method: "POST", headers, body: JSON.stringify({ type: "session.delete" }),
    })
    assert.equal(proposal.status, 202)
    assert.equal(proposalType, "session.delete")
    assert.equal(executions, 0)
    assert.deepEqual(await proposal.json(), {
      actionId: "delete-1",
      decision: "ASK",
      summary: { type: "session.delete" },
    })
    const approval = await fetch(`${base}/actions/delete-1/decision`, {
      method: "POST", headers, body: JSON.stringify({ decision: "approve" }),
    })
    assert.equal(approval.status, 200)
    assert.deepEqual(await approval.json(), { status: "executed", sessionId: "session-1" })
    assert.equal(executions, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("trusted devices can be listed and another device can be revoked", async () => {
  let revoked = ""
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: () => ({ expiresAt: 2_000_000_000, userId: "1", deviceId: "current" }),
    requirePrivilege: () => {},
    listDevices: () => [
      { id: "current", label: "This phone", createdAt: 1, lastSeenAt: 2 },
      { id: "old", label: "Old phone", createdAt: 1, lastSeenAt: 1 },
    ],
    revokeDevice: ({ targetDeviceId }) => {
      revoked = targetDeviceId
      return targetDeviceId !== "current"
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const base = `http://127.0.0.1:${address.port}/api/v1`
    const headers = { cookie: "bridge_session=valid-token" }
    const devices = await fetch(`${base}/devices`, { headers })
    assert.equal(devices.status, 200)
    assert.deepEqual(await devices.json(), { devices: [
      { id: "current", label: "This phone", createdAt: 1, lastSeenAt: 2, current: true },
      { id: "old", label: "Old phone", createdAt: 1, lastSeenAt: 1, current: false },
    ] })
    assert.equal((await fetch(`${base}/devices/old`, { method: "DELETE", headers })).status, 200)
    assert.equal(revoked, "old")
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("audit endpoint exposes event metadata without action payloads", async () => {
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: () => ({ expiresAt: 2_000_000_000, userId: "1", deviceId: "current" }),
    loadAudit: () => [{ id: 7, createdAt: 1_000, event: "action.decided", outcome: "approve" }],
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/audit`, {
      headers: { cookie: "bridge_session=valid-token" },
    })
    assert.equal(response.status, 200)
    const body = JSON.stringify(await response.json())
    assert.match(body, /action\.decided/)
    assert.doesNotMatch(body, /payload|prompt|publicKey|token/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("capabilities, provider catalog and session diff require authorization and expose normalized contracts", async () => {
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: (token) => token === "valid-token"
      ? { expiresAt: 2_000_000_000, userId: "1", deviceId: "current" }
      : false,
    loadCapabilities: async () => ({
      version: 1,
      capabilities: {
        messageHistory: { status: "available" },
        structuredParts: { status: "available" },
        tools: { status: "available" },
        agents: { status: "available" },
        skills: { status: "available" },
        mcp: { status: "available" },
        plugins: { status: "available" },
        diffs: { status: "available" },
        files: { status: "disabled", reason: "no delivery" },
        images: { status: "disabled", reason: "no delivery" },
        models: { status: "available" },
        providers: { status: "available" },
        tokens: { status: "available" },
        costs: { status: "available" },
        storage: { status: "disabled", reason: "not enabled" },
        streaming: { status: "available", mode: "safe" },
        htmlPreview: { status: "disabled", reason: "not enabled" },
        git: { status: "available", mode: "read-only-status" },
      },
    }),
    loadProviderCatalog: async () => ({ providers: [] }),
    loadAgentCatalog: async () => ({ agents: [{ name: "OpenAgent", mode: "primary", native: true }] }),
    loadVcs: async () => ({ branch: "main", files: [] }),
    loadSessionDiff: async (sessionId, messageId) => [{
      file: `${sessionId}-${messageId}.ts`, additions: 1, deletions: 0, status: "modified",
    }],
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const base = `http://127.0.0.1:${address.port}/api/v1`
    assert.equal((await fetch(`${base}/capabilities`)).status, 401)
    const headers = { cookie: "bridge_session=valid-token" }
    assert.equal((await fetch(`${base}/capabilities`, { headers })).status, 200)
    assert.deepEqual(await (await fetch(`${base}/opencode/catalog`, { headers })).json(), { providers: [] })
    assert.deepEqual(await (await fetch(`${base}/opencode/agents`, { headers })).json(), { agents: [{ name: "OpenAgent", mode: "primary", native: true }] })
    assert.deepEqual(await (await fetch(`${base}/opencode/vcs`, { headers })).json(), { branch: "main", files: [] })
    assert.deepEqual(await (await fetch(`${base}/sessions/s-1/diff?messageId=m-1`, { headers })).json(), {
      sessionId: "s-1",
      diff: [{ file: "s-1-m-1.ts", additions: 1, deletions: 0, status: "modified" }],
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("attachment content requires authorization and uses restrictive response headers", async () => {
  let requestedBy = ""
  const attachmentId = `att_${"a".repeat(32)}`
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: (token) => token === "valid-token"
      ? { expiresAt: 2_000_000_000, userId: "owner", deviceId: "current" }
      : false,
    loadAttachment: async ({ userId, attachmentId: requestedId }) => {
      requestedBy = userId
      assert.equal(requestedId, attachmentId)
      return {
        name: "preview.png",
        mime: "image/png",
        size: 12,
        disposition: "inline",
        content: Buffer.from("image-bytes"),
      }
    },
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const url = `http://127.0.0.1:${address.port}/api/v1/attachments/${attachmentId}`
    assert.equal((await fetch(url)).status, 401)
    const response = await fetch(url, { headers: { cookie: "bridge_session=valid-token" } })
    assert.equal(response.status, 200)
    assert.equal(requestedBy, "owner")
    assert.equal(response.headers.get("content-type"), "image/png")
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin")
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/)
    assert.equal(await response.text(), "image-bytes")
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("storage endpoints expose opaque paginated directory resources only after authorization", async () => {
  const directoryId = `dir_${"d".repeat(32)}`
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: (token) => token === "valid-token"
      ? { expiresAt: 2_000_000_000, userId: "owner", deviceId: "current" }
      : false,
    loadStorageRoot: async ({ userId }) => ({ id: directoryId, name: `${userId}-workspace` }),
    loadStorageDirectory: async ({ userId, directoryId: requested, cursor, limit }) => ({
      directory: { id: requested, name: "workspace" },
      entries: [{ id: `att_${"a".repeat(32)}`, type: "file", name: "README.md", mime: "text/plain", size: 10, preview: "text" }],
      observed: { userId, cursor, limit },
    }),
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const base = `http://127.0.0.1:${address.port}/api/v1/storage`
    assert.equal((await fetch(`${base}/root`)).status, 401)
    const headers = { cookie: "bridge_session=valid-token" }
    assert.deepEqual(await (await fetch(`${base}/root`, { headers })).json(), {
      root: { id: directoryId, name: "owner-workspace" },
    })
    const listing = await fetch(`${base}/directories/${directoryId}?cursor=2&limit=25`, { headers })
    assert.equal(listing.status, 200)
    assert.deepEqual((await listing.json() as { observed: unknown }).observed, { userId: "owner", cursor: 2, limit: 25 })
    assert.equal((await fetch(`${base}/directories/${directoryId}?limit=1000`, { headers })).status, 400)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

