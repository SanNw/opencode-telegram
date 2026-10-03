import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createStaticHandler } from "./static.js"

test("static Mini App origin applies restrictive browser headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-telegram-static-"))
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Mini App</title>")
  const serve = createStaticHandler(directory)
  const server = createServer(async (request, response) => {
    if (!await serve(request, response)) response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const address = server.address()
    assert(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-security-policy") ?? "", /telegram\.org/)
    assert.equal(response.headers.get("x-content-type-options"), "nosniff")
    assert.match(await response.text(), /Mini App/)
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/..%2Fsecret`)).status, 404)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true })
  }
})
