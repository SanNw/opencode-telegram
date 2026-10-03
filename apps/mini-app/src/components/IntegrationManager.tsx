import { t } from "../i18n.js"
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { controlErrorMessage, controlRequest, type ControlContext, type Proposal } from "../control-api.js"
import { ActionApproval } from "./ActionApproval.js"
type Mutability = { status: string; reason: string }
export function ProviderCredentialForm({ providerId, name, busy, onSubmit, onCancel }: { providerId: string; name: string; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  return <form key={providerId} className="control-form mt" onSubmit={onSubmit}>
    <label htmlFor="provider-key">API key for {name}</label>
    <input id="provider-key" name="providerKey" className="input" type="password" autoFocus autoComplete="off" spellCheck={false} required maxLength={16384} />
    <div className="control-actions"><button className="btn" type="button" onClick={onCancel}>{t("Cancel")}</button><button className="btn primary" type="submit" disabled={busy}>{t("Review connection")}</button></div>
  </form>
}
type ManagementCatalog = {
  mutability: { skills: Mutability; plugins: Mutability; mcp: Mutability; providers: Mutability }
  skills: Array<{ name: string; description?: string; source: string; scope: string }>
  skillSources: Array<{ url: string }>
  plugins: Array<{ name: string; package?: string; source: string }>
  mcpServers: Array<{ name: string; status: string; enabled: boolean; configType: string }>
  providers: Array<{ id: string; name: string; connected: boolean; methods: Array<{ type: string; label: string; supported: boolean }> }>
}
export function IntegrationManager({ context }: { context: ControlContext }) {
  const [catalog, setCatalog] = useState<ManagementCatalog>(), [error, setError] = useState(""), [result, setResult] = useState(""), [busy, setBusy] = useState(false), [proposal, setProposal] = useState<Proposal>(), [provider, setProvider] = useState<string>(), [addingMcp, setAddingMcp] = useState(false)
  const load = useCallback(async () => { setCatalog(await controlRequest<ManagementCatalog>("/api/v1/opencode/management", context)) }, [context])
  useEffect(() => { void load().catch((failure) => setError(controlErrorMessage(failure))) }, [load])
  const propose = async (path: string, body: unknown, summary: string) => {
    setBusy(true); setError(""); setResult("")
    try { const response = await controlRequest<{ actionId: string; expiresAt?: number }>(path, context, body); setProposal({ ...response, summary }) }
    catch (failure) { setError(controlErrorMessage(failure)) } finally { setBusy(false) }
  }
  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget, key = String(new FormData(form).get("providerKey") ?? "")
    // Clear the password element before awaiting even a failed proposal; no React secret state.
    form.reset(); setProvider(undefined)
    void propose(`/api/v1/opencode/providers/${encodeURIComponent(provider!)}/actions`, { operation: "connect", key }, `Connect API credentials for ${catalog?.providers.find(({ id }) => id === provider)?.name ?? provider}. The credential remains server-side and is never shown in this approval.`)
  }
  const addMcp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget, data = new FormData(form), name = String(data.get("name")), url = String(data.get("url"))
    form.reset(); setAddingMcp(false)
    void propose("/api/v1/opencode/mcp/actions", { operation: "add", name, url }, `Add remote MCP ${name} at ${url}. Runtime only. The host must be allowlisted; new tools are not automatically trusted.`)
  }
  const finish = (decision: "approve" | "deny") => {
    setProposal(undefined); setResult(decision === "approve" ? "Approved action completed. Catalog refreshed from OpenCode." : "Action denied.")
    void load().catch((failure) => setError(controlErrorMessage(failure)))
  }
  return <div className="control-surface integration-manager">
    <div className="control-actions mb"><button className="btn" type="button" disabled={busy} onClick={() => { setError(""); void load().catch((failure) => setError(controlErrorMessage(failure))) }}>{t("Refresh integrations")}</button></div>
    {error && <p className="conversation-error" role="alert">{error}</p>}{result && <p className="small" role="status">{result}</p>}{!catalog && !error && <p className="loading" role="status">{t("Loading OpenCode integrations…")}</p>}
    {catalog && <>
      <div className="card mb"><strong>{t("Providers")}</strong><p className="tiny muted">{catalog.mutability.providers.reason}</p>{catalog.providers.length === 0 && <p className="small muted">{t("No providers reported by OpenCode.")}</p>}<div className="management-list">{catalog.providers.map((item) => <div className="row management-row" key={item.id}><div className="grow"><strong>{item.name}</strong><div className="tiny muted">{item.connected ? t("Connected") : t("Available")} · {item.methods.map(({ label }) => label).join(", ") || "No supported connection method"}</div>{item.methods.some(({ type }) => type === "oauth") && <div className="tiny muted">{t("OAuth callback is unavailable here.")}</div>}</div><div className="control-actions">{item.methods.some(({ type, supported }) => type === "api" && supported) && <button className="btn" type="button" disabled={busy || Boolean(proposal)} onClick={() => setProvider(item.id)}>{item.connected ? t("Replace key") : t("Connect")}</button>}{item.connected && <button className="btn danger" type="button" disabled={busy || Boolean(proposal)} onClick={() => void propose(`/api/v1/opencode/providers/${encodeURIComponent(item.id)}/actions`, { operation: "remove" }, `Remove server-side credentials for ${item.name}. Existing model connections may become unavailable.`)}>{t("Remove key")}</button>}</div></div>)}</div>{provider && <ProviderCredentialForm key={provider} providerId={provider} name={catalog.providers.find(({ id }) => id === provider)?.name ?? provider} busy={busy} onSubmit={connect} onCancel={() => setProvider(undefined)} />}</div>
      <section className="card mb mcp-panel" aria-labelledby="mcp-panel-title">
        <div className="mcp-panel__heading"><strong id="mcp-panel-title">{t("MCP servers")}</strong><span className="pill">{t("Runtime only")}</span></div>
        <p className="tiny muted">{catalog.mutability.mcp.reason}</p>
        {catalog.mcpServers.length === 0 && <p className="small muted">{t("No MCP servers configured.")}</p>}
        <div className="mcp-server-list">{catalog.mcpServers.map((server) => <article className="mcp-server" key={server.name}>
          <div className="mcp-server__heading"><strong>{server.name}</strong><span className="pill">{server.status.replaceAll("_", " ")}</span></div>
          <div className="tiny muted">{server.configType} · {server.enabled ? t("Enabled") : t("Disabled")}</div>
          {server.status === "needs_auth" && <p className="tiny muted">{t("Authenticate on the OpenCode host.")}</p>}
          <div className="control-actions">{server.configType === "remote" && server.status !== "connected" && <button className="btn" type="button" disabled={busy || Boolean(proposal)} onClick={() => void propose("/api/v1/opencode/mcp/actions", { operation: "connect", name: server.name }, `Connect remote MCP ${server.name}. Runtime only; allowlisted capabilities still require review.`)}>{t("Connect")}</button>}{(["disconnect", "disable", "remove"] as const).map((operation) => <button className="btn" type="button" key={operation} disabled={busy || Boolean(proposal) || (operation === "disconnect" && server.status !== "connected")} onClick={() => void propose("/api/v1/opencode/mcp/actions", { operation, name: server.name }, `${operation} MCP ${server.name}. This disconnects the runtime and does not guarantee persistent configuration removal.`)}>{operation.charAt(0).toUpperCase() + operation.slice(1)}</button>)}</div>
        </article>)}</div>
        <button className="btn mt" type="button" disabled={busy || Boolean(proposal)} onClick={() => setAddingMcp((value) => !value)}>{addingMcp ? t("Cancel") : t("Add remote MCP")}</button>
        {addingMcp && <form className="control-form mt" onSubmit={addMcp}><label htmlFor="mcp-name">{t("Server name")}</label><input id="mcp-name" className="input" name="name" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}" required maxLength={64} /><label htmlFor="mcp-url">{t("Public HTTPS URL (no credentials)")}</label><input id="mcp-url" name="url" className="input" type="url" required maxLength={2048} placeholder="https://mcp.example.com/" /><p className="tiny muted">{t("Only exact hosts configured by the Bridge administrator can connect. Tools are not automatically trusted.")}</p><button className="btn primary" type="submit">{t("Review MCP capabilities")}</button></form>}
      </section>
      <div className="card mb"><strong>{t("Skills")}</strong><p className="tiny muted">Read-only · {catalog.mutability.skills.reason}</p>{catalog.skills.length === 0 && <p className="small muted">{t("No skills reported by OpenCode.")}</p>}<div className="management-list">{catalog.skills.map((skill, index) => <div className="row" key={`${skill.name}-${index}`}><div className="grow"><strong>{skill.name}</strong><div className="tiny muted">{skill.scope} scope · {skill.source} source</div>{skill.description && <p className="small muted">{skill.description}</p>}</div></div>)}</div>{catalog.skillSources.map(({ url }) => <p className="tiny muted" key={url}>{url}</p>)}</div>
      <div className="card"><strong>{t("Plugins")}</strong><p className="tiny muted">Read-only · {catalog.mutability.plugins.reason}</p>{catalog.plugins.length === 0 && <p className="small muted">{t("No plugins configured.")}</p>}{catalog.plugins.map((plugin, index) => <div className="row" key={`${plugin.name}-${index}`}><div className="grow"><strong>{plugin.name}</strong><div className="tiny muted">{plugin.package ?? plugin.source}</div></div><span className="pill">{t("Configured")}</span></div>)}</div>
    </>}
    {proposal && <ActionApproval proposal={proposal} context={context} onDone={finish} onDismiss={() => { setProposal(undefined); setResult("Proposal dismissed. No approval or denial was sent to the Bridge.") }} />}
  </div>
}
