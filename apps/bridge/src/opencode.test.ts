import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import type { BridgeConfig } from "./config.js"
import type { Event } from "@opencode-ai/sdk/v2/client"
import {
  createCapabilitiesLoader,
  createAgentCatalogLoader,
  createMessageLoader,
  createOpenCodeSession,
  createSecureEventNormalizer,
  createPermissionLoader,
  createPermissionResponder,
  createProviderCatalogLoader,
  createPromptSender,
  createSessionAborter,
  createSessionDeleter,
  createSessionDiffLoader,
  createSessionTodoLoader,
  createVcsLoader,
  normalizeEvent,
} from "./opencode.js"

test("attachment capabilities are enabled only when the secure delivery service is wired", async () => {
  const disabled = await createCapabilitiesLoader()()
  const enabled = await createCapabilitiesLoader(true, true)()
  assert.equal(disabled.capabilities.files.status, "disabled")
  assert.equal(disabled.capabilities.images.status, "disabled")
  assert.deepEqual(enabled.capabilities.files, { status: "available", mode: "authenticated-opaque-handles" })
  assert.deepEqual(enabled.capabilities.images, { status: "available", mode: "png-jpeg-webp" })
  assert.deepEqual(enabled.capabilities.storage, { status: "available", mode: "authenticated-opaque-directory-handles" })
})

test("conversation adapter normalizes text and sends the approved prompt", async () => {
  const requests: Array<{ method: string | undefined; url: string | undefined; body: string }> = []
  const upstream = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, body })
    if (request.method === "GET" && request.url?.startsWith("/permission")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify([{
        id: "permission-1",
        sessionID: "session-1",
        permission: "bash",
        patterns: ["npm test"],
        metadata: { secret: "hidden" },
        always: [],
      }]))
    }
    if (request.method === "GET" && request.url?.startsWith("/provider?")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify({
        connected: ["provider-1"],
        default: { "provider-1": "model-1" },
        all: [{
          id: "provider-1",
          name: "Provider",
          source: "custom",
          env: ["SECRET_ENV"],
          key: "must-not-leak",
          options: { apiKey: "must-not-leak" },
          models: {
            "model-1": {
              id: "model-1",
              providerID: "provider-1",
              name: "Model",
              status: "active",
              family: "test",
              capabilities: {
                temperature: true,
                reasoning: true,
                attachment: true,
                toolcall: true,
                input: { text: true, audio: false, image: true, video: false, pdf: true },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
              limit: { context: 1000, output: 100 },
              cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
              api: { id: "x", url: "https://secret.invalid", npm: "x" },
              options: {}, headers: { Authorization: "must-not-leak" }, release_date: "2026-01-01",
              variants: { low: {}, medium: {}, retired: { disabled: true } },
            },
          },
        }],
      }))
    }
    if (request.method === "GET" && request.url?.startsWith("/agent?")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify([
        { name: "OpenAgent", description: "Primary", mode: "primary", native: true, hidden: false, permission: [], options: {}, model: { modelID: "model-1", providerID: "provider-1" }, variant: "medium" },
        { name: "HiddenAgent", description: "Private", mode: "subagent", native: false, hidden: true, permission: [], options: {} },
      ]))
    }
    if (request.method === "GET" && request.url?.startsWith("/skill?")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify([
        { name: "review", description: "Review code", location: "/secret/skills/review", content: "private instructions" },
      ]))
    }
    if (request.method === "GET" && request.url?.startsWith("/mcp?")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify({ github: { status: "connected" }, private: { status: "failed", error: "/secret/mcp failed" } }))
    }
    if (request.method === "GET" && request.url?.startsWith("/config?")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify({ plugin: ["opencode-safe", ["@scope/tools", { token: "must-not-leak" }], "file:///secret/private-plugin.js"] }))
    }
    if (request.method === "GET" && request.url?.startsWith("/session/session-1/diff")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify([{
        file: "/workspace/src/index.ts",
        patch: "+const token = 'known-secret-value'",
        additions: 1,
        deletions: 0,
        status: "modified",
      }]))
    }
    if (request.method === "GET" && /^\/session\/session-1\?/.test(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify({
        id: "session-1",
        projectID: "project-1",
        directory: "/workspace",
        title: "Remote task",
        version: "1.18.32",
        time: { created: 1000, updated: 1000 },
      }))
    }
    if (request.method === "GET" && request.url?.startsWith("/session/session-1/todo")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify([{ content: "Run tests", status: "in_progress", priority: "high" }]))
    }
    if (request.method === "GET" && request.url?.startsWith("/vcs/status")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify([{ file: "/workspace/src/index.ts", additions: 2, deletions: 1, status: "modified" }]))
    }
    if (request.method === "GET" && request.url?.startsWith("/vcs?")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify({ branch: "main", default_branch: "main" }))
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify([{
        info: { id: "message-1", sessionID: "session-1", role: "user", time: { created: 1000 } },
        parts: [
          { id: "part-1", sessionID: "session-1", messageID: "message-1", type: "text", text: "Hello" },
          { id: "part-2", sessionID: "session-1", messageID: "message-1", type: "reasoning", text: "private" },
          {
            id: "part-3", sessionID: "session-1", messageID: "message-1", type: "file",
            mime: "image/png", filename: "preview.png", url: "file:///workspace/preview.png",
            source: { type: "file", path: "/workspace/preview.png", text: { value: "", start: 0, end: 0 } },
          },
        ],
      }]))
    }
    if (request.method === "POST" && request.url?.startsWith("/session?")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end(JSON.stringify({
        id: "session-created",
        projectID: "project-1",
        directory: "/workspace",
        title: "Remote task",
        version: "1.18.32",
        time: { created: 1000, updated: 1000 },
      }))
    }
    if (request.method === "DELETE" && request.url?.startsWith("/session/session-1")) {
      response.writeHead(200, { "content-type": "application/json" })
      return response.end("true")
    }
    response.writeHead(204)
    response.end()
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))

  try {
    const address = upstream.address()
    assert(address && typeof address === "object")
    const config: BridgeConfig = {
      bridgeHost: "127.0.0.1",
      bridgePort: 8787,
      databasePath: ":memory:",
      openCodeUrl: new URL(`http://127.0.0.1:${address.port}`),
      openCodeDirectory: "/workspace",
      openCodeUsername: "opencode",
    }
    const registrations: unknown[] = []
    const messageLoader = createMessageLoader(config, async (input) => {
      registrations.push(input)
      return {
        attachmentId: `att_${"a".repeat(32)}`,
        name: "preview.png",
        mime: "image/png",
        size: 128,
        preview: "image",
      }
    })
    assert.deepEqual(await messageLoader("session-1", { userId: "owner" }), [{
      id: "message-1",
      role: "user",
      createdAt: 1000,
      text: "Hello",
      parts: { "part-1": "Hello" },
      content: [
        { id: "part-1", type: "text", text: "Hello" },
        { id: "part-2", type: "reasoning", status: "running" },
        {
          id: "part-3",
          type: "file",
          mime: "image/png",
          filename: "preview.png",
          source: { type: "file", label: "preview.png" },
          attachmentId: `att_${"a".repeat(32)}`,
          size: 128,
          preview: "image",
        },
      ],
    }])
    assert.deepEqual(registrations, [{
      userId: "owner",
      sessionId: "session-1",
      sourcePath: "/workspace/preview.png",
      filename: "preview.png",
    }])
    assert.deepEqual(await createPermissionLoader(config)("session-1"), [{
      requestId: "permission-1",
      sessionId: "session-1",
      action: "bash",
      resources: ["npm test"],
    }])
    assert.deepEqual(await createSessionTodoLoader(config)("session-1"), [{
      content: "Run tests",
      status: "in_progress",
      priority: "high",
    }])
    assert.deepEqual(await createVcsLoader(config)(), {
      branch: "main",
      defaultBranch: "main",
      files: [{ file: "src/index.ts", additions: 2, deletions: 1, status: "modified" }],
    })
    await createPromptSender(config)("session-1", "Approved prompt", [{
      type: "file",
      mime: "text/plain",
      filename: "notes.txt",
      url: "data:text/plain;base64,bm90ZXM=",
    }], { agent: "OpenAgent", model: { providerId: "provider-1", modelId: "model-1" }, variant: "medium" })
    const prompt = requests.find((request) => request.url?.includes("prompt_async"))
    assert.equal(prompt?.method, "POST")
    assert.match(prompt?.body ?? "", /Approved prompt/)
    assert.match(prompt?.body ?? "", /notes\.txt/)
    assert.match(prompt?.body ?? "", /data:text\/plain;base64,bm90ZXM=/)
    assert.match(prompt?.body ?? "", /OpenAgent/)
    assert.match(prompt?.body ?? "", /provider-1/)
    assert.match(prompt?.body ?? "", /medium/)
    await createSessionAborter(config)("session-1")
    assert(requests.some((request) => request.url?.includes("/abort")))
    await createSessionDeleter(config)("session-1")
    assert(requests.some((request) => request.method === "DELETE" && request.url?.includes("/session/session-1")))
    await createPermissionResponder(config)("permission-1", "once")
    const reply = requests.find((request) => request.url?.includes("permission-1/reply"))
    assert(reply)
    assert.equal((await createOpenCodeSession(config)("Remote task")).id, "session-created")
    assert(requests.some((request) => /Remote task/.test(request.body)))
    assert.match(reply.body, /once/)
    assert.deepEqual(await createSessionDiffLoader({ ...config, openCodePassword: "known-secret-value" })("session-1"), [{
      file: "src/index.ts",
      patch: "+const token = '[REDACTED]'",
      additions: 1,
      deletions: 0,
      status: "modified",
    }])
    const catalog = await createProviderCatalogLoader(config)()
    assert.deepEqual(catalog.providers[0], {
      id: "provider-1",
      name: "Provider",
      connected: true,
      defaultModelId: "model-1",
      models: [{
        id: "model-1",
        name: "Model",
        family: "test",
        status: "active",
        capabilities: {
          reasoning: true,
          attachments: true,
          tools: true,
          input: { text: true, audio: false, image: true, video: false, pdf: true },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
        },
        limits: { context: 1000, output: 100 },
        variants: ["low", "medium"],
      }],
    })
    assert.deepEqual(catalog.skills, [{ name: "review", description: "Review code" }])
    assert.deepEqual(catalog.mcpServers, [{ name: "github", status: "connected" }, { name: "private", status: "failed" }])
    assert.deepEqual(catalog.plugins, [{ name: "opencode-safe" }, { name: "@scope/tools" }, { name: "Local plugin" }])
    assert.deepEqual(await createAgentCatalogLoader(config)(), {
      agents: [{ name: "OpenAgent", description: "Primary", mode: "primary", native: true, model: { id: "model-1", providerId: "provider-1" }, variant: "medium" }],
    })
    assert.doesNotMatch(JSON.stringify(catalog), /must-not-leak|secret\.invalid|SECRET_ENV|Authorization|private instructions|\/secret\//)
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
  }
})

test("event adapter exposes text and tool status without tool input or output", () => {
  assert.deepEqual(normalizeEvent({
    id: "event-1",
    type: "message.part.updated",
    properties: {
      sessionID: "session-1",
      time: 1,
      part: {
        id: "part-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: { status: "running", input: { secret: "hidden" }, time: { start: 1 } },
      },
    },
  } as Event), {
    type: "tool.updated",
    sessionId: "session-1",
    messageId: "message-1",
    callId: "call-1",
    tool: "bash",
    status: "running",
    startedAt: 1,
  })
  assert.deepEqual(normalizeEvent({
    id: "event-2",
    type: "permission.v2.asked",
    properties: {
      id: "permission-1",
      sessionID: "session-1",
      action: "bash",
      resources: ["npm test"],
      metadata: { token: "hidden" },
    },
  } as Event), {
    type: "permission.requested",
    sessionId: "session-1",
    requestId: "permission-1",
    action: "bash",
    resources: ["npm test"],
  })
  assert.equal(normalizeEvent({
    id: "event-delta",
    type: "message.part.delta",
    properties: {
      sessionID: "session-1",
      messageID: "message-1",
      partID: "part-1",
      field: "text",
      delta: "partial-secret",
    },
  } as Event), undefined)
  assert.deepEqual(normalizeEvent({
    id: "event-text",
    type: "message.part.updated",
    properties: {
      sessionID: "session-1",
      time: 1,
      part: {
        id: "part-text",
        sessionID: "session-1",
        messageID: "message-1",
        type: "text",
        text: "credential=known-secret-value",
      },
    },
  } as Event, ["known-secret-value"]), {
    type: "message.text",
    sessionId: "session-1",
    messageId: "message-1",
    partId: "part-text",
    text: "credential=[REDACTED]",
  })
})

test("secure event streaming withholds split secrets and isolates concurrent parts", () => {
  const secret = "token-value-that-must-never-leak"
  const normalize = createSecureEventNormalizer([secret], "/workspace")
  const update = (partID: string, text: string, end?: number) => normalize({
    id: `event-${partID}-${text.length}`,
    type: "message.part.updated",
    properties: {
      sessionID: "session-1",
      part: {
        id: partID,
        sessionID: "session-1",
        messageID: "message-1",
        type: "text",
        text,
        time: { start: 1, ...(end ? { end } : {}) },
      },
    },
  } as Event)

  const longPrefix = `${"safe words ".repeat(140)}credential=`
  const first = update("part-1", `${longPrefix}${secret.slice(0, 12)}`)
  assert(first?.type === "message.delta")
  assert.doesNotMatch(first.delta, /token-value/)
  assert.equal(update("part-2", `${"other content ".repeat(140)}still safe`)?.type, "message.delta")
  const second = update("part-1", `${longPrefix}${secret} after safe words continue `)
  if (second?.type === "message.delta") assert.doesNotMatch(second.delta, /token-value/)
  assert.deepEqual(update("part-1", `${longPrefix}${secret} after safe words continue`, 2), {
    type: "message.text",
    sessionId: "session-1",
    messageId: "message-1",
    partId: "part-1",
    text: `${longPrefix}[REDACTED] after safe words continue`,
  })
})

test("structured events never expose reasoning content and sanitize paths, diffs and permissions", () => {
  assert.deepEqual(normalizeEvent({
    id: "reasoning",
    type: "message.part.updated",
    properties: {
      sessionID: "session-1",
      part: {
        id: "reason-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "reasoning",
        text: "private chain of thought",
        time: { start: 1, end: 2 },
      },
    },
  } as Event), {
    type: "message.reasoning",
    sessionId: "session-1",
    messageId: "message-1",
    partId: "reason-1",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
  })

  assert.deepEqual(normalizeEvent({
    id: "diff",
    type: "session.diff",
    properties: {
      sessionID: "session-1",
      diff: [{ file: "/outside/private.txt", patch: "+token=known-secret-value", additions: 1, deletions: 0 }],
    },
  } as Event, ["known-secret-value"], "/workspace"), {
    type: "session.diff",
    sessionId: "session-1",
    diff: [{ file: "private.txt", patch: "+token=[REDACTED]", additions: 1, deletions: 0 }],
  })
  assert.deepEqual(normalizeEvent({
    id: "file",
    type: "file.edited",
    properties: { file: "C:\\Users\\Private\\secret.ts" },
  } as Event, [], "/workspace"), { type: "file.edited", file: "secret.ts" })

  const resources = Array.from({ length: 60 }, (_, index) => `command-${index}-known-secret-value`)
  const permission = normalizeEvent({
    id: "permission",
    type: "permission.v2.asked",
    properties: { id: "p-1", sessionID: "session-1", action: "bash", resources },
  } as Event, ["known-secret-value"])
  assert(permission?.type === "permission.requested")
  assert.equal(permission.resources.length, 50)
  assert.equal(permission.resources[0], "command-0-[REDACTED]")
})
