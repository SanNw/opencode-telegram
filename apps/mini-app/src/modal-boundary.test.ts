import assert from "node:assert/strict"
import test from "node:test"
import { isolateModalBackground } from "./modal-boundary.js"
type ElementStub = { inert: boolean; children: ElementStub[]; parentElement: ElementStub | null }
const element = (inert = false): ElementStub => ({ inert, children: [], parentElement: null })
const attach = (parent: ElementStub, children: ElementStub[]) => { parent.children = children; for (const child of children) child.parentElement = parent }
test("modal isolation makes every background branch inert and preserves earlier inert state", () => {
  const body = element(), app = element(), nav = element(), settings = element(), dialog = element(), tabs = element(), alreadyInert = element(true), outsideApp = element()
  attach(body, [app, outsideApp]); attach(app, [nav, settings]); attach(settings, [tabs, alreadyInert, dialog])
  const release = isolateModalBackground(dialog as unknown as HTMLElement)
  assert.equal(nav.inert, true); assert.equal(tabs.inert, true); assert.equal(outsideApp.inert, true); assert.equal(alreadyInert.inert, true)
  assert.equal(dialog.inert, false); assert.equal(settings.inert, false); assert.equal(app.inert, false)
  // Pending setup and once-displayed key share the same live boundary until acknowledgement.
  assert.equal(nav.inert, true); assert.equal(tabs.inert, true)
  release()
  assert.equal(nav.inert, false); assert.equal(tabs.inert, false); assert.equal(outsideApp.inert, false); assert.equal(alreadyInert.inert, true)
})
