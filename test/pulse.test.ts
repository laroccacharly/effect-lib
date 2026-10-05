import { afterAll, beforeEach, expect, test } from "bun:test"
import { hostname } from "node:os"
import { ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { layer as keyringLayer, memoryKeyring } from "../src/credentials/index.ts"
import { layer, PulseClient } from "../src/pulse/index.ts"

interface Received {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly body: { host: string }
}

// A stand-in pulse server that records what it receives and answers with `status`.
let received: Array<Received> = []
let status = 200
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body: { host: string } = await request.json()
    received.push({ method: request.method, path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body })
    return new Response(null, { status })
  },
})
afterAll(() => server.stop(true))
beforeEach(() => {
  received = []
  status = 200
})

const run = <A, E>(effect: Effect.Effect<A, E, PulseClient>, keyring: Record<string, string> = { PULSE_API_KEY: "test-key" }) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer({ origin: server.url.origin }).pipe(Layer.provide([FetchHttpClient.layer, keyringLayer(memoryKeyring(keyring))]))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({}))
    )
  )

const ping = (host?: string) => PulseClient.use((client) => client.ping(host))

test("posts the host to /api/ping with the API key as a bearer token", async () => {
  await run(ping("box-a"))
  expect(received).toEqual([{ method: "POST", path: "/api/ping", authorization: "Bearer test-key", body: { host: "box-a" } }])
})

test("defaults the host to this machine's hostname", async () => {
  await run(ping())
  expect(received[0]?.body).toEqual({ host: hostname() })
})

test("a server error fails with a PulseError", async () => {
  status = 401
  const error = await run(Effect.flip(ping("box-a")))
  expect(error._tag).toBe("PulseError")
  expect(error.message).toContain("box-a")
})

test("a missing API key fails before calling the server", async () => {
  const error = await run(Effect.flip(ping("box-a")), {})
  expect(error._tag).toBe("CredentialsError")
  expect(received).toEqual([])
})
