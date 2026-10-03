import assert from "node:assert/strict"
import test from "node:test"
import { trustedClientIp } from "./source.js"

test("loopback proxy supplies only a valid canonical Cloudflare IPv4 or IPv6", () => {
  for (const socket of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(trustedClientIp(socket, "192.0.2.7"), "192.0.2.7")
    assert.equal(trustedClientIp(socket, "2001:0DB8:0000:0000:0000:0000:0000:0001"), "2001:db8::1")
  }
})

test("direct non-loopback peers cannot spoof the Cloudflare source", () => {
  assert.equal(trustedClientIp("198.51.100.8", "192.0.2.7"), "198.51.100.8")
  assert.equal(trustedClientIp("2001:db8::2", "192.0.2.7"), "2001:db8::2")
  assert.equal(trustedClientIp("::ffff:198.51.100.8", "192.0.2.7"), "::ffff:c633:6408")
})

test("malformed, duplicate, zone and noncanonical IPv4 headers fall back to the socket", () => {
  for (const header of ["not-an-ip", "127.0.0.1,192.0.2.7", "192.000.2.7", " 192.0.2.7 ", "fe80::1%eth0", ["192.0.2.7", "192.0.2.8"]]) {
    assert.equal(trustedClientIp("127.0.0.1", header), "127.0.0.1")
  }
  assert.equal(trustedClientIp(undefined, "192.0.2.7"), "unknown")
})
