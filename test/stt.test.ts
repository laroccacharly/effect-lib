import { afterAll, beforeEach, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { layer as keyringLayer, memoryKeyring } from "../src/credentials/index.ts"
import { layer, MODEL, Stt } from "../src/stt/index.ts"

interface Received {
  readonly path: string
  readonly authorization: string | null
  readonly title: string | null
  readonly body: Record<string, string | object>
}

// A stand-in OpenRouter that records what it receives and answers with `status` and `answer`.
let received: Array<Received> = []
let status = 200
let answer: object = { text: "hello world" }
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body: Record<string, string | object> = await request.json()
    received.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
      title: request.headers.get("x-openrouter-title"),
      body,
    })
    return Response.json(answer, { status })
  },
})
afterAll(() => server.stop(true))
beforeEach(() => {
  received = []
  status = 200
  answer = { text: "hello world" }
})

const run = <A, E>(effect: Effect.Effect<A, E, Stt>, keyring: Record<string, string> = { OPENROUTER_API_KEY: "test-key" }) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer({ origin: server.url.origin, title: "cterm" }).pipe(Layer.provide([FetchHttpClient.layer, keyringLayer(memoryKeyring(keyring))]))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({}))
    )
  )

const recording = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" })

test("posts the base64 audio, its format and the default model with the key", async () => {
  const text = await run(Stt.use((stt) => stt.transcribe(recording)))
  expect(text).toBe("hello world")
  expect(received).toEqual([
    {
      path: "/api/v1/audio/transcriptions",
      authorization: "Bearer test-key",
      title: "cterm",
      body: { model: MODEL, input_audio: { data: "AQID", format: "webm" } },
    },
  ])
})

test("passes the model, language and provider options through", async () => {
  const provider = { options: { azure: { enhancedMode: { modelOptions: { transcribeStyle: "clean" } } } } }
  const audio = new Blob([new Uint8Array([1, 2, 3])])
  await run(Stt.use((stt) => stt.transcribe(audio, { model: "microsoft/mai-transcribe-2", format: "ogg", language: "fr", provider })))
  expect(received[0]?.body).toEqual({ model: "microsoft/mai-transcribe-2", input_audio: { data: "AQID", format: "ogg" }, language: "fr", provider })
})

test("a rejected request fails with OpenRouter's message", async () => {
  status = 400
  answer = { error: { message: "unsupported audio format" } }
  const error = await run(Effect.flip(Stt.use((stt) => stt.transcribe(recording))))
  expect(error._tag).toBe("SttError")
  expect(error.message).toContain("unsupported audio format")
})

test("audio of an unknown type fails before calling OpenRouter", async () => {
  const error = await run(Effect.flip(Stt.use((stt) => stt.transcribe(new Blob([new Uint8Array([1])])))))
  expect(error._tag).toBe("SttError")
  expect(received).toEqual([])
})

test("a missing key fails before calling OpenRouter", async () => {
  const error = await run(Effect.flip(Stt.use((stt) => stt.transcribe(recording))), {})
  expect(error._tag).toBe("CredentialsError")
  expect(received).toEqual([])
})
