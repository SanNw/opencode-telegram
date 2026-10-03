export type ControlContext = { onUnauthorized: () => void; onStepUp: () => void }
export type Proposal = { actionId: string; summary: string; expiresAt?: number }
export class ControlError extends Error {
  constructor(readonly status: number, readonly stagingMayHaveChanged = false) {
    super(status === 403 ? "Step-up authentication required. Open Security, authenticate, then review the action again." : status === 429 ? "Too many attempts. Wait before trying again." : stagingMayHaveChanged ? "Selected files may remain staged. Refresh and review Git status before retrying." : "The action could not be completed. Refresh and try again.")
  }
}
export async function controlRequest<T>(path: string, context: ControlContext, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(path, { method, credentials: "include", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) })
  if (!response.ok) {
    if (response.status === 401) context.onUnauthorized()
    if (response.status === 403) context.onStepUp()
    let stagingMayHaveChanged = false
    try { stagingMayHaveChanged = (await response.json() as { stagingMayHaveChanged?: boolean }).stagingMayHaveChanged === true } catch { /* No server error text or secrets enter the UI. */ }
    throw new ControlError(response.status, stagingMayHaveChanged)
  }
  return await response.json() as T
}
export const controlErrorMessage = (error: unknown) => error instanceof ControlError ? error.message : "The Bridge could not be reached. Try again."
export const attachmentUrl = (id: string, preview = false): string | undefined => /^att_[A-Za-z0-9_-]{32}$/.test(id) ? `/api/v1/attachments/${encodeURIComponent(id)}${preview ? "/preview" : ""}` : undefined
export const secondsRemaining = (expiresAt: number | undefined, now = Date.now()) => expiresAt ? Math.max(0, expiresAt - Math.floor(now / 1000)) : 0
export const proposeSessionDeletion = (sessionId: string, context: ControlContext) => controlRequest<{ actionId: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/actions`, context, { type: "session.delete" })
export const decideSessionDeletion = (actionId: string, decision: "approve" | "deny", context: ControlContext) => controlRequest(`/api/v1/actions/${encodeURIComponent(actionId)}/decision`, context, { decision })
export const replyOpenCodePermission = (requestId: string, reply: "once" | "reject", context: ControlContext) => controlRequest(`/api/v1/permissions/${encodeURIComponent(requestId)}/reply`, context, { reply })
