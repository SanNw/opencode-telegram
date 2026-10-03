import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { BridgeStore, type UsageRecord } from "./storage/database.js"
import { createRequestHandler } from "./app.js"

test("usage is idempotent, isolated by owner/workspace and uses message dates", () => {
  const store = new BridgeStore(":memory:")
  try {
    const record: UsageRecord = { id: "m1", sessionId: "s1", projectId: "p1", createdAt: Date.UTC(2026,8,28), provider: "provider", model: "model", agent: "build", input: 100, output: 20, reasoning: 5, cacheRead: 50, cacheWrite: 10, cost: 0.25 }
    store.recordUsage("owner", "workspace", [record, record])
    store.recordUsage("other", "workspace", [{ ...record, input: 999 }])
    store.recordUsage("owner", "different", [{ ...record, input: 888 }])
    const report = store.usage("owner", "workspace", record.createdAt, record.createdAt + 86400000)
    assert.deepEqual(report.totals, { messages: 1, input: 100, output: 20, reasoning: 5, cacheRead: 50, cacheWrite: 10, cost: 0.25 })
    assert.equal((report.daily[0] as { label: string }).label, "2026-09-28")
    assert.equal((store.usage("owner", "workspace", record.createdAt+1, record.createdAt+86400000).totals as { messages: number }).messages, 0)
    store.recordUsage("owner", "workspace", [{ ...record, output: 30 }])
    assert.equal((store.usage("owner", "workspace", 0, Date.now()+86400000).totals as { output: number }).output,30)
    assert.throws(() => store.recordUsage("owner", "workspace", [{ ...record, cost: NaN }]))
  } finally { store.close() }
})

test("cache cleanup requires a one-time owner/device approval and preserves live/foreign uploads", () => {
  const store = new BridgeStore(":memory:")
  try {
    store.ensureAuthorizedUser("owner"); store.ensureAuthorizedUser("other")
    store.replacePairingCode("code", 4_000_000_000)
    const device = store.pairDevice("owner", "init", 4_000_000_000, "code", "{}", "Phone", "token", 4_000_000_000)!
    const now = Math.floor(Date.now()/1000)
    for (const [id, userId, expiresAt] of [["old", "owner", now+10], ["live", "owner", now+1000], ["foreign", "other", now+10]] as const) {
      store.createUpload({ id, userId, expiresAt, name: "file.txt", mime: "text/plain", size: 4, content: Buffer.from("test") })
    }
    const denied = store.createPendingCacheCleanup("owner",device)
    assert.deepEqual(store.decidePendingAction(denied,"owner",device,"deny"),{ decision: "denied" })
    const proposal = store.createPendingCacheCleanup("owner",device)
    assert.equal(store.decidePendingAction(proposal,"other",device,"approve"),undefined)
    assert.equal(store.decidePendingAction(proposal,"owner","wrong","approve"),undefined)
    assert.deepEqual(store.decidePendingAction(proposal,"owner",device,"approve"),{ decision:"approved",action:"cache.cleanup" })
    store.clearExpiredCache("owner",now+20)
    assert.deepEqual(store.cacheSummary("owner",now+20).uploads,{ count:1,bytes:4 })
    assert.deepEqual(store.cacheSummary("other",now+20).uploads,{ count:1,bytes:4 })
    assert.equal(store.decidePendingAction(proposal,"owner",device,"approve"),undefined)
  } finally { store.close() }
})

test("history/cache routes fail closed and HTML preview retains strict sandbox headers", async () => {
  const server = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: (token) => token === "valid" ? { userId:"owner",deviceId:"device",expiresAt:4_000_000_000 } : false,
    loadUsage: (owner,from,to) => ({ owner,from,to }),
    loadCache: (owner) => ({ owner }),
    proposeAction: (input) => { assert.equal(input.type,"cache.cleanup"); return {actionId:"proposal",decision:"ASK"} },
    loadAttachment: async () => ({ name:"test.html",mime:"text/html; charset=utf-8",size:29,disposition:"attachment",content:Buffer.from("<script>alert(1)</script><h1>Test</h1>") }),
  }))
  await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve))
  try {
    const address = server.address(); assert(address && typeof address === "object")
    const base = `http://127.0.0.1:${address.port}/api/v1`, headers = {cookie:"bridge_session=valid","content-type":"application/json"}
    const preview = `/attachments/att_${"a".repeat(32)}/preview`
    for (const path of ["/usage?period=week","/storage/cache",preview]) assert.equal((await fetch(base+path)).status,401)
    assert.equal((await fetch(base+"/usage?period=invalid",{headers})).status,400)
    const usage = await (await fetch(base+"/usage?period=week",{headers})).json() as { owner:string;from:number;to:number }
    assert.equal(usage.owner,"owner"); assert(usage.to-usage.from >= 6*86400000 && usage.to-usage.from <= 7*86400000)
    assert.equal((await fetch(base+"/storage/cache/actions",{method:"POST",headers,body:'{"type":"delete","path":"/"}'})).status,400)
    assert.equal((await fetch(base+"/storage/cache/actions",{method:"POST",headers,body:'{"type":"cache.cleanup"}'})).status,202)
    const response = await fetch(base+preview,{headers})
    assert.equal(response.status,200)
    assert.match(response.headers.get("content-security-policy")!,/default-src 'none'/)
    assert.match(response.headers.get("content-security-policy")!,/; sandbox$/)
    assert.doesNotMatch(response.headers.get("content-security-policy")!,/allow-scripts|allow-same-origin/)
    assert.match(response.headers.get("content-disposition")!,/^inline/)
    const original = await fetch(base+preview.replace("/preview",""),{headers})
    assert.match(original.headers.get("content-disposition")!,/^attachment/)
  } finally { await new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve())) }
})
