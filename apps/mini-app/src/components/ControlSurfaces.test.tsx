import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SecurityCenter } from "./SecurityCenter.js"
import { ActionApproval, FocusDialog, approvalSecondaryAction } from "./ActionApproval.js"
import { IntegrationManager, ProviderCredentialForm } from "./IntegrationManager.js"
import { ArtifactGallery } from "./ArtifactGallery.js"
import { GitPanel } from "./GitPanel.js"
const context = { onUnauthorized() {}, onStepUp() {} }
test("Security uses a password input, timed privilege and protected controls", () => {
  const html = renderToStaticMarkup(<SecurityCenter context={context} onElevation={() => undefined} onLocked={() => undefined} expiresAt={Math.floor(Date.now() / 1000) + 300}><p>Trusted devices and audit</p></SecurityCenter>)
  assert.match(html, /type="password"/); assert.match(html, /autoComplete="off"/); assert.match(html, /Privileged session:/); assert.match(html, /Lock remote access/); assert.match(html, /Telegram account compromised/); assert.match(html, /Trusted devices and audit/)
  assert.doesNotMatch(html, /rk_|localStorage/)
})
test("approval cards show action summary and separate approve/deny buttons", () => {
  const html = renderToStaticMarkup(<ActionApproval proposal={{ actionId: "id", summary: "Push main to origin/main" }} context={context} onDone={() => undefined} onDismiss={() => undefined} />)
  assert.match(html, /role="dialog"/); assert.match(html, /aria-modal="true"/); assert.match(html, /Push main to origin\/main/); assert.match(html, />Deny</); assert.match(html, />Approve</)
})

test("shared pending dialogs render a native modal boundary without premature dismissal controls", () => {
  const html = renderToStaticMarkup(<FocusDialog titleId="pending-recovery"><h2 id="pending-recovery">Creating your Recovery Key</h2><p role="status">Keep this screen open</p></FocusDialog>)
  assert.match(html, /<dialog/); assert.match(html, /class="control-modal"/); assert.match(html, /aria-modal="true"/); assert.doesNotMatch(html, /<button/)
})

test("expired and failed approvals dismiss locally without reporting a server denial", () => {
  assert.equal(approvalSecondaryAction(true, ""), "dismiss")
  assert.equal(approvalSecondaryAction(false, "failed"), "dismiss")
  assert.equal(approvalSecondaryAction(false, ""), "deny")
})

test("switching provider identity changes the password-form mount key and never supplies an old value", () => {
  const props = { name: "Provider", busy: false, onSubmit() {}, onCancel() {} }
  const first = ProviderCredentialForm({ ...props, providerId: "provider-a" }), next = ProviderCredentialForm({ ...props, providerId: "provider-b" })
  assert.equal(first.key, "provider-a"); assert.equal(next.key, "provider-b"); assert.notEqual(first.key, next.key)
  const html = renderToStaticMarkup(next)
  assert.match(html, /type="password"/); assert.doesNotMatch(html, /value=|defaultValue=/)
})
test("integration, artifact and Git surfaces provide useful loading states and no credentials", () => {
  assert.match(renderToStaticMarkup(<IntegrationManager context={context} />), /Loading OpenCode integrations/)
  const artifacts = renderToStaticMarkup(<ArtifactGallery context={context} />)
  for (const category of ["All", "Documents", "Images", "Code"]) assert.match(artifacts, new RegExp(`>${category}<`))
  assert.match(artifacts, /Loading artifacts/)
  const git = renderToStaticMarkup(<GitPanel context={context} />)
  assert.match(git, /Loading Git status/); assert.match(git, /Recent commits/)
})
