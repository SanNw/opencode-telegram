import assert from "node:assert/strict"
import test from "node:test"
import { readConfig } from "./config.js"

test("configuration fails closed before Bridge authentication exists", () => {
  assert.throws(() => readConfig({}), /Telegram authentication is required/)
  assert.throws(
    () => readConfig({ BRIDGE_HOST: "0.0.0.0" }),
    /must be loopback/,
  )
  assert.throws(
    () => readConfig({ OPENCODE_URL: "file:///tmp/opencode" }),
    /must use http or https/,
  )
  assert.throws(
    () => readConfig({ TELEGRAM_OWNER_ID: "279058397" }),
    /must be configured together/,
  )
  assert.throws(
    () => readConfig({ TELEGRAM_BOT_TOKEN: "12345:abcdefghijklmnopqrstuvwxyz", TELEGRAM_OWNER_ID: "1", TELEGRAM_MINI_APP_URL: "http://example.com" }),
    /must be an HTTPS URL/,
  )
  assert.equal(readConfig({ ALLOW_INSECURE_LOCAL_DEV: "true" }).bridgeHost, "127.0.0.1")
})

test("management egress defaults closed and accepts exact DNS hosts only", () => {
  assert.deepEqual(readConfig({ ALLOW_INSECURE_LOCAL_DEV: "true" }).managementAllowedHosts, [])
  assert.deepEqual(readConfig({ ALLOW_INSECURE_LOCAL_DEV: "true", MANAGEMENT_ALLOWED_HOSTS: "example.com, api.example.com,example.com" }).managementAllowedHosts, ["example.com", "api.example.com"])
  for (const value of ["*.example.com", "https://example.com", "localhost", "127.0.0.1", "example.com:443", "example.com/path"]) assert.throws(() => readConfig({ ALLOW_INSECURE_LOCAL_DEV: "true", MANAGEMENT_ALLOWED_HOSTS: value }))
})


