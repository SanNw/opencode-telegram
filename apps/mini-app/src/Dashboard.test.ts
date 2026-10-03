import assert from "node:assert/strict"
import test from "node:test"
import { sessionsForProject, type Session } from "./Dashboard.js"

const session = (id: string, projectId: string): Session => ({
  id,
  projectId,
  title: id,
  directory: "/workspace",
  updatedAt: 1,
})

test("project cards include only sessions from their own project", () => {
  const sessions = [session("one", "project-a"), session("two", "project-b")]
  assert.deepEqual(sessionsForProject(sessions, "project-a").map(({ id }) => id), ["one"])
})
