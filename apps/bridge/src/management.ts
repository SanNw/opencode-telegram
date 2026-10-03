import { isAbsolute, relative, resolve } from "node:path"
import type { Config } from "@opencode-ai/sdk/v2/client"
import type { BridgeConfig } from "./config.js"
import { createClient } from "./opencode.js"
import { assertManagementUrlSecretFree, normalizeManagementMutation, normalizeManagementUrl, normalizePluginPackage, type ManagementMutation } from "./management-actions.js"
import { decide } from "./policy.js"
import { redactText } from "./redact.js"
import type { BridgeStore, SecurityActor } from "./storage/database.js"
import { SecurityError } from "./security.js"
import { createManagementEgress, type ManagementResolver } from "./management-egress.js"

export type ManagementCatalog = {
  mutability: { skills: { status: "read-only"; reason: string }; plugins: { status: "read-only"; reason: string }; mcp: { status: "runtime-only"; reason: string }; providers: { status: "available"; reason: string } }
  skills: Array<{ name: string; description?: string; source: "project" | "global" | "remote" | "unknown"; scope: "project" | "global" | "unknown" }>
  skillSources: Array<{ url: string }>
  mcpServers: Array<{ name: string; status: string; enabled: boolean; configType: "remote" | "local" | "disabled" | "unknown" }>
  plugins: Array<{ name: string; package?: string; source: "package" | "local" }>
  providers: Array<{ id: string; name: string; connected: boolean; methods: Array<{ type: "api" | "oauth"; label: string; supported: boolean }> }>
  integrations: Array<{ id: string; kind: "provider" | "mcp" | "plugin"; name: string; connected: boolean; methods: Array<"api" | "oauth"> }>
}

function safePackage(value: string) { try { return normalizePluginPackage(value) } catch { return undefined } }
function safeUrl(value: string, secrets: readonly string[] = []) { try { assertManagementUrlSecretFree(value, secrets); return normalizeManagementUrl(value) } catch { return undefined } }

function credentialValues(value: unknown, key = "", depth = 0): string[] {
  if (depth > 12 || !value) return []
  if (typeof value === "string") return /^(?:key|apiKey|api_key|token|secret|password|authorization|clientSecret|client_secret)$/i.test(key) ? [value] : []
  if (typeof value !== "object") return []
  if (/^headers$/i.test(key)) return Object.values(value).filter((item): item is string => typeof item === "string")
  return Object.entries(value).flatMap(([field, child]) => credentialValues(child, field, depth + 1))
}

/** The only OpenCode management adapter: no direct filesystem/config writes. */
export function createOpenCodeManagement(config: BridgeConfig, resolver?: ManagementResolver) {
  const egress = createManagementEgress(config.managementAllowedHosts ?? [], resolver)
  const runtimeSources = new Map<string, { type: "remote"; url: string; enabled: boolean }>()
  let writeGuard: (() => void) | undefined
  const client = createClient(config, () => {
    if (!writeGuard) throw new SecurityError(403, "Approved action required")
    writeGuard()
  })
  const request = { directory: config.openCodeDirectory }
  const options = () => ({ signal: AbortSignal.timeout(10_000) })
  const knownSecrets = (...sources: unknown[]) => [config.openCodePassword ?? "", config.telegram?.botToken ?? "", ...sources.flatMap((source) => credentialValues(source))]
  let queue: Promise<void> = Promise.resolve()
  const configured = async () => {
    const response = await client.config.get(request, options())
    if (!response.data) throw new Error("Management configuration unavailable")
    return response.data
  }
  const validateRemote = async (value: string) => {
    await egress(value)
    const [settings, providers] = await Promise.all([configured(), client.provider.list(request, options())])
    assertManagementUrlSecretFree(value, knownSecrets(settings, providers.data))
  }
  const writeConfig = async (patch: Config, guard: () => void) => {
    guard()
    const response = await client.config.update({ ...request, config: patch }, options())
    if (!response.data) throw new Error("Management update unavailable")
    const effective = await configured()
    guard()
    for (const [field, expected] of Object.entries(patch)) {
      const actual = effective[field as keyof Config]
      if (field === "mcp") {
        for (const [name, change] of Object.entries(patch.mcp ?? {})) for (const [key, value] of Object.entries(change)) {
          const entry = effective.mcp?.[name]
          if (!entry || (entry as Record<string, unknown>)[key] !== value) throw new Error("Config write was not effective")
        }
      } else if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Config write was not effective")
    }
  }
  const disableConfig = async (name: string, guard: () => void) => {
    try { await writeConfig({ mcp: { [name]: { enabled: false } } }, guard) }
    catch (error) { if (error instanceof SecurityError) throw error; guard() /* Runtime-only fallback; never claim persistence. */ }
  }
  return {
    async validateProposal(input: ManagementMutation) {
      if (input.type === "skill.url.add") await validateRemote(input.url)
      if (input.type.startsWith("skill.") || input.type.startsWith("plugin.")) throw new Error("Configuration is read-only in this OpenCode version")
      if (input.type === "mcp.remote.add") await validateRemote(input.url)
      if (input.type === "mcp.connect") {
        const entry = runtimeSources.get(input.name) ?? (await configured()).mcp?.[input.name]
        if (!entry || !("type" in entry) || entry.type !== "remote") throw new Error("Only configured remote MCP connections are supported")
        await validateRemote(entry.url)
      }
    },
    async load(): Promise<ManagementCatalog> {
      try {
        const [settings, skills, statuses, providers, auth] = await Promise.all([
          configured(), client.app.skills(request, options()), client.mcp.status(request, options()),
          client.provider.list(request, options()), client.provider.auth(request, options()),
        ])
        if (!skills.data || !statuses.data || !providers.data || !auth.data) throw new Error("Management catalog unavailable")
        const secrets = knownSecrets(settings, providers.data.all)
        const text = (value: string, length: number) => redactText(value, secrets)
          .replace(/(^|\s)(?:[A-Za-z]:[\\/]|\/)[^\s]+/g, "$1[PATH]").slice(0, length)
        const connections = new Set(providers.data.connected)
        const normalizedProviders = providers.data.all.slice(0, 100).map((provider) => ({
          id: text(provider.id, 64), name: text(provider.name, 100), connected: connections.has(provider.id),
          methods: (auth.data![provider.id] ?? []).filter((method) => method.type === "api" || method.type === "oauth").slice(0, 20).map((method) => ({ type: method.type, label: text(method.label, 100), supported: method.type === "api" })),
        }))
        const mcpServers = [...new Set([...Object.keys(settings.mcp ?? {}), ...Object.keys(statuses.data), ...runtimeSources.keys()])].slice(0, 100).map((name) => {
          const entry = runtimeSources.get(name) ?? settings.mcp?.[name]
          const status = statuses.data![name]?.status
          return { name: text(name, 64), status: status && ["connected", "disabled", "failed", "needs_auth", "needs_client_registration"].includes(status) ? status : "disabled", enabled: entry ? entry.enabled !== false : status !== "disabled",
            configType: entry && "type" in entry && (entry.type === "remote" || entry.type === "local") ? entry.type : entry?.enabled === false ? "disabled" as const : "unknown" as const }
        })
        const plugins = (settings.plugin ?? []).slice(0, 100).map((plugin) => {
          const pkg = safePackage(Array.isArray(plugin) ? plugin[0] : plugin)
          return pkg ? { name: pkg.replace(/@\d+\.\d+\.\d+.*$/, ""), package: pkg, source: "package" as const } : { name: "Local plugin", source: "local" as const }
        })
        return {
          mutability: {
            skills: { status: "read-only", reason: "Effective SDK project configuration writes are unverified in this OpenCode version; writes are disabled." },
            plugins: { status: "read-only", reason: "Effective SDK project configuration writes are unverified in this OpenCode version; writes are disabled." },
            mcp: { status: "runtime-only", reason: "Official MCP runtime APIs only; add/activation requires the exact host allowlist. Disable/remove is a runtime disconnect when project config cannot persist." },
            providers: { status: "available", reason: "Official server-side auth.set/auth.remove; OAuth callback is unsupported." },
          },
          skills: skills.data.slice(0, 500).map((skill) => {
            const location = skill.location
            const path = relative(resolve(config.openCodeDirectory), resolve(location))
            const project = isAbsolute(location) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path)
            const global = /[\\/](?:\.config[\\/]opencode|\.opencode|\.agents)[\\/]skills?[\\/]/.test(location)
            const remote = Boolean(safeUrl(location, secrets))
            return { name: text(skill.name, 100), ...(skill.description ? { description: text(skill.description, 500) } : {}),
              source: project ? "project" : global ? "global" : remote ? "remote" : "unknown", scope: project ? "project" : global ? "global" : "unknown" }
          }),
          skillSources: (settings.skills?.urls ?? []).flatMap((value) => { const url = safeUrl(value, secrets); return url ? [{ url }] : [] }).slice(0, 100),
          mcpServers, plugins, providers: normalizedProviders,
          integrations: [
            ...normalizedProviders.map((provider) => ({ id: provider.id, kind: "provider" as const, name: provider.name, connected: provider.connected, methods: provider.methods.map((method) => method.type) })),
            ...mcpServers.map((server) => ({ id: server.name, kind: "mcp" as const, name: server.name, connected: server.status === "connected", methods: server.status === "needs_auth" ? ["oauth" as const] : [] })),
            ...plugins.map((plugin, index) => ({ id: plugin.package ?? `local-${index}`, kind: "plugin" as const, name: plugin.name, connected: true, methods: [] })),
          ],
        }
      } catch { throw new Error("OpenCode management unavailable") }
    },
    async execute(input: ManagementMutation, guard: () => void, credential?: string): Promise<void> {
      const mutation = normalizeManagementMutation(input)
      // Serialize array read/modify/write operations and revalidate after waiting.
      const preceding = queue
      let release!: () => void
      queue = new Promise<void>((resolve) => { release = resolve })
      await preceding
      try {
        writeGuard = guard
        guard()
        if (mutation.type.startsWith("skill.") || mutation.type.startsWith("plugin.")) throw new Error("Configuration is read-only in this OpenCode version")
        if (mutation.type === "provider.key.connect" || mutation.type === "provider.credential.remove") {
          const [providers, methods] = await Promise.all([client.provider.list(request, options()), client.provider.auth(request, options())])
          if (!providers.data?.all.some((item) => item.id === mutation.providerId)) throw new Error("Provider unavailable")
          if (mutation.type === "provider.key.connect") {
            if (!credential || !methods.data?.[mutation.providerId]?.some((method) => method.type === "api")) throw new Error("API credential method unavailable")
            guard()
            const result = await client.auth.set({ providerID: mutation.providerId, auth: { type: "api", key: credential } }, options())
            if (result.data !== true) throw new Error("Credential update unavailable")
          } else {
            guard()
            const result = await client.auth.remove({ providerID: mutation.providerId }, options())
            if (result.data !== true) throw new Error("Credential removal unavailable")
          }
          return
        }
        const settings = await configured()
        if (mutation.type === "skill.url.add" || mutation.type === "skill.url.remove") {
          const urls = settings.skills?.urls ?? []
          await writeConfig({ skills: { urls: mutation.type === "skill.url.add" ? [...new Set([...urls, mutation.url])] : urls.filter((url) => url !== mutation.url) } }, guard)
        } else if (mutation.type === "plugin.add" || mutation.type === "plugin.remove") {
          const plugins = settings.plugin ?? []
          const matches = (plugin: typeof plugins[number]) => (Array.isArray(plugin) ? plugin[0] : plugin) === mutation.package
          await writeConfig({ plugin: mutation.type === "plugin.add" ? plugins.some(matches) ? plugins : [...plugins, mutation.package] : plugins.filter((plugin) => !matches(plugin)) }, guard)
        } else if (mutation.type === "mcp.remote.add") {
          if (Object.hasOwn(settings.mcp ?? {}, mutation.name)) throw new Error("MCP already configured")
          // Installation does not activate/trust the new server. Connect is a
          // separate, explicitly approved capability boundary.
          await validateRemote(mutation.url); guard()
          const result = await client.mcp.add({ ...request, name: mutation.name, config: { type: "remote", url: mutation.url, enabled: false } }, options())
          if (result.data?.[mutation.name]?.status !== "disabled") throw new Error("Runtime MCP add was not effective")
          runtimeSources.set(mutation.name, { type: "remote", url: mutation.url, enabled: false })
        } else if ("name" in mutation) {
          const entry = runtimeSources.get(mutation.name) ?? settings.mcp?.[mutation.name]
          const runtime = await client.mcp.status(request, options())
          if (!entry && !runtime.data?.[mutation.name]) throw new Error("MCP unavailable")
          if (mutation.type === "mcp.disable" || mutation.type === "mcp.remove") {
            // The official config endpoint merges maps: a persistent disabled
            // entry removes it from the active configuration without losing secrets.
            if (settings.mcp?.[mutation.name]) await disableConfig(mutation.name, guard)
            guard()
            const result = await client.mcp.disconnect({ ...request, name: mutation.name }, options())
            if (result.data !== true) throw new Error("MCP disconnection unavailable")
            const status = await client.mcp.status(request, options())
            if (status.data?.[mutation.name]?.status !== "disabled") throw new Error("Runtime MCP disable was not effective")
            const runtimeEntry = runtimeSources.get(mutation.name)
            if (runtimeEntry) runtimeEntry.enabled = false
          } else if (mutation.type === "mcp.connect") {
            if (!entry || !("type" in entry) || entry.type !== "remote") throw new Error("Only remote MCP connections are supported")
            await validateRemote(entry.url)
            guard()
            const runtimeEntry = runtimeSources.get(mutation.name)
            if (runtimeEntry) {
              const result = await client.mcp.add({ ...request, name: mutation.name, config: { ...runtimeEntry, enabled: true } }, options())
              if (result.data?.[mutation.name]?.status !== "connected") throw new Error("Runtime MCP connection unavailable")
              runtimeEntry.enabled = true
            } else {
              const result = await client.mcp.connect({ ...request, name: mutation.name }, options())
              if (result.data !== true) throw new Error("MCP connection unavailable")
            }
            const status = await client.mcp.status(request, options())
            if (status.data?.[mutation.name]?.status !== "connected") throw new Error("Runtime MCP connection was not effective")
          } else {
            guard()
            const result = await client.mcp.disconnect({ ...request, name: mutation.name }, options())
            if (result.data !== true) throw new Error("MCP disconnection unavailable")
          }
        } else throw new Error("Unsupported mutation")
      } catch (error) {
        if (error instanceof SecurityError) throw error
        throw new Error("OpenCode management write unavailable")
      } finally { writeGuard = undefined; release() }
    },
  }
}

/** Single-use credentials are bound to the pending action and its actor. */
export class ManagementActions {
  readonly #credentials = new Map<string, { actor: SecurityActor & { sessionHash: string }; key: Buffer; expiresAt: number; timer: ReturnType<typeof setTimeout> }>()
  constructor(readonly store: BridgeStore, readonly adapter: ReturnType<typeof createOpenCodeManagement>, readonly clock = () => Math.floor(Date.now() / 1000)) {}

  discard(actionId: string) {
    const entry = this.#credentials.get(actionId)
    if (entry) { clearTimeout(entry.timer); entry.key.fill(0); this.#credentials.delete(actionId) }
  }

  close() { for (const actionId of this.#credentials.keys()) this.discard(actionId) }

  async propose(actor: SecurityActor & { sessionHash: string }, input: unknown, guard: () => void) {
    const mutation = normalizeManagementMutation(input)
    const supplied = (input as Record<string, unknown>).key
    if (mutation.type === "provider.key.connect" && (typeof supplied !== "string" || supplied.length < 1 || supplied.length > 4096 || /[\x00-\x1f\x7f]/.test(supplied) || supplied.trim() !== supplied)) throw new Error("Invalid credential")
    guard()
    await this.adapter.validateProposal(mutation)
    guard()
    if (decide(mutation.type) !== "ASK") throw new Error("Policy denied")
    const actionId = this.store.createPendingManagement(actor, mutation, actor.sessionHash, this.clock())
    if (mutation.type === "provider.key.connect") {
      const timer = setTimeout(() => this.discard(actionId), 300_000); timer.unref()
      this.#credentials.set(actionId, { actor: { ...actor }, key: Buffer.from(supplied as string), expiresAt: this.clock() + 300, timer })
    }
    return { actionId, decision: "ASK" as const, summary: mutation }
  }

  async execute(actionId: string, actor: SecurityActor & { sessionHash: string }, mutation: ManagementMutation, guard: () => void) {
    try {
      guard()
      if (mutation.type === "provider.key.connect") {
        const entry = this.#credentials.get(actionId)
        if (!entry || entry.expiresAt <= this.clock() || entry.actor.userId !== actor.userId || entry.actor.deviceId !== actor.deviceId || entry.actor.sessionHash !== actor.sessionHash) throw new Error("Credential unavailable; create a new proposal")
        // Take the value once; expired/restarted/denied actions cannot reconstruct it.
        const credential = entry.key.toString("utf8")
        this.discard(actionId)
        await this.adapter.execute(mutation, () => { if (entry.expiresAt <= this.clock()) throw new Error("Credential expired"); guard() }, credential)
      } else await this.adapter.execute(mutation, guard)
      this.store.recordSecurityEvent(actor, `${mutation.type}.executed`, "executed", "trusted-device", undefined, this.clock())
    } catch (error) {
      this.store.recordSecurityEvent(actor, `${mutation.type}.executed`, "failed", "trusted-device", "management-unavailable", this.clock())
      throw error
    } finally { this.discard(actionId) }
  }
}
