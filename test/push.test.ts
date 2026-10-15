import { afterAll, beforeEach, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { layer as keyringLayer, memoryKeyring } from "../src/credentials/index.ts"
import { layer, Push } from "../src/push/index.ts"

interface Received {
  readonly method: string
  readonly path: string
  readonly body: Record<string, string>
}

// A stand-in Pushover that records what it receives and answers with `status` and `answer`.
let received: Array<Received> = []
let status = 200
let answer: object = { status: 1, request: "r" }
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body: Record<string, string> = await request.json()
    received.push({ method: request.method, path: new URL(request.url).pathname, body })
    return Response.json(answer, { status })
  },
})
afterAll(() => server.stop(true))
beforeEach(() => {
  received = []
  status = 200
  answer = { status: 1, request: "r" }
})

const credentials = { PUSH_APP_TOKEN: "app-token", PUSH_USER_KEY: "user-key" }

const run = <A, E>(effect: Effect.Effect<A, E, Push>, keyring: Record<string, string> = credentials) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer({ origin: server.url.origin }).pipe(Layer.provide([FetchHttpClient.layer, keyringLayer(memoryKeyring(keyring))]))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({}))
    )
  )

test("posts the message and title with the credentials to /1/messages.json", async () => {
  await run(Push.use((push) => push.notify("Plug unreachable", { title: "humi" })))
  expect(received).toEqual([
    { method: "POST", path: "/1/messages.json", body: { token: "app-token", user: "user-key", message: "Plug unreachable", title: "humi" } },
  ])
})

test("a rejected message fails with Pushover's reasons", async () => {
  status = 400
  answer = { status: 0, errors: ["user identifier is invalid"] }
  const error = await run(Effect.flip(Push.use((push) => push.notify("hi"))))
  expect(error._tag).toBe("PushError")
  expect(error.message).toContain("user identifier is invalid")
})

test("missing credentials fail before calling Pushover", async () => {
  const error = await run(Effect.flip(Push.use((push) => push.notify("hi"))), {})
  expect(error._tag).toBe("CredentialsError")
  expect(received).toEqual([])
})
