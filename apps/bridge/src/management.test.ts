import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer, request as httpRequest, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { createRequestHandler } from "./app.js"
import type { BridgeConfig } from "./config.js"
import { createOpenCodeManagement, ManagementActions } from "./management.js"
import { normalizeManagementMutation, normalizeManagementName, normalizeManagementUrl, normalizePluginPackage, type ManagementMutation } from "./management-actions.js"
import { decide } from "./policy.js"
import { SecurityBoundary } from "./security.js"
import { BridgeStore } from "./storage/database.js"
import { createManagementEgress, isPublicManagementAddress } from "./management-egress.js"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert(address && typeof address === "object")
  return `http://127.0.0.1:${address.port}`
}
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

async function fixture(databasePath = ":memory:", bridgeSecrets: Pick<BridgeConfig, "openCodePassword" | "telegram"> = {}) {
  let now = Math.floor(Date.now() / 1000)
  const writes: Array<{ method: string; path: string; body: unknown }> = []
  const statuses: Record<string, { status: string }> = { remote: { status: "connected" } }
  let ineffectiveConfig = false
  const settings: Config = { skills: { paths: ["/private/path"], urls: [] }, plugin: [["@scope/existing@1.0.0", { token: "private-plugin-secret" }], "file:///private/plugin.js"], mcp: { remote: { type: "remote", url: "https://example.com/mcp", enabled: true, headers: { Authorization: "private-mcp-secret" } } }, provider: { vendor: { options: { apiKey: "private-provider-secret" } } } }
  let onConfigRead: (() => Promise<void> | void) | undefined
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost")
    let raw = ""; for await (const chunk of request) raw += chunk
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    response.writeHead(200, { "content-type": "application/json" })
    if (request.method === "GET") {
      if (url.pathname === "/config") { await onConfigRead?.(); return response.end(JSON.stringify(settings)) }
      if (url.pathname === "/skill") return response.end(JSON.stringify([
        { name: "project-review", description: "Review private-provider-secret in /private/path", location: "/workspace/.opencode/skills/project-review/SKILL.md", content: "private-skill-content" },
        { name: "global-review", location: "/home/person/.config/opencode/skills/global-review/SKILL.md", content: "private-skill-content" },
      ]))
      if (url.pathname === "/mcp") return response.end(JSON.stringify(statuses))
      if (url.pathname === "/provider") return response.end(JSON.stringify({ all: [{ id: "vendor", name: "Vendor", key: "private-provider-secret", models: {} }], connected: ["vendor"], default: {} }))
      if (url.pathname === "/provider/auth") return response.end(JSON.stringify({ vendor: [{ type: "api", label: "API key", prompts: [{ key: "hidden", message: "private-provider-secret" }] }, { type: "oauth", label: "OAuth" }] }))
      response.writeHead(404); return response.end("{}")
    }
    writes.push({ method: request.method!, path: url.pathname, body })
    if (url.pathname === "/config") {
      const patch = body as Config
      if (ineffectiveConfig) return response.end(JSON.stringify(patch))
      if (patch.skills) settings.skills = { ...settings.skills, ...patch.skills }
      if (patch.plugin) settings.plugin = patch.plugin
      if (patch.mcp) for (const [name, value] of Object.entries(patch.mcp)) settings.mcp![name] = { ...settings.mcp![name], ...value }
      return response.end(JSON.stringify(settings))
    }
    if (url.pathname === "/mcp") {
      const item = body as { name: string; config: { enabled: boolean } }
      statuses[item.name] = { status: item.config.enabled ? "connected" : "disabled" }
      return response.end(JSON.stringify(statuses))
    }
    const mcpOperation = url.pathname.match(/^\/mcp\/([^/]+)\/(connect|disconnect)$/)
    if (mcpOperation) statuses[mcpOperation[1]!] = { status: mcpOperation[2] === "connect" ? "connected" : "disabled" }
    response.end("true")
  })
  const upstreamUrl = await listen(upstream)
  const config: BridgeConfig = { bridgeHost: "127.0.0.1", bridgePort: 0, openCodeUrl: new URL(upstreamUrl), openCodeDirectory: "/workspace", openCodeUsername: "opencode", databasePath, managementAllowedHosts: ["example.com"], ...bridgeSecrets }
  const store = new BridgeStore(databasePath)
  const token = "A".repeat(43), otherToken = "B".repeat(43)
  store.ensureAuthorizedUser("owner")
  const pair = (code: string, value: string) => { store.replacePairingCode(code, now + 900); return store.pairDevice("owner", code, now + 900, code, "{}", code, hash(value), now + 900, now)! }
  const actor = { userId: "owner", deviceId: pair("first", token) }, other = pair("second", otherToken)
  const security = new SecurityBoundary(store, "owner", () => now)
  const { recoveryKey } = await security.setupRecovery(actor, token)
  let privilege = (await security.elevate(actor, token, recoveryKey)).token
  let currentToken = token
  const adapter = createOpenCodeManagement(config, async () => [{ address: "93.184.216.34", family: 4 }])
  let actions = new ManagementActions(store, adapter, () => now)
  const api = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: (value) => value ? store.sessionIdentity(hash(value), now) ?? false : false,
    requirePrivilege: security.requirePrivilege.bind(security),
    actionRequiresPrivilege: (id, current) => store.pendingActionRequiresPrivilege(id, current),
    loadManagement: adapter.load,
    proposeManagement: (current, input, guard) => actions.propose(current, input, guard),
    decideAction: async ({ actionId, decision, sessionHash, revalidate }) => {
      const guard = () => { store.assertDeviceAccess(actor.userId, actor.deviceId); revalidate?.() }
      guard()
      const action = store.decidePendingAction(actionId, actor.userId, actor.deviceId, decision, now, sessionHash)
      if (!action) throw new Error("Unavailable")
      if (action.decision === "denied") { actions.discard(actionId); return { status: "denied" } }
      assert.equal(action.action, "management")
      if (action.action === "management") await actions.execute(actionId, { ...actor, sessionHash: sessionHash! }, action.mutation, guard)
      store.recordActionExecution(actor.userId, "executed")
      return { status: "executed" }
    },
  }))
  const base = await listen(api)
  const submit = (path: string, body: unknown, elevated = true, authenticated = true) => fetch(`${base}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { cookie: `bridge_session=${currentToken}${elevated ? `; bridge_privileged=${privilege}` : ""}` } : {}) }, body: JSON.stringify(body) })
  return { actor, other, store, settings, writes, adapter, base, token, security, submit,
    propose: async (path: string, body: unknown) => { const response = await submit(`opencode/${path}/actions`, body); assert.equal(response.status, 202); return await response.json() as { actionId: string; summary: ManagementMutation } },
    setConfigRead: (callback: typeof onConfigRead) => { onConfigRead = callback },
    setIneffectiveConfig: () => { ineffectiveConfig = true },
    replaceSession: async () => {
      const value = "C".repeat(43), challenge = store.createDeviceChallenge("owner", actor.deviceId)!
      assert(store.consumeChallengeAndCreateSession({ userId: "owner", deviceId: actor.deviceId, challengeId: challenge.id, initDataHash: "replacement-session-proof", initDataExpiresAt: now + 900, sessionTokenHash: hash(value), sessionExpiresAt: now + 900 }))
      privilege = (await security.elevate(actor, value, recoveryKey)).token; currentToken = value
    },
    restartVault: () => { actions.close(); actions = new ManagementActions(store, adapter, () => now) },
    advance: (seconds: number) => { now += seconds },
    elevate: async () => { privilege = (await security.elevate(actor, token, recoveryKey)).token },
    cleanup: async () => { actions.close(); await close(api); await close(upstream); store.close() },
  }
}

test("management catalog uses SDK metadata and withholds absolute paths, content, prompts, headers and credentials", async () => {
  const f = await fixture()
  try {
    assert.equal((await fetch(`${f.base}/api/v1/opencode/management`)).status, 401)
    const response = await fetch(`${f.base}/api/v1/opencode/management`, { headers: { cookie: `bridge_session=${f.token}` } })
    assert.equal(response.status, 200)
    const catalog = await response.json()
    assert.deepEqual(catalog.skills.map((item: { source: string; scope: string }) => [item.source, item.scope]), [["project", "project"], ["global", "global"]])
    assert.deepEqual(catalog.mcpServers, [{ name: "remote", status: "connected", enabled: true, configType: "remote" }])
    assert.deepEqual(catalog.providers[0].methods, [{ type: "api", label: "API key", supported: true }, { type: "oauth", label: "OAuth", supported: false }])
    assert.equal(catalog.plugins[0].package, "@scope/existing@1.0.0")
    const raw = JSON.stringify(catalog)
    for (const forbidden of ["private-", "/home/", "/workspace/", "/private/", "Authorization", "prompts", "apiKey", "content", "location"]) assert.equal(raw.includes(forbidden), false, forbidden)
    assert.equal(f.writes.length, 0)
  } finally { await f.cleanup() }
})

test("each approved mutation issues the narrow official SDK writes and preserves unrelated settings", async () => {
  const f = await fixture()
  try {
    const cases: Array<[string, unknown, Array<{ method: string; path: string; body?: unknown }>]> = [
      ["mcp", { operation: "add", name: "new-remote", url: "https://example.com/new" }, [{ method: "POST", path: "/mcp", body: { name: "new-remote", config: { type: "remote", url: "https://example.com/new", enabled: false } } }]],
      ["mcp", { operation: "connect", name: "new-remote" }, [{ method: "POST", path: "/mcp", body: { name: "new-remote", config: { type: "remote", url: "https://example.com/new", enabled: true } } }]],
      ["mcp", { operation: "connect", name: "remote" }, [{ method: "POST", path: "/mcp/remote/connect" }]],
      ["mcp", { operation: "disconnect", name: "new-remote" }, [{ method: "POST", path: "/mcp/new-remote/disconnect" }]],
      ["mcp", { operation: "disable", name: "remote" }, [{ method: "PATCH", path: "/config", body: { mcp: { remote: { enabled: false } } } }, { method: "POST", path: "/mcp/remote/disconnect" }]],
      ["mcp", { operation: "remove", name: "remote" }, [{ method: "PATCH", path: "/config", body: { mcp: { remote: { enabled: false } } } }, { method: "POST", path: "/mcp/remote/disconnect" }]],
      ["providers/vendor", { operation: "connect", key: "ephemeral-credential-value" }, [{ method: "PUT", path: "/auth/vendor", body: { type: "api", key: "ephemeral-credential-value" } }]],
      ["integrations/vendor", { operation: "remove" }, [{ method: "DELETE", path: "/auth/vendor" }]],
    ]
    for (const [path, body, expected] of cases) {
      const start = f.writes.length
      const proposal = await f.propose(path, body)
      assert.equal(f.writes.length, start, "proposal must never write SDK state")
      assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "approve" })).status, 200)
      assert.equal(f.writes.length - start, expected.length)
      expected.forEach((request, index) => { const actual = f.writes[start + index]!; assert.equal(actual.method, request.method); assert.equal(actual.path, request.path); if (request.body) assert.deepEqual(actual.body, request.body) })
      assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "approve" })).status, 409)
    }
    assert.deepEqual(f.settings.skills?.paths, ["/private/path"])
    assert.deepEqual(f.settings.plugin, [["@scope/existing@1.0.0", { token: "private-plugin-secret" }], "file:///private/plugin.js"])
    assert.equal(f.settings.mcp?.remote && "headers" in f.settings.mcp.remote && f.settings.mcp.remote.headers?.Authorization, "private-mcp-secret")
  } finally { await f.cleanup() }
})

test("proposals and positive decisions require current session and step-up; denial never writes", async () => {
  const f = await fixture()
  try {
    const path = "opencode/providers/vendor/actions", body = { operation: "connect", key: "temporary-secret" }
    assert.equal((await f.submit(path, body, true, false)).status, 401)
    assert.equal((await f.submit(path, body, false)).status, 403)
    const proposal = await f.propose("providers/vendor", body)
    assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "approve" }, false)).status, 403)
    assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "deny" }, false)).status, 200)
    assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "approve" })).status, 409)
    assert.equal(f.writes.length, 0)
  } finally { await f.cleanup() }
})

test("provider credential never persists in SQLite/audit/response and restart fails closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "management-secret-"))
  const f = await fixture(join(directory, "bridge.sqlite"))
  const secret = "UNIQUE_EPHEMERAL_PROVIDER_CREDENTIAL_938217"
  try {
    const proposal = await f.propose("providers/vendor", { operation: "connect", key: secret })
    assert.equal(JSON.stringify(proposal).includes(secret), false)
    assert.equal(JSON.stringify(f.store.listAuditEvents("owner")).includes(secret), false)
    for (const file of readdirSync(directory)) assert.equal(readFileSync(join(directory, file)).includes(Buffer.from(secret)), false, file)
    f.restartVault()
    const response = await f.submit(`actions/${proposal.actionId}/decision`, { decision: "approve" })
    assert.equal(response.status, 409); assert.equal((await response.text()).includes(secret), false); assert.equal(f.writes.length, 0)
    const replacement = await f.propose("providers/vendor", { operation: "connect", key: secret })
    assert.equal((await f.submit(`actions/${replacement.actionId}/decision`, { decision: "approve" })).status, 200)
    for (const file of readdirSync(directory)) assert.equal(readFileSync(join(directory, file)).includes(Buffer.from(secret)), false, file)
    assert.equal(JSON.stringify(f.store.listAuditEvents("owner")).includes(secret), false)
  } finally { await f.cleanup(); rmSync(directory, { recursive: true }) }
})

test("credential expiry is checked immediately before the SDK write even when approved earlier", async () => {
  const f = await fixture()
  try {
    const proposal = await f.propose("providers/vendor", { operation: "connect", key: "temporary-secret" })
    f.advance(300)
    await f.elevate()
    // Pending metadata may remain at the inclusive boundary; secret TTL does not.
    assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "approve" })).status, 409)
    assert.equal(f.writes.length, 0)
  } finally { await f.cleanup() }
})

test("device revocation across SDK config reads prevents the write after human approval", async () => {
  const f = await fixture()
  try {
    const proposal = await f.propose("mcp", { operation: "disable", name: "remote" })
    f.setConfigRead(() => { assert.equal(f.store.revokeTrustedDevice("owner", f.actor.deviceId, f.other), true) })
    assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "approve" })).status, 409)
    assert.equal(f.writes.length, 0)
  } finally { await f.cleanup() }
})

test("partial management HTTP body is reauthenticated after revocation before creating a proposal", async () => {
  const f = await fixture()
  let client: ReturnType<typeof httpRequest> | undefined
  try {
    const result = new Promise<number>((resolve, reject) => {
      client = httpRequest(`${f.base}/api/v1/opencode/plugins/actions`, { method: "POST", headers: { cookie: `bridge_session=${f.token}`, "content-type": "application/json" } }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode!)) })
      client.on("error", reject); client.write('{"operation":"add","package":"safe-plugin"')
    })
    // Flush the partial body and allow the handler to authenticate it.
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    f.store.revokeTrustedDevice("owner", f.actor.deviceId, f.other)
    client!.end("}")
    assert.equal(await result, 401); assert.equal(f.writes.length, 0)
  } finally { client?.destroy(); await f.cleanup() }
})

test("SDK transport repeats authorization after its async request preparation", async () => {
  const f = await fixture()
  try {
    let checks = 0
    await assert.rejects(f.adapter.execute({ type: "mcp.disable", name: "remote" }, () => {
      f.store.assertDeviceAccess(f.actor.userId, f.actor.deviceId)
      checks++
      if (checks === 2) f.store.revokeTrustedDevice("owner", f.actor.deviceId, f.other)
    }))
    assert.equal(checks, 2)
    assert.equal(f.writes.length, 0, "transport guard must reject the revoked actor before fetch")
  } finally { await f.cleanup() }
})

test("step-up expiration during SDK read blocks configuration writes", async () => {
  const f = await fixture()
  try {
    const proposal = await f.propose("mcp", { operation: "disable", name: "remote" })
    f.setConfigRead(() => f.advance(300))
    assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "approve" })).status, 403)
    assert.equal(f.writes.length, 0)
  } finally { await f.cleanup() }
})

test("management REST endpoints reject unsupported fields and unsafe input before proposal or SDK write", async () => {
  const f = await fixture()
  try {
    const invalid: Array<[string, unknown]> = [
      ["skills", { operation: "add", url: "http://example.com" }],
      ["mcp", { operation: "add", name: "constructor", url: "https://example.com/mcp" }],
      ["mcp", { operation: "add", name: "valid", url: "https://example.com/mcp", headers: { Authorization: "secret" } }],
      ["plugins", { operation: "add", package: "file:///private/plugin.js" }],
      ["providers/vendor", { operation: "oauth", code: "secret" }],
      ["providers/vendor", { operation: "connect", key: "secret\nvalue" }],
      ["providers/vendor", { operation: "connect", key: "secret", config: {} }],
    ]
    for (const [path, body] of invalid) assert.equal((await f.submit(`opencode/${path}/actions`, body)).status, 400, path)
    assert.equal(f.store.listAuditEvents("owner").some((event) => event.outcome === "ask"), false)
    assert.equal(f.writes.length, 0)
  } finally { await f.cleanup() }
})

test("management validators reject local/insecure URLs, prototype names, package code and unsupported mutations", () => {
  for (const value of ["http://example.com", "https://user:pass@example.com", "https://example.com?token=x", "https://127.0.0.1", "https://[::1]", "https://mcp.local", "https://localhost", "file:///tmp/skill", "https://example.com:8443"]) assert.throws(() => normalizeManagementUrl(value), value)
  for (const value of ["../x", "constructor", "__proto__", "x/y", "x y", "x;echo"]) assert.throws(() => normalizeManagementName(value))
  for (const value of ["file:///tmp/x", "https://example.com/x", "--registry=x", "name;echo", "name@latest", "../../plugin", "APlugin"]) assert.throws(() => normalizePluginPackage(value))
  assert.equal(normalizePluginPackage("@scope/package@1.2.3-beta.1"), "@scope/package@1.2.3-beta.1")
  assert.equal(normalizeManagementUrl("https://example.com/skills"), "https://example.com/skills")
  assert.throws(() => normalizeManagementMutation({ type: "provider.oauth", providerId: "vendor" }))
  assert.deepEqual(normalizeManagementMutation({ type: "provider.key.connect", providerId: "vendor", key: "never-persist" }), { type: "provider.key.connect", providerId: "vendor" })
  assert.equal(decide("provider.key.connect"), "ASK"); assert.equal(decide("provider.oauth"), "DENY")
})

test("management actions and ephemeral credentials cannot transfer to another normal session on the same device", async () => {
  const f = await fixture()
  try {
    const proposal = await f.propose("providers/vendor", { operation: "connect", key: "temporary-original-session-secret" })
    await f.replaceSession()
    assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "approve" })).status, 409)
    assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "deny" })).status, 409)
    assert.equal(f.writes.length, 0)
    const current = await f.propose("providers/vendor", { operation: "connect", key: "temporary-current-session-secret" })
    assert.equal((await f.submit(`actions/${current.actionId}/decision`, { decision: "approve" })).status, 200)
    assert.equal(f.writes.length, 1)
  } finally { await f.cleanup() }
})

test("recognized and percent-encoded path credentials are rejected and known credential source URLs are withheld", async () => {
  const f = await fixture()
  try {
    const credential = "sk-abcdefghijklmnopqrstuvwxyz012345"
    for (const path of [credential, credential.replace("sk-", "sk%2D"), "token=opaque-secret"]) {
      assert.throws(() => normalizeManagementUrl(`https://example.com/${path}`))
      assert.equal((await f.submit("opencode/mcp/actions", { operation: "add", name: "unsafe", url: `https://example.com/${path}` })).status, 400)
    }
    f.settings.skills!.urls = [`https://example.com/${credential}`, "https://example.com/private-provider-secret"]
    assert.deepEqual((await f.adapter.load()).skillSources, [])
    assert.equal((await f.submit("opencode/mcp/actions", { operation: "add", name: "unsafe", url: "https://example.com/private-provider-secret" })).status, 400)
    assert.equal(f.store.listAuditEvents("owner").some((event) => event.outcome === "ask"), false)
    assert.equal(f.writes.length, 0)
  } finally { await f.cleanup() }
})

test("exact egress allowlist rejects empty/unlisted hosts and DNS resolutions into every non-public class", async () => {
  const publicDns = async () => [{ address: "93.184.216.34", family: 4 }]
  await assert.rejects(createManagementEgress([], publicDns)("https://example.com/mcp"))
  await assert.rejects(createManagementEgress(["example.com"], publicDns)("https://sub.example.com/mcp"))
  await createManagementEgress(["example.com"], publicDns)("https://example.com/mcp")
  for (const address of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "198.18.0.1", "192.0.2.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1", "2002:7f00:1::", "::"]) {
    assert.equal(isPublicManagementAddress(address), false, address)
    await assert.rejects(createManagementEgress(["127.0.0.1.nip.io"], async () => [{ address, family: address.includes(":") ? 6 : 4 }])("https://127.0.0.1.nip.io/mcp"))
  }
  assert.equal(isPublicManagementAddress("2606:4700:4700::1111"), true)
  await assert.rejects(createManagementEgress(["example.com"], async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }])("https://example.com/mcp"))
  await assert.rejects(createManagementEgress(["example.com"], async () => [])("https://example.com/mcp"))
})

test("skills/plugins explicitly remain read-only and ineffective config echo uses a verified runtime fallback", async () => {
  const f = await fixture()
  try {
    const catalog = await f.adapter.load()
    assert.equal(catalog.mutability.skills.status, "read-only"); assert.equal(catalog.mutability.plugins.status, "read-only")
    assert.equal((await f.submit("opencode/skills/actions", { operation: "remove", url: "https://unlisted.example.com/source" })).status, 400)
    assert.equal((await f.submit("opencode/plugins/actions", { operation: "add", package: "safe-package@1.0.0" })).status, 400)
    assert.equal(f.writes.length, 0)
    f.setIneffectiveConfig()
    const proposal = await f.propose("mcp", { operation: "disable", name: "remote" })
    assert.equal((await f.submit(`actions/${proposal.actionId}/decision`, { decision: "approve" })).status, 200)
    assert.equal(f.settings.mcp?.remote?.enabled, true, "PATCH echo is not mistaken for a persistent disable")
    assert.equal((await f.adapter.load()).mcpServers[0]?.status, "disabled")
    assert.equal((await f.adapter.load()).mutability.mcp.status, "runtime-only")
  } finally { await f.cleanup() }
})

test("encoded SDK and Bridge secrets are withheld from URL catalogs and rejected before proposal persistence or dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "management-url-secret-"))
  const upstreamPassword = "opaque-upstream-password", botToken = "opaque-arbitrary-bot-token"
  const f = await fixture(join(directory, "bridge.sqlite"), { openCodePassword: upstreamPassword, telegram: { botToken, ownerId: "owner" } })
  try {
    const secretValues = ["private-provider-secret", upstreamPassword, botToken]
    const paths = secretValues.flatMap((secret) => [secret, secret.replaceAll("-", "%2D"), secret.replaceAll("-", "%252D")])
    const urls = paths.map((path) => `https://example.com/prefix/${path}/suffix`)
    f.settings.skills!.urls = [...urls, "https://example.com/safe-source"]
    const catalog = await f.adapter.load()
    assert.deepEqual(catalog.skillSources, [{ url: "https://example.com/safe-source" }])
    for (const url of urls) {
      await assert.rejects(f.adapter.validateProposal({ type: "mcp.remote.add", name: "blocked", url }))
      const response = await f.submit("opencode/mcp/actions", { operation: "add", name: "blocked", url })
      assert.equal(response.status, 400)
      const raw = await response.text()
      assert.equal(raw.includes("actionId"), false)
      assert.equal(raw.includes("summary"), false)
      for (const secret of secretValues) assert.equal(raw.includes(secret), false)
      await assert.rejects(f.adapter.execute({ type: "mcp.remote.add", name: "blocked", url }, () => {}))
    }
    assert.equal(f.store.listAuditEvents("owner").some((event) => event.outcome === "ask"), false)
    assert.equal(f.writes.length, 0)
    for (const file of readdirSync(directory)) {
      const bytes = readFileSync(join(directory, file))
      for (const path of paths) assert.equal(bytes.includes(Buffer.from(path)), false)
    }
    assert.throws(() => normalizeManagementUrl("https://example.com/path%25252Dvalue"))
    assert.throws(() => normalizeManagementUrl("https://example.com/broken%encoding"))
  } finally { await f.cleanup(); rmSync(directory, { recursive: true }) }
})
