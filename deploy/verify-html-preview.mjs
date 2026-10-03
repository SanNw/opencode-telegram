import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequestHandler } from "../apps/bridge/dist/app.js"

// Run after build: CHROME_BINARY=/path/to/chrome node deploy/verify-html-preview.mjs
const chrome = process.env.CHROME_BINARY || process.argv[2]
assert(chrome, "Set CHROME_BINARY to an installed Chromium executable")
const profile = await mkdtemp(join(tmpdir(), "bridge-preview-check-"))
let forbiddenRequests = 0
const api = createRequestHandler({
  loadSnapshot: async () => { throw new Error("unused") },
  authorizeSession: (token) => token === "test" ? { userId:"test", deviceId:"test", expiresAt:4000000000 } : false,
  loadAttachment: async () => ({ name:"test.html",mime:"text/html; charset=utf-8",size:0,disposition:"attachment",content:Buffer.from(`
    <style>body{background:rgb(240,240,240)}</style><h1>Isolated preview</h1>
    <script>parent.document.body.dataset.escaped='yes'; fetch('/forbidden')</script>
    <img src="/forbidden"><link rel="stylesheet" href="/forbidden"><iframe src="/forbidden"></iframe>
  `) }),
})
const server = createServer((request,response) => {
  if (request.url?.startsWith("/api/")) return api(request,response)
  if (request.url === "/forbidden") { forbiddenRequests++; response.end("forbidden"); return }
  response.writeHead(200,{"content-type":"text/html","set-cookie":"bridge_session=test; Path=/; HttpOnly; SameSite=Strict"})
  response.end(`<body><iframe id="preview" sandbox="" src="/api/v1/attachments/att_${"a".repeat(32)}/preview"></iframe><script>
    document.querySelector('iframe').addEventListener('load',()=>{
      document.body.dataset.loaded='yes';
      document.body.dataset.isolated=String(document.querySelector('iframe').contentDocument===null);
    });
  </script></body>`)
})
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve))
try {
  const {port} = server.address()
  const output = await new Promise((resolve,reject) => {
    const child = spawn(chrome,["--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",`--user-data-dir=${profile}`,"--dump-dom","--virtual-time-budget=3000",`http://127.0.0.1:${port}/`])
    let stdout="",stderr=""
    child.stdout.on("data",chunk=>stdout+=chunk)
    child.stderr.on("data",chunk=>stderr+=chunk)
    child.on("error",reject)
    child.on("close",code=>code===0?resolve(stdout):reject(new Error(stderr)))
  })
  assert.match(output,/data-loaded="yes"/)
  assert.match(output,/data-isolated="true"/)
  assert.doesNotMatch(output,/data-escaped="yes"/)
  assert.equal(forbiddenRequests,0)
  console.log("HTML preview: loaded, opaque origin, scripts blocked, zero external resource requests.")
} finally {
  await new Promise(resolve=>server.close(resolve))
  await rm(profile,{recursive:true,force:true})
}
