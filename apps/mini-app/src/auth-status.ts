import type { GateState } from "./AccessGate.js"

export const stateAfterUnauthorized = (current: GateState): GateState => current.kind === "locked" ? current : { kind: "denied", reason: "invalid_session" }

export function stateForTelegramAuthStatus(status: number): GateState | undefined {
  if (status === 200) return { kind: "authorized" }
  if (status === 202) return undefined
  return { kind: "denied", reason: "invalid_session", status }
}
