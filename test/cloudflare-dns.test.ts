import { afterAll, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient } from "effect/http"
import * as CloudflareDns from "../src/cloudflare-dns/index.ts"

// Reaches Cloudflare's DNS and a Cloudflare site: LIVE=1 bun test cloudflare-dns
const live = process.env["LIVE"] === "1"

// The Worker: answers the Host header it was sent, and the query.
const worker = Bun.serve({ port: 0, fetch: (request) => new Response(`${request.headers.get("host")}${new URL(request.url).search}`) })

// A DNS over HTTPS server that knows worker.test at 127.0.0.1, and new.test from the second time it is asked.
const asked: Array<string> = []
const knows = (name: string) => name === "worker.test" || (name === "new.test" && asked.filter((earlier) => earlier === name).length > 1)
const resolver = Bun.serve({
  port: 0,
  fetch: (request) => {
    const name = new URL(request.url).searchParams.get("name") ?? ""
    asked.push(name)
    if (!knows(name)) {
      return Response.json({ Status: 3 })
    }
    return Response.json({ Status: 0, Answer: [{ name, type: 1, TTL: 300, data: "127.0.0.1" }] })
  },
})

const layer = CloudflareDns.layer({ resolver: `http://127.0.0.1:${resolver.port}/dns-query` })

const getAll = (urls: ReadonlyArray<string>) =>
  Effect.runPromise(
    Effect.forEach(urls, (url) => HttpClient.get(url).pipe(Effect.flatMap((response) => response.text))).pipe(Effect.provide(layer))
  )

beforeEach(() => {
  asked.length = 0
})

afterAll(async () => {
  await Promise.all([worker.stop(true), resolver.stop(true)])
})

test("sends a request to the address the resolver gives, naming its host in the Host header", async () => {
  expect(await getAll([`http://worker.test:${worker.port}/`])).toEqual([`worker.test:${worker.port}`])
})

test("keeps the request's url params", async () => {
  const get = HttpClient.get(`http://worker.test:${worker.port}/`, { urlParams: { version: "1" } }).pipe(Effect.flatMap((response) => response.text))
  expect(await Effect.runPromise(get.pipe(Effect.provide(layer)))).toBe(`worker.test:${worker.port}?version=1`)
})

test("asks the resolver once per host while its answer's TTL lasts", async () => {
  await getAll([`http://worker.test:${worker.port}/`, `http://worker.test:${worker.port}/again`])
  expect(asked).toEqual(["worker.test"])
})

test("asks again after a miss, so a domain created a moment later resolves", async () => {
  // The machine's resolver, which the miss falls back to, may take long to fail: the first request isn't waited for.
  const beforeTheDomainExists = HttpClient.get(`http://new.test:${worker.port}/`).pipe(Effect.timeout("200 millis"), Effect.ignore)
  const afterwards = HttpClient.get(`http://new.test:${worker.port}/`).pipe(Effect.flatMap((response) => response.text))
  const answered = await Effect.runPromise(Effect.andThen(beforeTheDomainExists, afterwards).pipe(Effect.provide(layer)))
  expect(answered).toBe(`new.test:${worker.port}`)
  expect(asked).toEqual(["new.test", "new.test"])
})

test("leaves localhost and addresses to the machine", async () => {
  await getAll([`http://localhost:${worker.port}/`, `http://127.0.0.1:${worker.port}/`])
  expect(asked).toEqual([])
})

test.skipIf(!live)("reaches a Cloudflare site at Cloudflare's address, checking TLS against the hostname", async () => {
  const trace = HttpClient.get("https://cloudflare.com/cdn-cgi/trace").pipe(Effect.flatMap((response) => response.text))
  expect(await Effect.runPromise(trace.pipe(Effect.provide(CloudflareDns.layer())))).toContain("h=cloudflare.com")
})
