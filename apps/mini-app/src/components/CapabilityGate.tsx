import type { CapabilityGateProps } from "./chat-types.js"

const defaultReason = {
  unsupported: "This feature is not supported by the current Bridge.",
  disabled: "This feature is disabled.",
  error: "This feature could not be loaded.",
} as const

export function CapabilityGate({ capability, children, loading, unavailable }: CapabilityGateProps) {
  if (capability.status === "available") return <>{children}</>
  if (capability.status === "loading") return <>{loading ?? <div className="capability-state capability-state--loading" role="status">Loading…</div>}</>
  if (typeof unavailable === "function") return <>{unavailable(capability)}</>
  if (unavailable !== undefined) return <>{unavailable}</>
  return <div className={`capability-state capability-state--${capability.status}`} role={capability.status === "error" ? "alert" : "status"}>
    {capability.reason ?? defaultReason[capability.status]}
  </div>
}
