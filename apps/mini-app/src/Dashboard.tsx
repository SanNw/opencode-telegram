import { t, tf, stateLabel } from "./i18n.js"
import { AppearanceSettings } from "./components/AppearanceSettings.js"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Conversation, type ConversationEvent } from "./Conversation.js";
import { Icon, StorageBrowser } from "./components/index.js";
import { UsagePanel } from "./components/UsagePanel.js";
import { CachePanel } from "./components/CachePanel.js";
import { SecurityCenter } from "./components/SecurityCenter.js";
import { IntegrationManager } from "./components/IntegrationManager.js";
import { ArtifactGallery } from "./components/ArtifactGallery.js";
import { GitPanel } from "./components/GitPanel.js";
import { proposeSessionDeletion, decideSessionDeletion, controlErrorMessage } from "./control-api.js";

export type Session = {
  id: string;
  projectId: string;
  parentId?: string;
  title: string;
  directory: string;
  agent?: string;
  model?: { id: string; providerId: string; variant?: string };
  updatedAt: number;
  cost?: number;
  tokens?: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  summary?: { additions: number; deletions: number; files: number };
};
type Snapshot = {
  statuses?: Record<string, "idle" | "busy" | "retry">;
  online: true;
  version: string;
  syncedAt: string;
  projects: Array<{
    id: string;
    name?: string;
    worktree: string;
    updatedAt: number;
  }>;
  sessions: Session[];
};
type Page = "home" | "projects" | "agents" | "settings" | "conversation";
type SettingsTab = "integrations" | "ai" | "security" | "storage";
type Device = {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
};
type AuditEvent = {
  id: number;
  createdAt: number;
  event: string;
  outcome: string;
};
type Capability = {
  status: "available" | "disabled" | "unsupported";
  reason?: string;
};
type Capabilities = {
  version: number;
  capabilities: Record<string, Capability>;
};
type ProviderCatalog = {
  providers: Array<{
    id: string;
    name: string;
    connected: boolean;
    defaultModelId?: string;
    models: Array<{
      id: string;
      name: string;
      status: string;
      limits: { context: number; output: number };
      variants: string[];
    }>;
  }>;
  skills?: Array<{ name: string; description?: string }>;
  mcpServers?: Array<{
    name: string;
    status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration";
  }>;
  plugins?: Array<{ name: string }>;
};
type AgentCatalog = {
  agents: Array<{
    name: string;
    description?: string;
    mode: "subagent" | "primary" | "all";
    color?: string;
    native: boolean;
    model?: { id: string; providerId: string };
    variant?: string;
  }>;
};
type VcsState = {
  branch?: string;
  defaultBranch?: string;
  files: Array<{ file: string; additions: number; deletions: number; status: string }>;
};

function Navigation({
  page,
  onChange,
  className,
}: {
  page: Page;
  onChange: (page: Page) => void;
  className: string;
}) {
  const current = page === "conversation" ? "home" : page;
  const items = [
    ["home", t("Home")],
    ["projects", t("Projects")],
    ["agents", t("Agents")],
    ["settings", t("Settings")],
  ] as const;
  return (
    <nav className={className} aria-label={t("Main navigation")}>
      {items.map(([target, label]) => <button
        type="button"
        className={current === target ? "active" : ""}
        aria-current={current === target ? "page" : undefined}
        aria-label={label}
        title={label}
        onClick={() => onChange(target)}
        key={target}
      >
        <span className="nav-icon"><Icon name={target} /></span>
        <small>{label}</small>
      </button>)}
    </nav>
  );
}

const projectName = (project: Snapshot["projects"][number]) =>
  project.name ??
  project.worktree.split(/[\\/]/).filter(Boolean).at(-1) ??
  "Project";
export const sessionsForProject = (sessions: Session[], projectId: string) =>
  sessions.filter((session) => session.projectId === projectId);
function formatSessionTime(timestamp: number) {
  const date = new Date(timestamp),
    now = new Date();
  return date.toDateString() === now.toDateString()
    ? new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(date)
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(date);
}

export function Dashboard({ onUnauthorized, onLocked }: { onUnauthorized: () => void; onLocked: (telegramCompromised: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [capabilities, setCapabilities] = useState<Capabilities>(),
    [catalog, setCatalog] = useState<ProviderCatalog>(),
    [agentCatalog, setAgentCatalog] = useState<AgentCatalog>();
  const [capabilityStatus, setCapabilityStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [catalogStatus, setCatalogStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [online, setOnline] = useState(false);
  const [vcs, setVcs] = useState<VcsState>();
  const loadingSnapshot = useRef(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<Session>();
  const [conversationEvent, setConversationEvent] =
    useState<ConversationEvent>();
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [page, setPage] = useState<Page>("home");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("integrations");
  const [stepUpRequested, setStepUpRequested] = useState(false);
  const [privilegedExpiresAt, setPrivilegedExpiresAt] = useState<number>();
  const [projectTab, setProjectTab] = useState<"overview" | "git" | "artifacts">("overview");
  const requireStepUp = useCallback(() => {
    setPage("settings"); setSettingsTab("security"); setStepUpRequested(true);
  }, []);
  const controlContext = useMemo(() => ({ onUnauthorized, onStepUp: requireStepUp }), [onUnauthorized, requireStepUp]);
  const [devices, setDevices] = useState<Device[]>(),
    [auditEvents, setAuditEvents] = useState<AuditEvent[]>();
  const [deviceError, setDeviceError] = useState(""),
    [revokeTarget, setRevokeTarget] = useState<Device>(),
    [revoking, setRevoking] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<
    Record<string, "idle" | "busy" | "retry">
  >({});
  const [newSessionOpen, setNewSessionOpen] = useState(false),
    [newSessionTitle, setNewSessionTitle] = useState(""),
    [newSessionAgent, setNewSessionAgent] = useState("");
  const [selectedAgentName, setSelectedAgentName] = useState(""),
    [conversationAgent, setConversationAgent] = useState<string>();
  const [createProposal, setCreateProposal] = useState<{
    actionId: string;
    title?: string;
    agent?: string;
  }>();
  const [deleteTarget, setDeleteTarget] = useState<Session>(),
    [deleteProposal, setDeleteProposal] = useState<{
      actionId: string;
      session: Session;
    }>();
  const [acting, setActing] = useState(false),
    [actionError, setActionError] = useState("");

  const load = useCallback(async () => {
    if (loadingSnapshot.current) return;
    loadingSnapshot.current = true;
    try {
    const [response, capabilityResponse, catalogResponse, agentResponse] = await Promise.all([
      fetch("/api/v1/opencode/snapshot", { credentials: "include" }),
      fetch("/api/v1/capabilities", { credentials: "include" }),
      fetch("/api/v1/opencode/catalog", { credentials: "include" }),
      fetch("/api/v1/opencode/agents", { credentials: "include" }),
    ]);
    if (
      response.status === 401 ||
      capabilityResponse.status === 401 ||
      catalogResponse.status === 401 ||
      agentResponse.status === 401
    )
      return onUnauthorized();
    if (!response.ok) throw new Error("snapshot-unavailable");
    const fresh = (await response.json()) as Snapshot;
    setSnapshot(fresh);
    setSessionStatus(fresh.statuses ?? {});
    setSelected((current) => current ? fresh.sessions.find(({ id }) => id === current.id) : undefined);
    if (capabilityResponse.ok) {
      setCapabilities((await capabilityResponse.json()) as Capabilities);
      setCapabilityStatus("ready");
    } else {
      setCapabilities(undefined);
      setCapabilityStatus("error");
    }
    if (catalogResponse.ok) {
      setCatalog((await catalogResponse.json()) as ProviderCatalog);
      setCatalogStatus("ready");
    } else {
      setCatalog(undefined);
      setCatalogStatus("error");
    }
    setAgentCatalog(agentResponse.ok ? await agentResponse.json() as AgentCatalog : undefined);
    void fetch("/api/v1/opencode/vcs", { credentials: "include" })
      .then(async (vcsResponse) => {
        if (vcsResponse.status === 401) return onUnauthorized();
        setVcs(vcsResponse.ok ? await vcsResponse.json() as VcsState : undefined);
      })
      .catch(() => setVcs(undefined));
    setOnline(true);
    setError(false);
    } catch (error) {
      setOnline(false);
      throw error;
    } finally {
      loadingSnapshot.current = false;
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load().catch(() => setError(true));
    const events = new EventSource("/api/v1/opencode/events", {
      withCredentials: true,
    });
    const listen = (
      type: string,
      handler: (event: MessageEvent<string>) => void,
    ) => events.addEventListener(type, handler as EventListener);
    listen("system.online", () => {
      setOnline(true);
      setConnectionEpoch((value) => value + 1);
      void load().catch(() => setError(true));
    });
    listen("system.offline", () => setOnline(false));
    listen("session.updated", (event) => {
      const session = (JSON.parse(event.data) as { session: Session }).session;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              sessions: [
                session,
                ...current.sessions.filter(({ id }) => id !== session.id),
              ],
            }
          : current,
      );
      setSelected((current) =>
        current?.id === session.id ? session : current,
      );
    });
    listen("session.deleted", (event) => {
      const id = (JSON.parse(event.data) as { sessionId: string }).sessionId;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              sessions: current.sessions.filter((session) => session.id !== id),
            }
          : current,
      );
      setSelected((current) => {
        if (current?.id !== id) return current;
        setPage("home");
        return undefined;
      });
    });
    for (const type of [
      "message.started",
      "message.text",
      "message.delta",
      "message.file",
      "tool.updated",
      "session.diff",
      "file.edited",
      "session.status",
      "session.idle",
      "session.error",
      "permission.requested",
      "permission.resolved",
    ])
      listen(type, (event) => {
        try {
          const normalized = {
            ...(JSON.parse(event.data) as Omit<ConversationEvent, "sequence">),
            sequence: Date.now() + Math.random(),
          } as ConversationEvent;
          setConversationEvent(normalized);
          if (
            normalized.type === "session.status" &&
            (normalized.status === "idle" ||
              normalized.status === "busy" ||
              normalized.status === "retry")
          )
            setSessionStatus((current) => ({
              ...current,
              [normalized.sessionId]: normalized.status as
                | "idle"
                | "busy"
                | "retry",
            }));
          if (normalized.type === "session.idle")
            setSessionStatus((current) => ({
              ...current,
              [normalized.sessionId]: "idle",
            }));
        } catch {
          /* reconnect hydration repairs malformed events */
        }
      });
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load().then(() => setConnectionEpoch((value) => value + 1)).catch(() => setError(true));
    };
    // EventSource cannot expose a 401. A bounded probe detects expired sessions
    // even when no OpenCode event is emitted after reconnecting.
    events.onerror = () => { setOnline(false); refresh(); };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      events.close();
      window.clearInterval(timer);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const loadSettings = useCallback(async () => {
    const [devicesResponse, auditResponse] = await Promise.all([
      fetch("/api/v1/devices", { credentials: "include" }),
      fetch("/api/v1/audit", { credentials: "include" }),
    ]);
    if (devicesResponse.status === 401 || auditResponse.status === 401)
      return onUnauthorized();
    if (!devicesResponse.ok || !auditResponse.ok)
      throw new Error("settings-unavailable");
    setDevices(
      ((await devicesResponse.json()) as { devices: Device[] }).devices,
    );
    setAuditEvents(
      ((await auditResponse.json()) as { events: AuditEvent[] }).events,
    );
    setDeviceError("");
  }, [onUnauthorized]);
  useEffect(() => {
    if (!devices)
      void loadSettings().catch(() =>
        setDeviceError(t("Security settings are unavailable.")),
      );
  }, [devices, loadSettings]);

  const openPage = (next: Page) => {
    setPage(next);
    if (next !== "conversation") setSelected(undefined);
    setDrawerOpen(false);
  };
  const openSession = (session: Session, agent?: string) => {
    setConversationAgent(agent);
    setSelected(session);
    setPage("conversation");
    setDrawerOpen(false);
  };
  const visibleSessions = useMemo(() => {
    const query = sessionSearch.trim().toLocaleLowerCase();
    return (snapshot?.sessions ?? []).filter(
      ({ title }) => !query || title.toLocaleLowerCase().includes(query),
    );
  }, [sessionSearch, snapshot?.sessions]);
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const todaySessions = visibleSessions.filter(
    ({ updatedAt }) => updatedAt >= todayStart,
  );
  const earlierSessions = visibleSessions.filter(
    ({ updatedAt }) => updatedAt < todayStart,
  );
  const drawerSessions = (sessions: Session[]) =>
    sessions.map((session) => (
      <div
        className={`drawer-session ${selected?.id === session.id ? "active" : ""}`}
        key={session.id}
      >
        <button
          className="navbtn sessionItem"
          type="button"
          onClick={() => openSession(session)}
        >
          {sessionStatus[session.id] === "busy" ? <span className="dot" /> : <Icon name="projects" />}
          <span className="grow truncate">{session.title}</span>
          <small>{formatSessionTime(session.updatedAt)}</small>
        </button>
        <button
          className="session-delete"
          type="button"
          aria-label={tf("Delete {name}?", { name: session.title })}
          onClick={() => {
            setDrawerOpen(false);
            setDeleteTarget(session);
          }}
        >
          <Icon name="close" />
        </button>
      </div>
    ));

  const revokeDevice = async () => {
    if (!revokeTarget || revoking) return;
    setRevoking(true);
    setDeviceError("");
    try {
      const response = await fetch(
        `/api/v1/devices/${encodeURIComponent(revokeTarget.id)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (response.status === 401) return onUnauthorized();
      if (response.status === 403) { setRevokeTarget(undefined); requireStepUp(); throw new Error("step-up"); }
      if (!response.ok) throw new Error("revoke-failed");
      setDevices((current) =>
        current?.filter(({ id }) => id !== revokeTarget.id),
      );
      setRevokeTarget(undefined);
    } catch {
      setDeviceError(t("The device could not be revoked."));
    } finally {
      setRevoking(false);
    }
  };
  const proposeSession = async (event: FormEvent) => {
    event.preventDefault();
    if (acting) return;
    setActing(true);
    setActionError("");
    try {
      const title = newSessionTitle.trim(),
        response = await fetch("/api/v1/sessions/actions", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "session.create",
            ...(title ? { title } : {}),
          }),
        });
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error("proposal-failed");
      const body = (await response.json()) as { actionId: string };
      setCreateProposal({
        actionId: body.actionId,
        ...(title ? { title } : {}),
        ...(newSessionAgent ? { agent: newSessionAgent } : {}),
      });
    } catch {
      setActionError(t("The new session could not be proposed."));
    } finally {
      setActing(false);
    }
  };
  const decideSession = async (decision: "approve" | "deny") => {
    if (!createProposal || acting) return;
    setActing(true);
    setActionError("");
    try {
      const response = await fetch(
        `/api/v1/actions/${encodeURIComponent(createProposal.actionId)}/decision`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error("decision-failed");
      const body = (await response.json()) as { session?: Session };
      if (body.session) {
        setSnapshot((current) =>
          current
            ? { ...current, sessions: [body.session!, ...current.sessions] }
            : current,
        );
        openSession(body.session, createProposal.agent);
      }
      setCreateProposal(undefined);
      setNewSessionOpen(false);
      setNewSessionTitle("");
      setNewSessionAgent("");
    } catch {
      setActionError(t("The new session action is no longer available."));
    } finally {
      setActing(false);
    }
  };
  const proposeDelete = async () => {
    if (!deleteTarget || acting) return;
    setActing(true);
    setActionError("");
    try {
      const body = await proposeSessionDeletion(deleteTarget.id, { ...controlContext, onStepUp: () => { setDeleteTarget(undefined); requireStepUp() } });
      setDeleteProposal({ actionId: body.actionId, session: deleteTarget });
      setDeleteTarget(undefined);
    } catch (failure) {
      setActionError(controlErrorMessage(failure));
    } finally {
      setActing(false);
    }
  };
  const decideDelete = async (decision: "approve" | "deny") => {
    if (!deleteProposal || acting) return;
    setActing(true);
    setActionError("");
    try {
      await decideSessionDeletion(deleteProposal.actionId, decision, { ...controlContext, onStepUp: () => { setDeleteProposal(undefined); requireStepUp() } });
      if (decision === "approve") {
        const id = deleteProposal.session.id;
        setSnapshot((current) =>
          current
            ? {
                ...current,
                sessions: current.sessions.filter(
                  (session) => session.id !== id,
                ),
              }
            : current,
        );
        if (selected?.id === id) openPage("home");
      }
      setDeleteProposal(undefined);
    } catch (failure) {
      setActionError(controlErrorMessage(failure));
    } finally {
      setActing(false);
    }
  };

  const activeSessions = Object.values(sessionStatus).filter(
    (status) => status === "busy" || status === "retry",
  ).length;
  const workingSession = snapshot?.sessions.find(
    ({ id }) => sessionStatus[id] === "busy" || sessionStatus[id] === "retry",
  );
  const childSessions =
    snapshot?.sessions.filter(({ parentId }) => parentId) ?? [];
  const availableSubagents =
    agentCatalog?.agents.filter(({ mode }) => mode !== "primary") ?? [];
  const selectedAgent =
    agentCatalog?.agents.find(({ name }) => name === selectedAgentName) ??
    agentCatalog?.agents[0];
  const recentAudit = auditEvents?.slice(0, 3) ?? [];
  const sessionTokens =
    snapshot?.sessions.reduce(
      (total, session) =>
        total +
        (session.tokens?.total ??
          (session.tokens?.input ?? 0) +
            (session.tokens?.output ?? 0) +
            (session.tokens?.reasoning ?? 0)),
      0,
    ) ?? 0;
  const sessionCost =
    snapshot?.sessions.reduce(
      (total, session) => total + (session.cost ?? 0),
      0,
    ) ?? 0;
  const connectedProviders =
    catalog?.providers.filter(({ connected }) => connected) ?? [];
  const availableModels =
    connectedProviders.flatMap((provider) =>
      provider.models.map((model) => ({
        ...model,
        providerId: provider.id,
        providerName: provider.name,
      })),
    ) ?? [];
  const capabilityValue = (name: string, value: string) => {
    if (capabilityStatus === "loading") return t("Loading…");
    if (capabilityStatus === "error") return t("Error");
    const capability = capabilities?.capabilities[name];
    if (capability?.status === "available") return value;
    return capability?.status === "disabled" ? t("Disabled") : t("Unsupported");
  };
  const usageAvailable =
    capabilityStatus === "ready" &&
    capabilities?.capabilities.tokens?.status === "available";
  const usageState = capabilityValue("tokens", "");
  const catalogSummary =
    catalogStatus === "loading"
      ? t("Loading provider catalog…")
      : catalogStatus === "error"
        ? t("Provider catalog could not be loaded.")
        : tf("{providers} connected providers · {models} available models", { providers: connectedProviders.length, models: availableModels.length });

  return (
    <div className={`shell ${page === "conversation" ? "conversation-shell" : ""}`}>
      <header className="topbar">
        <button
          className="iconbtn"
          type="button"
          aria-label={t("Open sessions")}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Icon name="menu" />
        </button>
        <div className="brandmark">OC</div>
        <div className="grow truncate">
          <strong>OpenCode Telegram</strong>
          <div className="tiny muted">
            <span className={online ? "dot" : "dot offline"} /> OpenCode{" "}
            {online ? t("online") : t("offline")}
          </div>
        </div>
      </header>
      <button
        className={`overlay ${drawerOpen ? "open" : ""}`}
        type="button"
        aria-label={t("Close sessions")}
        onClick={() => setDrawerOpen(false)}
      />
      <aside
        className={`drawer ${drawerOpen ? "open" : ""}`}
        aria-hidden={!drawerOpen}
      >
        <div className="flex mb">
          <strong className="grow">{t("Sessions")}</strong>
          <button
            type="button"
            className="iconbtn"
            aria-label={t("Close sessions")}
            onClick={() => setDrawerOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <button
          className="btn primary wfull mb"
          type="button"
          onClick={() => {
            setDrawerOpen(false);
            setNewSessionAgent("");
            setNewSessionOpen(true);
          }}
        >
          <Icon name="plus" />{t("New session")}</button>
        <label className="sr-only" htmlFor="session-search">{t("Search sessions")}</label>
        <input
          id="session-search"
          className="input"
          value={sessionSearch}
          onChange={(event) => setSessionSearch(event.target.value)}
          placeholder={t("Search sessions")}
        />
        {visibleSessions.length === 0 && (
          <p className="empty compact">{t("No matching sessions.")}</p>
        )}
        {todaySessions.length > 0 && (
          <>
            <div className="sectionTitle muted">{t("TODAY")}</div>
            <div className="drawer-sessions">
              {drawerSessions(todaySessions)}
            </div>
          </>
        )}
        {earlierSessions.length > 0 && (
          <>
            <div className="sectionTitle muted">{t("EARLIER")}</div>
            <div className="drawer-sessions">
              {drawerSessions(earlierSessions)}
            </div>
          </>
        )}
      </aside>
      <div className="layout">
        <Navigation page={page} onChange={openPage} className="sidebar" />
        <main className={`main ${page === "conversation" ? "main--conversation" : ""}`}>
          {error && (
            <section className="notice" role="alert">
              <span>{t("OpenCode data is unavailable.")}</span>
              <button
                className="btn"
                type="button"
                onClick={() => void load().catch(() => setError(true))}
              >{t("Try again")}</button>
            </section>
          )}
          {actionError && (
            <p className="conversation-error" role="alert">
              {t(actionError)}
            </p>
          )}
          {!snapshot && !error && (
            <p className="loading" role="status">{t("Loading workspace…")}</p>
          )}
          {snapshot && page === "home" && (
            <section className="page active" key="home">
              <div className="flex between mb">
                <div className="grow">
                  <div className="heading">{t("Dashboard")}</div>
                  <div className="small muted">{t("Your OpenCode at a glance.")}</div>
                </div>
                <button
                  className="btn"
                  type="button"
                  disabled={!snapshot.sessions[0]}
                  onClick={() =>
                    (workingSession ?? snapshot.sessions[0]) &&
                    openSession(workingSession ?? snapshot.sessions[0]!)
                  }
                >
                  {workingSession ? t("Open working session") : t("Open latest session")}
                </button>
              </div>
              <div className="grid4">
                <div className="card">
                  <div className="tiny muted">{t("SESSIONS")}</div>
                  <div className="metric">{snapshot.sessions.length}</div>
                  <div className="tiny muted">{activeSessions} {t("working")}</div>
                </div>
                <div className="card">
                  <div className="tiny muted">{t("AGENTS")}</div>
                  <div className="metric">{availableSubagents.length}</div>
                  <div className="tiny muted">{t("available subagents")}</div>
                </div>
                <div className="card">
                  <div className="tiny muted">{t("SESSION TOKENS")}</div>
                  <div className="metric">
                    {capabilityValue("tokens", sessionTokens.toLocaleString())}
                  </div>
                  <div className="tiny muted">{t("reported by OpenCode")}</div>
                </div>
                <div className="card">
                  <div className="tiny muted">{t("SESSION COST")}</div>
                  <div className="metric">
                    {capabilityValue("costs", `$${sessionCost.toFixed(4)}`)}
                  </div>
                  <div className="tiny muted">{t("provider-reported total")}</div>
                </div>
              </div>
              <div className="mt"><UsagePanel onUnauthorized={onUnauthorized} /></div>
              <div className="sectionTitle">{t("Projects")}</div>
              <div className="grid2">
                {snapshot.projects.slice(0, 2).map((project) => {
                  const sessions = sessionsForProject(snapshot.sessions, project.id);
                  return (
                    <button
                      className="card project-switch"
                      type="button"
                      key={project.id}
                      onClick={() =>
                        sessions[0]
                          ? openSession(sessions[0])
                          : openPage("projects")
                      }
                    >
                      <div className="flex">
                        <strong className="grow">{projectName(project)}</strong>
                        <span className="pill">{sessions.length} {t("sessions")}</span>
                      </div>
                      <div className="small muted mt truncate">
                        {project.worktree}
                      </div>
                      <div className="flex between tiny muted mt">
                        <span>
                          {sessions[0]?.model?.id ?? t("OpenCode workspace")}
                        </span>
                        <span>
                          {
                            sessions.filter(
                              ({ id }) => sessionStatus[id] === "busy",
                            ).length
                          }{" "}
                          {t("active")}
                        </span>
                      </div>
                    </button>
                  );
                })}
                {snapshot.projects.length === 0 && (
                  <div className="card empty">{t("No projects are connected.")}</div>
                )}
              </div>
              <div className="grid2 mt">
                <div className="card">
                  <div className="flex between">
                    <strong>{t("Usage")}</strong>
                    <span className="tiny muted">{t("Current sessions")}</span>
                  </div>
                  {usageAvailable ? (
                    <div className="usage-values">
                      <div>
                        <span>{t("Input")}</span>
                        <strong>
                          {snapshot.sessions
                            .reduce(
                              (sum, item) => sum + (item.tokens?.input ?? 0),
                              0,
                            )
                            .toLocaleString()}
                        </strong>
                      </div>
                      <div>
                        <span>{t("Output")}</span>
                        <strong>
                          {snapshot.sessions
                            .reduce(
                              (sum, item) => sum + (item.tokens?.output ?? 0),
                              0,
                            )
                            .toLocaleString()}
                        </strong>
                      </div>
                      <div>
                        <span>{t("Reasoning")}</span>
                        <strong>
                          {snapshot.sessions
                            .reduce(
                              (sum, item) =>
                                sum + (item.tokens?.reasoning ?? 0),
                              0,
                            )
                            .toLocaleString()}
                        </strong>
                      </div>
                    </div>
                  ) : (
                    <p className="empty compact">{usageState}</p>
                  )}
                </div>
                <div className="card">
                  <strong>{t("Recent security activity")}</strong>
                  {recentAudit.length === 0 && (
                    <p className="empty compact">{t("No recent activity.")}</p>
                  )}
                  {recentAudit.map((item) => (
                    <div className="row" key={item.id}>
                      <Icon name="check" />
                      <div className="grow small">
                        {t(item.event.replaceAll(".", " "))}
                        <div className="tiny muted">
                          {stateLabel(item.outcome)} · {formatSessionTime(item.createdAt)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}
          {snapshot && page === "projects" && (
            <section className="page active" key="projects">
              <div className="heading">{t("Projects")}</div>
              <div className="small muted mb">{t("OpenCode workspaces available on this installation.")}</div>
              <div className="card project-rows">
                {snapshot.projects.length === 0 && (
                  <p className="empty compact">{t("No projects are connected.")}</p>
                )}
                {snapshot.projects.map((project) => {
                  const sessions = sessionsForProject(snapshot.sessions, project.id);
                  return (
                    <div className="row" key={project.id}>
                      <div className="brandmark">
                        {projectName(project).slice(0, 1).toUpperCase()}
                      </div>
                      <div className="grow truncate">
                        <strong>{projectName(project)}</strong>
                        <div className="tiny muted truncate">
                          {sessions.length} {t("sessions")} ·{" "}
                          {
                            sessions.filter(
                              ({ id }) => sessionStatus[id] === "busy",
                            ).length
                          }{" "}
                          {t("active")}
                        </div>
                      </div>
                      <button
                        className="btn"
                        type="button"
                        disabled={!sessions[0]}
                        onClick={() => sessions[0] && openSession(sessions[0])}
                      >{t("Open")}</button>
                    </div>
                  );
                })}
              </div>
              <div className="sectionTitle">{t("Workspace")}</div>
              <div className="tabs" aria-label={t("Workspace views")}>{(["overview", "git", "artifacts"] as const).map((tab) => <button className={`tab ${projectTab === tab ? "active" : ""}`} type="button" aria-pressed={projectTab === tab} key={tab} onClick={() => setProjectTab(tab)}>{tab === "overview" ? t("Overview") : tab === "git" ? "Git" : t("Artifacts")}</button>)}</div>
              {projectTab === "overview" && <div className="card"><div className="row"><strong className="grow">{vcs?.branch ?? t("Workspace")}</strong><span className="pill">{vcs?.files.length ?? "—"} {t("changed")}</span></div><p className="small muted">{t("Open Git to review changes or Artifacts to preview useful outputs from OpenCode.")}</p></div>}
              {projectTab === "git" && <GitPanel context={controlContext} />}
              {projectTab === "artifacts" && <ArtifactGallery context={controlContext} />}
            </section>
          )}
          {snapshot && page === "agents" && (
            <section className="page active" key="agents">
              <div className="heading">{t("Agents")}</div>
              <div className="small muted mb">{t("Monitor models, activity and capability access.")}</div>
              <div className="card">
                {!agentCatalog && <p className="loading">{t("Loading agent catalog...")}</p>}
                {agentCatalog?.agents.length === 0 && (
                  <p className="empty compact">{t("No agents were reported by OpenCode.")}</p>
                )}
                {agentCatalog?.agents.map((agent) => (
                  <button
                    className={`row row-button ${selectedAgent?.name === agent.name ? "active" : ""}`}
                    type="button"
                    aria-pressed={selectedAgent?.name === agent.name}
                    key={agent.name}
                    onClick={() => setSelectedAgentName(agent.name)}
                  >
                    <Icon name="agents" />
                    <div className="grow">
                      <strong>{agent.name}</strong>
                      <div className="tiny muted">
                        {agent.description ?? t("No description provided.")}
                      </div>
                    </div>
                    <span className="pill">{stateLabel(agent.mode)}</span>
                  </button>
                ))}
              </div>
              <div className="sectionTitle">{t("Recorded subagent sessions")}</div>
              <div className="card">
                {childSessions.length === 0 && (
                  <p className="empty compact">{t("No subagent sessions are active or recorded.")}</p>
                )}
                {childSessions.map((session) => (
                  <button
                    className="row row-button"
                    type="button"
                    key={session.id}
                    onClick={() => openSession(session)}
                  >
                    {sessionStatus[session.id] === "busy" ? <span className="dot" /> : <Icon name="agents" />}
                    <div className="grow">
                      <strong>{session.agent ?? session.title}</strong>
                      <div className="tiny muted">
                        {t("Subagent")} · {session.model?.id ?? "OpenCode"}
                      </div>
                    </div>
                    <span className="pill">
                      {sessionStatus[session.id] ?? "idle"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="sectionTitle">{t("Selected agent")}</div>
              {selectedAgent ? (
                <div className="card">
                  <div className="flex between">
                    <div>
                      <strong>{selectedAgent.name}</strong>
                      <div className="tiny muted">
                        {selectedAgent.description ?? t("No description provided.")}
                      </div>
                    </div>
                    <span className="pill">{t("Configured")}</span>
                  </div>
                  <div className="grid2 mt">
                    <div className="soft">
                      <strong className="tiny">{t("TYPE")}</strong>
                      <div className="small mt muted">
                        {stateLabel(selectedAgent.mode)} · {selectedAgent.native ? t("Native") : t("Custom")}
                      </div>
                    </div>
                    <div className="soft">
                      <strong className="tiny">{t("MODEL")}</strong>
                      <div className="small mt muted">
                        {selectedAgent.model
                          ? `${selectedAgent.model.providerId} / ${selectedAgent.model.id}`
                          : t("Session default")}
                      </div>
                    </div>
                  </div>
                  {selectedAgent.variant && (
                    <div className="small mt muted">{t("Default effort")}: {stateLabel(selectedAgent.variant)}</div>
                  )}
                  <button
                    className="btn primary wfull mt"
                    type="button"
                    onClick={() => {
                      setNewSessionAgent(selectedAgent.name);
                      setNewSessionOpen(true);
                    }}
                  >
                    <Icon name="plus" /> {t("New session with")} {selectedAgent.name}
                  </button>
                </div>
              ) : (
                <div className="card empty-state compact">
                  <strong>{t("No agent selected")}</strong>
                  <span>{t("OpenCode did not expose an available agent.")}</span>
                </div>
              )}
            </section>
          )}
          {page === "settings" && (
            <section className="page active" key="settings">
              <div className="heading">{t("Settings")}</div>
              <div className="small muted mb">{t("OpenCode, integrations and security.")}</div>
              <div className="tabs">
                {(
                  [
                    ["integrations", t("Integrations")],
                    ["ai", t("AI & Tools")],
                    ["security", t("Security")],
                    ["storage", t("Storage")],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    className={`tab ${settingsTab === id ? "active" : ""}`}
                    type="button"
                    key={id}
                    onClick={() => setSettingsTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {settingsTab === "integrations" && (
                <div className="tabpane active">
                  <IntegrationManager context={controlContext} />
                  <div className="card">
                    <div className="row">
                      <div className="brandmark">T</div>
                      <div className="grow">
                        <strong>Telegram</strong>
                        <div className="tiny muted">{t("Mini App authentication and secure remote access")}</div>
                      </div>
                      <span className="pill">{t("Authenticated")}</span>
                    </div>
                    <div className="row">
                      <div className="brandmark">OC</div>
                      <div className="grow">
                        <strong>OpenCode</strong>
                        <div className="tiny muted">{t("Local server through the secure Bridge")}</div>
                      </div>
                      <span className="pill">
                        <span className={online ? "dot" : "dot offline"} />
                        {online ? t("Connected") : t("Offline")}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {settingsTab === "ai" && (
                <div className="tabpane active">
                  <AppearanceSettings />
                  <div className="card">
                    <strong>{t("Providers & Models")}</strong>
                    <div className="small muted mt">{catalogSummary}</div>
                    <div className="provider-pills mt">{connectedProviders.map((provider) => <span className="pill" key={provider.id}><span className="dot" />{provider.name}</span>)}</div>
                    <p className="small muted">{t("Manage providers, Skills, MCP servers and plugins in Integrations. Capabilities and configuration limits come directly from OpenCode.")}</p>
                    <button className="btn" type="button" onClick={() => setSettingsTab("integrations")}>{t("Manage integrations")}</button>
                  </div>
                </div>
              )}
              {settingsTab === "security" && (
                <div className="tabpane active">
                  <SecurityCenter context={controlContext} requested={stepUpRequested} expiresAt={privilegedExpiresAt} onElevation={setPrivilegedExpiresAt} onLocked={onLocked}>
                  <div className="grid2">
                    <div className="card">
                      <div className="tiny muted">{t("APPROVAL POLICY")}</div>
                      <div className="metric">{t("Enforced")}</div>
                      <div className="small muted">
                        Trusted device + explicit approval
                      </div>
                    </div>
                    <div className="card">
                      <div className="tiny muted">{t("NETWORK BINDING")}</div>
                      <div className="metric">{t("Loopback")}</div>
                      <div className="small muted">{t("Bridge and OpenCode remain local")}</div>
                    </div>
                  </div>
                  <div className="sectionTitle">{t("Trusted devices")}</div>
                  <div className="card">
                    {deviceError && (
                      <p className="conversation-error">{t(deviceError)}</p>
                    )}
                    {!devices && !deviceError && (
                      <p className="loading">{t("Loading devices…")}</p>
                    )}
                    {devices?.map((device) => (
                      <div className="row" key={device.id}>
                        <div className="brandmark"><Icon name="settings" /></div>
                        <div className="grow">
                          <strong>{device.label}</strong>
                          <div className="tiny muted">
                            {t("Last authenticated")}{" "}
                            {new Intl.DateTimeFormat(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(device.lastSeenAt * 1_000)}
                          </div>
                        </div>
                        {device.current ? (
                          <span className="pill">{t("Current")}</span>
                        ) : (
                          <button
                            className="btn danger"
                            type="button"
                            onClick={() => setRevokeTarget(device)}
                          >{t("Revoke")}</button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="sectionTitle">{t("Recent security events")}</div>
                  <div className="card">
                    {auditEvents?.slice(0, 8).map((event) => (
                      <div className="row" key={event.id}>
                        <div className="grow">
                          <div className="small">
                            {t(event.event.replaceAll(".", " "))}
                          </div>
                          <div className="tiny muted">
                            {new Intl.DateTimeFormat(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(event.createdAt)}
                          </div>
                        </div>
                        <span className="pill">{stateLabel(event.outcome)}</span>
                      </div>
                    ))}
                  </div>
                  </SecurityCenter>
                </div>
              )}
              {settingsTab === "storage" && (
                <div className="tabpane active">
                  <CachePanel onUnauthorized={onUnauthorized} />
                  {capabilityStatus === "loading" ? (
                    <div className="card"><p className="loading">{t("Loading storage capability…")}</p></div>
                  ) : capabilityStatus === "error" ? (
                    <div className="card"><div className="empty-state"><strong>{t("Storage status unavailable")}</strong><span>{t("The Bridge capability could not be loaded.")}</span></div></div>
                  ) : capabilities?.capabilities.storage?.status === "available" ? (
                    <div className="card storage-card"><StorageBrowser onUnauthorized={onUnauthorized} /></div>
                  ) : (
                    <div className="card"><div className="empty-state"><strong>{t("Secure workspace browsing is disabled")}</strong><span>{t(capabilities?.capabilities.storage?.reason ?? "The Bridge has not enabled opaque directory access.")}</span></div></div>
                  )}
                </div>
              )}
            </section>
          )}
          {selected && page === "conversation" && (
            <Conversation
              session={selected}
              onBack={() => openPage("home")}
              onUnauthorized={onUnauthorized}
              onStepUp={requireStepUp}
              connectionEpoch={connectionEpoch}
              status={sessionStatus[selected.id] ?? "idle"}
              onDelete={() => setDeleteTarget(selected)}
              availableModels={availableModels}
              availableAgents={agentCatalog?.agents ?? []}
              {...(conversationAgent ? { initialAgent: conversationAgent } : {})}
              {...(conversationEvent ? { event: conversationEvent } : {})}
            />
          )}
        </main>
      </div>
      <Navigation page={page} onChange={openPage} className="mobileNav" />
      {revokeTarget && (
        <section
          className="approval"
          role="dialog"
          aria-modal="true"
          aria-labelledby="revoke-device-title"
        >
          <small>{t("SECURITY CONFIRMATION")}</small>
          <h2 id="revoke-device-title">{tf("Revoke {name}?", { name: revokeTarget.label })}</h2>
          <blockquote>{t("This device will immediately lose access and its active Bridge sessions will end.")}</blockquote>
          <div>
            <button
              type="button"
              autoFocus
              disabled={revoking}
              onClick={() => setRevokeTarget(undefined)}
            >{t("Cancel")}</button>
            <button
              className="danger-button"
              type="button"
              disabled={revoking}
              onClick={() => void revokeDevice()}
            >{t("Revoke device")}</button>
          </div>
        </section>
      )}
      {newSessionOpen && !createProposal && (
        <section
          className="approval"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-session-title"
        >
          <small>{t("NEW OPENCODE SESSION")}</small>
          <h2 id="new-session-title">{t("Create a session?")}</h2>
          <form
            className="session-form"
            onSubmit={(event) => void proposeSession(event)}
          >
            <label htmlFor="session-title">{t("Title")}<span>(optional)</span>
            </label>
            <input
              id="session-title"
              autoFocus
              maxLength={120}
              value={newSessionTitle}
              onChange={(event) => setNewSessionTitle(event.target.value)}
              placeholder={t("Remote task")}
            />
            <div>
              <button
                type="button"
                disabled={acting}
              onClick={() => {
                setNewSessionOpen(false);
                setNewSessionAgent("");
              }}
              >{t("Cancel")}</button>
              <button className="primary" type="submit" disabled={acting}>{t("Review")}</button>
            </div>
          </form>
        </section>
      )}
      {createProposal && (
        <section
          className="approval"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-session-title"
        >
          <small>{t("PERMISSION REQUIRED")}</small>
          <h2 id="confirm-session-title">{t("Create this OpenCode session?")}</h2>
          <blockquote>
            <span>{createProposal.title ?? t("Untitled session in the configured workspace")}</span>
            {createProposal.agent && (
              <span className="approval-attachment">{t("Agent")}: {createProposal.agent}</span>
            )}
          </blockquote>
          <div>
            <button
              type="button"
              autoFocus
              disabled={acting}
              onClick={() => void decideSession("deny")}
            >{t("Deny")}</button>
            <button
              className="primary"
              type="button"
              disabled={acting}
              onClick={() => void decideSession("approve")}
            >{t("Create")}</button>
          </div>
        </section>
      )}
      {deleteTarget && (
        <section
          className="approval"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-session-title"
        >
          <small>{t("DELETE SESSION")}</small>
          <h2 id="delete-session-title">{tf("Delete {name}?", { name: deleteTarget.title })}</h2>
          <blockquote>{t("This permanently deletes the OpenCode session and its conversation history. This action cannot be undone.")}</blockquote>
          <div>
            <button
              type="button"
              autoFocus
              disabled={acting}
              onClick={() => setDeleteTarget(undefined)}
            >{t("Cancel")}</button>
            <button
              className="danger-button"
              type="button"
              disabled={acting}
              onClick={() => void proposeDelete()}
            >{t("Review deletion")}</button>
          </div>
        </section>
      )}
      {deleteProposal && (
        <section
          className="approval"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-delete-title"
        >
          <small>{t("PERMISSION REQUIRED")}</small>
          <h2 id="confirm-delete-title">{t("Permanently delete this session?")}</h2>
          <blockquote>{deleteProposal.session.title}</blockquote>
          <div>
            <button
              type="button"
              autoFocus
              disabled={acting}
              onClick={() => void decideDelete("deny")}
            >{t("Deny")}</button>
            <button
              className="danger-button"
              type="button"
              disabled={acting}
              onClick={() => void decideDelete("approve")}
            >{t("Delete session")}</button>
          </div>
        </section>
      )}
    </div>
  );
}
