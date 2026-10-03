import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { createRequestHandler } from "./app.js"
import { AttachmentService } from "./attachments.js"
import { normalizeGitMutation } from "./git-actions.js"
import { GitService, type GitRunner } from "./git.js"
import { createVcsDiffLoader } from "./opencode.js"
import { decide } from "./policy.js"
import { SecurityBoundary } from "./security.js"
import { BridgeStore } from "./storage/database.js"

const exec = promisify(execFile), hash = (value: string) => createHash("sha256").update(value).digest("hex")
const listen = async (server: Server) => { await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address === "object"); return `http://127.0.0.1:${address.port}` }
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

async function fixture(runner?: GitRunner) {
  const root = await mkdtemp(join(tmpdir(), "bridge-git-")), store = new BridgeStore(":memory:")
  await exec("git", ["init", "-q"], { cwd: root })
  await exec("git", ["config", "user.name", "Bridge Test"], { cwd: root })
  await exec("git", ["config", "user.email", "bridge@example.invalid"], { cwd: root })
  const now = Math.floor(Date.now() / 1000), token = "A".repeat(43)
  store.ensureAuthorizedUser("owner"); store.replacePairingCode("pair", now + 900)
  const deviceId = store.pairDevice("owner", "proof", now + 900, "pair", "{}", "Test", hash(token), now + 900)!
  const actor = { userId: "owner", deviceId }, service = new GitService(store, root, runner)
  const security = new SecurityBoundary(store, "owner")
  const { recoveryKey } = await security.setupRecovery(actor, token)
  const elevated = await security.elevate(actor, token, recoveryKey)
  const attachments = new AttachmentService(store, root)
  const api = createServer(createRequestHandler({
    loadSnapshot: async () => { throw new Error("unused") },
    authorizeSession: (value) => value ? store.sessionIdentity(hash(value)) ?? false : false,
    requirePrivilege: security.requirePrivilege.bind(security),
    actionRequiresPrivilege: (id, current) => store.pendingActionRequiresPrivilege(id, current),
    proposeGit: (current, input, guard) => service.propose(current, input, guard),
    loadArtifacts: (current) => store.listArtifacts(current.userId, current.category, current.cursor, current.limit),
    loadVcsDiff: async (mode) => ({ mode, files: [] }),
    loadAttachment: (current) => attachments.read(current.userId, current.attachmentId),
    decideAction: async ({ actionId, decision, sessionHash, revalidate }) => {
      const guard = () => { store.assertDeviceAccess(actor.userId, actor.deviceId); revalidate?.() }; guard()
      const action = store.decidePendingAction(actionId, actor.userId, actor.deviceId, decision, undefined, sessionHash)
      if (!action) throw new Error("Unavailable")
      if (action.decision === "denied") return { status: "denied" }
      assert.equal(action.action, "git")
      if (action.action === "git") await service.execute(actor, action.mutation, guard)
      return { status: "executed" }
    },
  }))
  const url = await listen(api)
  const cookie = `bridge_session=${token}; bridge_privileged=${elevated.token}`
  return { root, store, actor, service, security, attachments, token, cookie, url,
    submit: (path: string, body: unknown, suppliedCookie = cookie) => fetch(`${url}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: suppliedCookie }, body: JSON.stringify(body) }),
    cleanup: async () => { await close(api); store.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test("Git intents reject arbitrary flags, refs, shell/pathspec injection and path escapes", () => {
  for (const type of ["git.commit", "git.pull", "git.push"]) assert.equal(decide(type), "ASK")
  for (const paths of [["../escape"], ["/absolute"], ["C:\\escape"], [":(glob)*"], ["--all"], [".git/config"], ["a\nb"], [], Array(101).fill("a")]) assert.throws(() => normalizeGitMutation({ type: "git.commit", message: "test", paths }))
  assert.throws(() => normalizeGitMutation({ type: "git.push", remote: "attacker" }))
  assert.throws(() => normalizeGitMutation({ type: "git.pull", ref: "main" }))
  assert.throws(() => normalizeGitMutation({ type: "git.commit", message: "x\ny", paths: ["a"] }))
  assert.deepEqual(normalizeGitMutation({ type: "git.commit", message: "$(touch bad) `whoami`", paths: ["a.txt"] }), { type: "git.commit", message: "$(touch bad) `whoami`", paths: ["a.txt"] })
})

test("commit requires current session, step-up, ASK and one same-session approval", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, "report.md"), "# Test")
    const body = { operation: "commit", message: "$(touch injected) literal message", paths: ["report.md"] }
    assert.equal((await f.submit("opencode/vcs/actions", body, "")).status, 401)
    assert.equal((await f.submit("opencode/vcs/actions", body, `bridge_session=${f.token}`)).status, 403)
    assert.equal((await f.submit("opencode/vcs/actions", { operation: "push", remote: "evil" })).status, 400)
    const proposal = await f.submit("opencode/vcs/actions", body); assert.equal(proposal.status, 202)
    const { actionId } = await proposal.json() as { actionId: string }
    await assert.rejects(exec("git", ["rev-parse", "HEAD"], { cwd: f.root }))
    assert.equal((await f.submit(`actions/${actionId}/decision`, { decision: "approve" }, `bridge_session=${f.token}`)).status, 403)
    const result = await f.submit(`actions/${actionId}/decision`, { decision: "approve" }); assert.equal(result.status, 200)
    assert.equal((await exec("git", ["show", "HEAD:report.md"], { cwd: f.root })).stdout, "# Test")
    assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "")
    assert.equal((await f.submit(`actions/${actionId}/decision`, { decision: "approve" })).status, 409)
    const read = await f.service.read()
    assert.equal(read.commits.length, 1); assert.equal(read.commits[0]?.subject, body.message)
    assert.equal((await fetch(`${f.url}/api/v1/opencode/vcs/diff`)).status, 401)
    assert.equal((await fetch(`${f.url}/api/v1/opencode/vcs/diff?mode=evil`, { headers: { cookie: f.cookie } })).status, 400)
  } finally { await f.cleanup() }
})

test("Git proposals bind the originating session and cannot survive lock or expiry", async () => {
  const f = await fixture()
  try {
    const proposal = f.store.createPendingGit(f.actor, { type: "git.push" }, hash(f.token))
    const now = Math.floor(Date.now() / 1000), replacement = "B".repeat(43), challenge = f.store.createDeviceChallenge("owner", f.actor.deviceId)!
    assert(f.store.consumeChallengeAndCreateSession({ userId: "owner", deviceId: f.actor.deviceId, challengeId: challenge.id, initDataHash: "new-proof", initDataExpiresAt: now + 900, sessionTokenHash: hash(replacement), sessionExpiresAt: now + 900 }))
    assert.equal(f.store.decidePendingAction(proposal, "owner", f.actor.deviceId, "approve", now, hash(replacement)), undefined)
    assert.equal(f.store.decidePendingAction(proposal, "owner", f.actor.deviceId, "approve", now + 301, hash(f.token)), undefined)
    f.store.lockRemoteAccess(f.actor, false, now)
    assert.equal(f.store.decidePendingAction(proposal, "owner", f.actor.deviceId, "approve", now, hash(f.token)), undefined)
  } finally { await f.cleanup() }
})

test("Git rejects symlinks and unselected staged files; reports partial staging and revalidates privilege", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, "one.txt"), "one"); await writeFile(join(f.root, "two.txt"), "two")
    await exec("git", ["add", "two.txt"], { cwd: f.root })
    await assert.rejects(f.service.propose({ ...f.actor, sessionHash: hash(f.token) }, { type: "git.commit", message: "test", paths: ["one.txt"] }, () => {}), /Unselected staged/)
    await symlink(join(f.root, "one.txt"), join(f.root, "link.txt"))
    await assert.rejects(f.service.propose({ ...f.actor, sessionHash: hash(f.token) }, { type: "git.commit", message: "test", paths: ["two.txt", "link.txt"] }, () => {}), /Symlinks/)
    const calls: string[][] = []; let live = true
    const runner: GitRunner = async (args) => { calls.push(args); if (args[0] === "rev-parse") return f.root; if (args[0] === "status") return "?? one.txt\0"; if (args[0] === "add") { live = false; return "" }; throw new Error("Unexpected command") }
    const service = new GitService(f.store, f.root, runner)
    await assert.rejects(service.execute(f.actor, { type: "git.commit", message: "test", paths: ["one.txt"] }, () => { if (!live) throw new Error("expired") }), /may remain staged/)
    assert.deepEqual(calls.filter((args) => ["add", "commit"].includes(args[0]!)), [["add", "-A", "--", "one.txt"]])
    assert(f.store.listAuditEvents("owner").some((event) => event.event === "git.commit.executed" && event.outcome === "failed"))
  } finally { await f.cleanup() }
})

test("pull and push use fixed argv and guard each subprocess", async () => {
  const calls: string[][] = [], f = await fixture()
  try {
    let guards = 0
    const service = new GitService(f.store, f.root, async (args) => { calls.push(args); if (args[0] === "rev-parse") return f.root; if (args[0] === "symbolic-ref") return "refs/heads/main"; if (args[0] === "for-each-ref") return "refs/heads/main\0origin\0refs/heads/main\n"; return "" })
    await service.execute(f.actor, { type: "git.pull" }, () => { guards++ })
    await service.execute(f.actor, { type: "git.push" }, () => { guards++ })
    assert.deepEqual(calls.filter((args) => ["push", "pull"].includes(args[0]!)), [["pull", "--ff-only"], ["push", "--", "origin", "HEAD:refs/heads/main"]])
    assert(guards >= calls.length * 2)
  } finally { await f.cleanup() }
})

test("approved pull/push and upstream counts work against controlled temporary repositories", async () => {
  const f = await fixture(), network = await mkdtemp(join(tmpdir(), "bridge-git-remotes-"))
  try {
    const bare = join(network, "origin.git"), peer = join(network, "peer")
    await exec("git", ["init", "--bare", "-q", bare])
    await writeFile(join(f.root, "first.txt"), "initial")
    await exec("git", ["add", "first.txt"], { cwd: f.root }); await exec("git", ["commit", "-qm", "initial"], { cwd: f.root })
    await exec("git", ["remote", "add", "origin", bare], { cwd: f.root }); await exec("git", ["push", "-u", "origin", "HEAD"], { cwd: f.root })
    await exec("git", ["clone", "-q", bare, peer]); await exec("git", ["config", "user.name", "Peer Test"], { cwd: peer }); await exec("git", ["config", "user.email", "peer@example.invalid"], { cwd: peer })
    await writeFile(join(peer, "peer.txt"), "remote change"); await exec("git", ["add", "peer.txt"], { cwd: peer }); await exec("git", ["commit", "-qm", "remote change"], { cwd: peer }); await exec("git", ["push"], { cwd: peer })
    await exec("git", ["fetch"], { cwd: f.root })
    const behind = await f.service.read(); assert.equal(behind.behind, 1); assert.equal(behind.ahead, 0); assert.match(behind.upstream!, /^origin\//)
    for (const operation of ["pull", "push"] as const) {
      if (operation === "push") { await writeFile(join(f.root, "local.txt"), "local change"); await exec("git", ["add", "local.txt"], { cwd: f.root }); await exec("git", ["commit", "-qm", "local change"], { cwd: f.root }); await exec("git", ["tag", "-a", "private-tag", "-m", "unapproved tag"], { cwd: f.root }); await exec("git", ["config", "push.followTags", "true"], { cwd: f.root }); assert.equal((await f.service.read()).ahead, 1) }
      const proposal = await f.submit("opencode/vcs/actions", { operation }); assert.equal(proposal.status, 202)
      const { actionId } = await proposal.json() as { actionId: string }
      const result = await f.submit(`actions/${actionId}/decision`, { decision: "approve" }); assert.equal(result.status, 200)
    }
    assert.equal((await f.service.read()).ahead, 0); assert.equal((await f.service.read()).behind, 0)
    assert.equal((await exec("git", ["show", "HEAD:peer.txt"], { cwd: f.root })).stdout, "remote change")
    assert.equal((await exec("git", ["show", "HEAD:local.txt"], { cwd: bare })).stdout, "local change")
    assert.equal((await exec("git", ["tag", "--list"], { cwd: bare })).stdout, "")
    // Actual mirror reproduction: an extra local branch would leak and a
    // remote-only branch would disappear under an implicit mirror push.
    await exec("git", ["branch", "private-unapproved"], { cwd: f.root }); await exec("git", ["branch", "remote-only", "HEAD"], { cwd: bare })
    const before = (await exec("git", ["show-ref"], { cwd: bare })).stdout
    await exec("git", ["config", "remote.origin.mirror", "true"], { cwd: f.root })
    await assert.rejects(f.service.execute(f.actor, { type: "git.push" }, () => {}), /unavailable/)
    assert.equal((await exec("git", ["show-ref"], { cwd: bare })).stdout, before)
    await exec("git", ["config", "remote.origin.mirror", "false"], { cwd: f.root })
    for (const [key, value] of [["remote.origin.push", "refs/heads/private-unapproved"], ["remote.origin.pushurl", bare], ["url./tmp/elsewhere.pushInsteadOf", bare]]) {
      await exec("git", ["config", key!, value!], { cwd: f.root })
      await assert.rejects(f.service.execute(f.actor, { type: "git.push" }, () => {}), /unavailable/)
      await exec("git", ["config", "--unset", key!], { cwd: f.root })
    }
    assert.equal((await exec("git", ["show-ref"], { cwd: bare })).stdout, before)
  } finally { await f.cleanup(); await rm(network, { recursive: true, force: true }) }
})

test("commit accepts git-rm staged deletions, unstaged deletions and staged rename selections", async () => {
  const f = await fixture()
  try {
    for (const path of ["obsolete.txt", "unstaged.txt", "old-name.txt"]) await writeFile(join(f.root, path), "tracked")
    await exec("git", ["add", "--all"], { cwd: f.root }); await exec("git", ["commit", "-qm", "initial"], { cwd: f.root })
    await exec("git", ["rm", "obsolete.txt"], { cwd: f.root }); await rm(join(f.root, "unstaged.txt")); await exec("git", ["mv", "old-name.txt", "new-name.txt"], { cwd: f.root })
    const proposal = await f.submit("opencode/vcs/actions", { operation: "commit", message: "remove obsolete files and rename", paths: ["obsolete.txt", "unstaged.txt", "old-name.txt", "new-name.txt"] }); assert.equal(proposal.status, 202)
    const { actionId } = await proposal.json() as { actionId: string }
    const result = await f.submit(`actions/${actionId}/decision`, { decision: "approve" }); assert.equal(result.status, 200)
    assert.equal((await exec("git", ["ls-tree", "--name-only", "HEAD"], { cwd: f.root })).stdout, "new-name.txt\n")
    assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "")
  } finally { await f.cleanup() }
})

test("artifacts expose only explicit OpenCode handles, owner-bound opaque IDs, filters and pagination", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, "report.md"), "# Artifact"); await writeFile(join(f.root, "script.ts"), "export const answer = 42")
    await writeFile(join(f.root, "image.png"), Buffer.from([137,80,78,71,13,10,26,10]))
    await writeFile(join(f.root, "ordinary.txt"), "not an artifact")
    await f.attachments.storageRoot("owner")
    const storage = await f.attachments.storageRoot("owner"); await f.attachments.listDirectory("owner", storage.id)
    f.attachments.createUpload("owner", "upload.md", Buffer.from("input"))
    for (const sourcePath of ["report.md", "script.ts", "image.png"]) await f.attachments.register({ userId: "owner", sessionId: "ses_produced", sourcePath })
    assert.equal((await fetch(`${f.url}/api/v1/artifacts`)).status, 401)
    const request = (query: string) => fetch(`${f.url}/api/v1/artifacts${query}`, { headers: { cookie: f.cookie } })
    const first = await (await request("?limit=2")).json() as { artifacts: Array<{ id: string; name: string; sessionId: string; createdAt: number }>; nextCursor: string }
    assert.equal(first.artifacts.length, 2); assert.equal(first.nextCursor, "2")
    const second = await (await request("?limit=2&cursor=2")).json() as { artifacts: Array<{ id: string }> }
    assert.equal(second.artifacts.length, 1); assert.equal(new Set([...first.artifacts, ...second.artifacts].map((item) => item.id)).size, 3)
    assert(first.artifacts.every((item) => /^att_[A-Za-z0-9_-]{32}$/.test(item.id) && item.sessionId === "ses_produced" && Number.isFinite(item.createdAt)))
    assert.equal(JSON.stringify(first).includes(f.root), false); assert.equal(JSON.stringify(first).includes("relativePath"), false)
    for (const [category, name] of [["documents", "report.md"], ["code", "script.ts"], ["images", "image.png"]]) {
      const result = await (await request(`?category=${category}`)).json() as { artifacts: Array<{ name: string }> }
      assert.deepEqual(result.artifacts.map((item) => item.name), [name])
    }
    assert.equal((await request("?category=invalid")).status, 400); assert.equal((await request("?limit=101")).status, 400); assert.equal((await request("?cursor=-1")).status, 400)
    assert.deepEqual(f.store.listArtifacts("other", "all", 0, 50).artifacts, [])
    const preview = await fetch(`${f.url}/api/v1/attachments/${first.artifacts[0]!.id}`, { headers: { cookie: f.cookie } }); assert.equal(preview.status, 200)
  } finally { await f.cleanup() }
})

test("VCS diff uses official SDK with bounded mode, secret and path redaction", async () => {
  const requests: string[] = []
  const upstream = createServer((request, response) => { requests.push(request.url!); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify([{ file: "/workspace/report.md", patch: "secret-password /home/private/file\n+ok", additions: 1, deletions: 0, status: "modified" }])) })
  const url = await listen(upstream)
  try {
    const loader = createVcsDiffLoader({ openCodeUrl: new URL(url), openCodeDirectory: "/workspace", openCodePassword: "secret-password", openCodeUsername: "opencode", bridgeHost: "127.0.0.1", bridgePort: 0, databasePath: ":memory:" })
    const result = await loader("git")
    assert.equal(result.files[0]?.file, "report.md"); assert(!JSON.stringify(result).includes("secret-password")); assert(!JSON.stringify(result).includes("/home/private"))
    assert(requests[0]?.startsWith("/vcs/diff?")); assert(requests[0]?.includes("mode=git"))
  } finally { await close(upstream) }
})
