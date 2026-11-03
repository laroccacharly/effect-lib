import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import * as CloudflareDns from "../src/cloudflare-dns/index.ts"

// Reaches Cloudflare's DNS and a Cloudflare site: LIVE=1 bun test cloudflare-dns
const live = process.env["LIVE"] === "1"

test.skipIf(!live)("resolves through Cloudflare and fetches at that address, checking TLS against the hostname", async () => {
  const address = await Effect.runPromise(CloudflareDns.resolve("cloudflare.com"))
  expect(Option.getOrThrow(address)).toMatch(/^\d+\.\d+\.\d+\.\d+$/u)
  const response = await CloudflareDns.fetch("https://cloudflare.com/cdn-cgi/trace")
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("h=cloudflare.com")
})

test.skipIf(!live)("a name Cloudflare does not know is none", async () => {
  expect(await Effect.runPromise(CloudflareDns.resolve("no-such-name.invalid"))).toEqual(Option.none())
})
