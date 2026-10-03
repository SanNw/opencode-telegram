import { execFile } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { GitActionError, normalizeGitMutation, type GitMutation } from "./git-actions.js"
import { SecurityError } from "./security.js"
import { decide } from "./policy.js"
import type { BridgeStore, SecurityActor } from "./storage/database.js"
import { redactText } from "./redact.js"

const exec = promisify(execFile)
export type GitRunner = (args: string[], cwd: string) => Promise<string>
const runGit: GitRunner = async (args, cwd) => (await exec("git", args, { cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "push.followTags", GIT_CONFIG_VALUE_0: "false" } })).stdout

function statusPaths(output: string) {
  const files = new Map<string, string>()
  const entries = output.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (!entry) continue
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Invalid Git status")
    const status = entry.slice(0, 2)
    files.set(entry.slice(3), status)
    if (/[RC]/.test(status)) { const source = entries[++i]; if (!source) throw new Error("Invalid Git rename"); files.set(source, /[RC]/.test(status[0]!) ? `${status[0]} ` : ` ${status[1]}`) }
  }
  return files
}

export class GitService {
  readonly #root: Promise<string>
  #busy = false
  constructor(readonly store: BridgeStore, root: string, readonly runner: GitRunner = runGit, readonly secrets: readonly string[] = []) { this.#root = realpath(resolve(root)) }

  async #run(args: string[], guard: () => void) {
    const root = await this.#root
    guard() // Immediately before every subprocess, including reads.
    const output = await this.runner(args, root)
    guard()
    return output
  }

  async #scope(guard: () => void) {
    const root = await this.#root
    const top = (await this.#run(["rev-parse", "--show-toplevel"], guard)).trim()
    if (await realpath(top) !== root) throw new Error("Workspace must be the repository root")
    guard()
    return root
  }

  async #validate(input: GitMutation, guard: () => void) {
    const root = await this.#scope(guard)
    if (input.type !== "git.commit") {
      // Fixed read commands resolve the actual checked-out branch and its exact
      // upstream remote/ref. Never infer a destination from push.default.
      const branch = (await this.#run(["symbolic-ref", "--quiet", "HEAD"], guard)).trim()
      const validRef = (ref: string) => /^refs\/heads\/[A-Za-z0-9_][A-Za-z0-9._/-]{0,239}$/.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && ref.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"))
      if (!validRef(branch)) throw new Error("Detached or unsupported branch")
      const refs = await this.#run(["for-each-ref", "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)", "refs/heads"], guard)
      const matches = refs.split("\n").map((line) => line.split("\0")).filter((parts) => parts[0] === branch)
      if (matches.length !== 1) throw new Error("Upstream unavailable")
      const [, remote = "", ref = ""] = matches[0]!
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote) || !validRef(ref)) throw new Error("Upstream unavailable")
      if (input.type === "git.push") {
        let config = ""
        try { config = await this.#run(["config", "--null", "--get-regexp", "^(remote\\..*\\.(mirror|push|pushurl)|url\\..*\\.pushinsteadof)$"], guard) }
        catch (error) { guard(); if ((error as { code?: unknown }).code !== 1) throw error }
        for (const entry of config.split("\0").filter(Boolean)) {
          const split = entry.indexOf("\n"), key = entry.slice(0, split).toLowerCase(), value = entry.slice(split + 1).toLowerCase()
          if (split < 0 || !key.endsWith(".mirror") || !["false", "no", "off", "0"].includes(value)) throw new Error("Scope-widening push configuration is unsupported")
        }
      }
      return { push: { remote, ref } }
    }
    const files = statusPaths(await this.#run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], guard))
    for (const [path, status] of files) if (status[0] !== " " && status !== "??" && !input.paths.includes(path)) throw new Error("Unselected staged files must be resolved first")
    for (const path of input.paths) {
      if (!files.has(path)) throw new Error("Selected file is not changed")
      const full = resolve(root, path)
      const rel = relative(root, full)
      if (!rel || rel.startsWith(`..${sep}`) || rel === "..") throw new Error("Invalid Git path")
      let candidate = full
      while (candidate !== root) {
        try { if ((await lstat(candidate)).isSymbolicLink()) throw new Error("Symlinks cannot be selected") }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
        candidate = dirname(candidate)
      }
      guard()
    }
    return { stagePaths: input.paths.filter((path) => { const status = files.get(path)!; return status === "??" || status[1] !== " " }) }
  }

  async propose(actor: SecurityActor & { sessionHash: string }, input: unknown, guard: () => void) {
    const mutation = normalizeGitMutation(input)
    guard(); await this.#validate(mutation, guard); guard()
    if (decide(mutation.type) !== "ASK") throw new Error("Policy denied")
    const actionId = this.store.createPendingGit(actor, mutation, actor.sessionHash)
    return { actionId, decision: "ASK" as const, summary: mutation }
  }

  async execute(actor: SecurityActor, input: GitMutation, guard: () => void) {
    if (this.#busy) throw new Error("Git action already running")
    this.#busy = true
    let stagingAttempted = false
    try {
      const mutation = normalizeGitMutation(input)
      guard(); const validated = await this.#validate(mutation, guard); guard()
      if (mutation.type === "git.commit") {
        const stagePaths = validated.stagePaths ?? []
        if (stagePaths.length) {
          stagingAttempted = true
          await this.#run(["add", "-A", "--", ...stagePaths], guard)
        }
        // Recheck paths, staging and privilege after the first write.
        await this.#validate(mutation, guard)
        await this.#run(["commit", "-m", mutation.message], guard)
      } else await this.#run(mutation.type === "git.pull" ? ["pull", "--ff-only"] : ["push", "--", validated.push!.remote, `HEAD:${validated.push!.ref}`], guard)
      this.store.recordSecurityEvent(actor, `${mutation.type}.executed`, "executed", "trusted-device")
    } catch (error) {
      this.store.recordSecurityEvent(actor, `${input.type}.executed`, "failed", "trusted-device", stagingAttempted ? "staging-may-have-changed" : "git-unavailable")
      if (error instanceof SecurityError && !stagingAttempted) throw error
      throw new GitActionError(stagingAttempted)
    } finally { this.#busy = false }
  }

  async read(guard: () => void = () => {}) {
    try {
      await this.#scope(guard)
      const output = await this.#run(["log", "-10", "--format=%H%x00%s%x00%ct"], guard)
      const safe = (value: string) => redactText(value, this.secrets).replace(/(^|[\s"'=+(])(?:[A-Za-z]:[\\/]|\/)[^\s"')]+/gm, "$1[path]").slice(0, 512)
      const commits = output.trim().split("\n").filter(Boolean).map((line) => { const [id, subject, timestamp] = line.split("\0"); return { id: /^[a-f0-9]{40,64}$/.test(id ?? "") ? id : undefined, subject: safe(subject ?? ""), createdAt: Number(timestamp) || 0 } })
      let upstream: string | undefined, ahead: number | undefined, behind: number | undefined
      try {
        upstream = safe((await this.#run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], guard)).trim())
        const counts = (await this.#run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], guard)).trim().split(/\s+/)
        if (counts.length === 2 && counts.every((count) => /^\d+$/.test(count))) { ahead = Number(counts[0]); behind = Number(counts[1]) }
      } catch { guard() }
      return { commits, ...(upstream ? { upstream, ahead, behind } : {}) }
    } catch { guard(); return { commits: [] } }
  }
}
