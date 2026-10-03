/** Persistable, strictly bounded Git intent; credentials/remotes/refs are not accepted. */
export type GitMutation = { type: "git.pull" | "git.push" } | { type: "git.commit"; message: string; paths: string[] }
export const gitTypes = ["git.commit", "git.pull", "git.push"] as const
export const isGitType = (value: string): value is GitMutation["type"] => gitTypes.some((type) => type === value)
export class GitActionError extends Error {
  constructor(readonly stagingMayHaveChanged: boolean) { super(stagingMayHaveChanged ? "Git action failed; selected files may remain staged. Review Git status before retrying." : "Git action unavailable") }
}

export function normalizeGitPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\\\x00-\x1f\x7f:*?\[\]]/.test(value) || value.startsWith("/") || value.startsWith("-") || value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("Invalid Git path")
  return value
}

export function normalizeGitMutation(input: unknown): GitMutation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Git action")
  const item = input as Record<string, unknown>
  if (typeof item.type !== "string" || !isGitType(item.type)) throw new Error("Invalid Git action")
  const allowed = item.type === "git.commit" ? ["type", "message", "paths"] : ["type"]
  if (Object.keys(item).some((key) => !allowed.includes(key))) throw new Error("Invalid Git fields")
  if (item.type !== "git.commit") return { type: item.type }
  if (typeof item.message !== "string" || !item.message.trim() || item.message.trim() !== item.message || item.message.length > 2000 || /[\x00-\x1f\x7f]/.test(item.message)) throw new Error("Invalid commit message")
  if (!Array.isArray(item.paths) || item.paths.length < 1 || item.paths.length > 100) throw new Error("Select 1 to 100 files")
  const paths = item.paths.map(normalizeGitPath)
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate Git paths")
  return { type: item.type, message: item.message, paths }
}
