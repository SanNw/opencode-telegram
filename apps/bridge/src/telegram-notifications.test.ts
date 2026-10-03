import assert from "node:assert/strict"
import test from "node:test"
import type { NormalizedOpenCodeEvent } from "./opencode.js"
import { runTelegramNotifications } from "./telegram-notifications.js"

test("notifies the owner once for completion and pending permission", async () => {
  const calls: Array<Record<string, unknown>> = []
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  async function* events(): AsyncGenerator<NormalizedOpenCodeEvent> {
    yield { type: "session.updated", session: { id: "s1", projectId: "p1", title: "Build", directory: "/workspace", updatedAt: 1 } }
    yield { type: "session.status", sessionId: "s1", status: "busy" }
    yield { type: "session.idle", sessionId: "s1" }
    yield { type: "session.idle", sessionId: "s1" }
    yield { type: "permission.requested", sessionId: "s1", requestId: "r1", action: "bash", resources: [] }
    yield { type: "permission.requested", sessionId: "s1", requestId: "r1", action: "bash", resources: [] }
  }
  await runTelegramNotifications({ botToken: "secret", ownerId: "1", miniAppUrl: "https://example.com" }, events(), fetcher)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.chat_id, "1")
  assert.match(String(calls[0]?.text), /finished: Build/)
  assert.match(String(calls[1]?.text), /needs approval for bash: Build/)
  assert.deepEqual(calls[0]?.reply_markup, { inline_keyboard: [[{ text: "Open Mini App", web_app: { url: "https://example.com" } }]] })
})

test("locking remote access stops Telegram writes and does not replay queued notices after unlock", async () => {
  let enabled = true, calls = 0
  async function* events(): AsyncGenerator<NormalizedOpenCodeEvent> {
    yield { type: "session.status", sessionId: "s1", status: "busy" }
    enabled = false
    yield { type: "permission.requested", sessionId: "s1", requestId: "r1", action: "bash", resources: [] }
    yield { type: "session.error", sessionId: "s1" }
    enabled = true
    yield { type: "session.idle", sessionId: "s1" }
    yield { type: "permission.requested", sessionId: "s1", requestId: "r2", action: "bash", resources: [] }
  }
  await runTelegramNotifications({ botToken: "secret", ownerId: "1" }, events(), (async () => {
    calls++; return new Response("{}", { status: 200 })
  }) as typeof fetch, () => enabled)
  assert.equal(calls, 1)
})
