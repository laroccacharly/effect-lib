import { type Array, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { type CredentialsError, Keyring, secret } from "../credentials/index.ts"

export const ORIGIN = "https://api.openai.com"
export const MODEL = "gpt-image-2.5-sunburst"

// Shared with every app that declares OPENAI_API_KEY, so one login is enough.
export const ApiKey = secret("OPENAI_API_KEY", { label: "OpenAI API key" })

export const SIZES = {
  auto: "auto",
  "1:1": "1024x1024",
  "16:9": "1536x864",
  "9:16": "864x1536",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
} as const

export type Aspect = keyof typeof SIZES
export type Quality = "auto" | "low" | "medium" | "high"

export interface ImageOptions {
  // Defaults to "auto". Ignored when `size` is set.
  readonly aspect?: Aspect
  // WIDTHxHEIGHT, any multiple of 16 the model accepts.
  readonly size?: `${number}x${number}`
  // Defaults to "auto", sent as "high".
  readonly quality?: Quality
  // A transparent background instead of an opaque one.
  readonly transparent?: boolean
  // Defaults to MODEL.
  readonly model?: string
}

export class OpenAIImageError extends Schema.TaggedError<OpenAIImageError>()("OpenAIImageError", {
  message: Schema.String,
}) {}

export class OpenAIImage extends Context.Service<
  OpenAIImage,
  {
    // A new PNG from the prompt.
    readonly generate: (prompt: string, options?: ImageOptions) => Effect.Effect<Uint8Array<ArrayBuffer>, OpenAIImageError | CredentialsError>
    // A new PNG from the prompt and reference images, e.g. `Bun.file(path)`.
    readonly edit: (prompt: string, images: Array.NonEmptyReadonlyArray<Blob>, options?: ImageOptions) => Effect.Effect<Uint8Array<ArrayBuffer>, OpenAIImageError | CredentialsError>
  }
>()("effect-lib/openai-image/OpenAIImage") {}

const Images = Schema.Struct({ data: Schema.NonEmptyArray(Schema.Struct({ b64_json: Schema.String })) })
const ErrorBody = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }))

const settings = (options: ImageOptions) => ({
  model: options.model ?? MODEL,
  size: options.size ?? SIZES[options.aspect ?? "auto"],
  quality: options.quality === undefined || options.quality === "auto" ? "high" : options.quality,
  background: options.transparent === true ? "transparent" : "opaque",
  output_format: "png",
})

// The first image of a 2xx response; otherwise fails with OpenAI's error message when it sends one.
const decodeImage = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  if (response.status < 200 || response.status >= 300) {
    const text = yield* response.text
    const message = Schema.decodeUnknownOption(ErrorBody)(text).pipe(
      Option.match({ onNone: () => text.slice(0, 500), onSome: (body) => body.error.message })
    )
    return yield* new OpenAIImageError({ message: `OpenAI Images answered ${response.status}: ${message}` })
  }
  const images = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Images)))
  return new Uint8Array(Buffer.from(images.data[0].b64_json, "base64"))
})

export interface OpenAIImageOptions {
  // Defaults to ORIGIN.
  readonly origin?: string
}

export const make = (options: OpenAIImageOptions = {}): Effect.Effect<OpenAIImage["Service"], never, HttpClient.HttpClient | Keyring> =>
  Effect.gen(function* () {
    const keyring = yield* Keyring
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(options.origin ?? ORIGIN)))

    // Reads the key on every request, so a rotated key is picked up without a restart.
    const send = (action: string, request: HttpClientRequest.HttpClientRequest) =>
      ApiKey.resolve.pipe(
        Effect.provideService(Keyring, keyring),
        Effect.flatMap((key) => http.execute(HttpClientRequest.bearerToken(request, Redacted.value(key)))),
        Effect.flatMap(decodeImage),
        Effect.mapError((error) => (error._tag === "CredentialsError" || error._tag === "OpenAIImageError" ? error : new OpenAIImageError({ message: `could not ${action} an image: ${error.message}` })))
      )

    const generate: (prompt: string, options?: ImageOptions) => Effect.Effect<Uint8Array<ArrayBuffer>, OpenAIImageError | CredentialsError> = Effect.fn("OpenAIImage.generate")(function* generate(
      prompt: string,
      options: ImageOptions = {}
    ) {
      const body = { ...settings(options), n: 1, prompt }
      return yield* send("generate", HttpClientRequest.post("/v1/images/generations").pipe(HttpClientRequest.bodyJsonUnsafe(body)))
    })

    const edit: (prompt: string, images: Array.NonEmptyReadonlyArray<Blob>, options?: ImageOptions) => Effect.Effect<Uint8Array<ArrayBuffer>, OpenAIImageError | CredentialsError> = Effect.fn(
      "OpenAIImage.edit"
    )(function* edit(prompt: string, images: Array.NonEmptyReadonlyArray<Blob>, options: ImageOptions = {}) {
      const form = new FormData()
      for (const [field, value] of Object.entries({ ...settings(options), n: "1", prompt })) {
        form.append(field, value)
      }
      images.forEach((image, index) => form.append("image[]", image, `image-${index}`))
      return yield* send("edit", HttpClientRequest.post("/v1/images/edits").pipe(HttpClientRequest.bodyFormData(form)))
    })

    return OpenAIImage.of({ generate, edit })
  })

// Needs an HttpClient (FetchHttpClient.layer) and the Keyring the API key is read from.
export const layer = (options: OpenAIImageOptions = {}): Layer.Layer<OpenAIImage, never, HttpClient.HttpClient | Keyring> => Layer.effect(OpenAIImage, make(options))
