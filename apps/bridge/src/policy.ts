export type PolicyDecision = "ALLOW" | "ASK" | "DENY"

export function decide(action: string): PolicyDecision {
  if (isGitType(action)) return "ASK"
  if (isManagementType(action)) return "ASK"
  if (action === "session.read") return "ALLOW"
  if (action === "cache.cleanup") return "ASK"
  if (
    action === "session.create" ||
    action === "session.prompt" ||
    action === "session.abort" ||
    action === "session.delete"
  ) return "ASK"
  if (action === "opencode.permission") return "ASK"
  return "DENY"
}
import { isManagementType } from "./management-actions.js"
import { isGitType } from "./git-actions.js"

