import type { ReactNode } from "react"

export type MessageStatus = "sending" | "streaming" | "completed" | "failed"
export type ToolStatus = "pending" | "running" | "completed" | "error"
export type FileChangeStatus = "created" | "modified" | "deleted" | "renamed"

export type ToolActivityData = {
  id?: string
  name: string
  status: ToolStatus
  title?: string
  input?: string
  output?: string
}

export type DiffData = {
  file: string
  fileId?: string
  diff: string
  status?: FileChangeStatus
  additions?: number
  deletions?: number
}

export type MessagePart =
  | { type: "markdown"; id?: string; content: string }
  | { type: "code"; language?: string; content: string; filename?: string }
  | { type: "image"; attachmentId: string; alt?: string; name?: string }
  | { type: "file"; fileId: string; path: string; name: string; mime?: string; size?: number }
  | ({ type: "diff" } & DiffData)
  | ({ type: "tool" } & ToolActivityData)
  | { type: "status"; content: string; tone?: "neutral" | "success" | "warning" | "error" }

export type ChatMessage = {
  id: string
  role: "user" | "assistant" | "system"
  createdAt: string | number
  status?: MessageStatus
  parts: MessagePart[]
}

export type FileChange = DiffData & {
  previousFile?: string
}

export type CapabilityState =
  | { status: "loading" }
  | { status: "available" }
  | { status: "unsupported"; reason?: string }
  | { status: "disabled"; reason?: string }
  | { status: "error"; reason?: string }

export type CapabilityGateProps = {
  capability: CapabilityState
  children: ReactNode
  loading?: ReactNode
  unavailable?: ReactNode | ((capability: Exclude<CapabilityState, { status: "available" } | { status: "loading" }>) => ReactNode)
}
