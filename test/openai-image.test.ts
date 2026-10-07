import { expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { bunKeyring, layer as keyringLayer, SERVICE } from "../src/credentials/index.ts"
import { ApiKey, layer, OpenAIImage } from "../src/openai-image/index.ts"

// Paid: runs only under `bun run test:live`, with the real OPENAI_API_KEY from the environment or the OS keyring, and is skipped without one.
const live = process.env["LIVE"] === "1"
const keyring = keyringLayer(bunKeyring(SERVICE, { retryTimes: 0 }))
const hasKey =
  live &&
  (await Effect.runPromise(
    ApiKey.lookup.pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
      Effect.provide(keyring)
    )
  ))

const run = <A, E>(effect: Effect.Effect<A, E, OpenAIImage>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer().pipe(Layer.provide([FetchHttpClient.layer, keyring])))))

const PNG = [0x89, 0x50, 0x4e, 0x47]
// A cheaper image model, enough to check the request and response shapes.
const cheap = { aspect: "1:1", quality: "low", model: "gpt-image-2.5-flare" } as const

test.skipIf(!hasKey)(
  "generates a PNG",
  async () => {
    const generated = await run(OpenAIImage.use((images) => images.generate("A plain red circle on a white background", cheap)))
    expect([...generated.subarray(0, 4)]).toEqual(PNG)
  },
  300_000
)
