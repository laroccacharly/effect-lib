import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { type CredentialsError, Keyring, secret } from "../credentials/index.ts"

export const ORIGIN = "https://openrouter.ai"
// Takes the WebM and MP4 browsers record as-is.
export const MODEL = "elevenlabs/scribe-v2"

// Shared with every app that declares OPENROUTER_API_KEY, so one login is enough.
export const ApiKey = secret("OPENROUTER_API_KEY", { label: "OpenRouter API key" })

const FORMATS: Readonly<Record<string, string>> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
  "video/webm": "webm",
}

// The format name OpenRouter expects for a MIME type such as "audio/webm;codecs=opus"; none when unknown.
export const formatOf = (mimeType: string): Option.Option<string> =>
  Option.fromUndefinedOr(FORMATS[mimeType.split(";")[0]?.trim().toLowerCase() ?? ""])

export interface TranscribeOptions {
  // Defaults to the service's model.
  readonly model?: string
  // Defaults to the format of the audio's MIME type.
  readonly format?: string
  // ISO-639-1 code such as "en"; detected when omitted.
  readonly language?: string
  // Names and terms to bias recognition toward; models that cannot use them reject the request.
  readonly keyterms?: ReadonlyArray<string>
  readonly provider?: ProviderOptions
}

// OpenRouter's `provider` field: data policy routing and options forwarded to the matched provider.
export interface ProviderOptions {
  readonly zdr?: boolean
  readonly data_collection?: "allow" | "deny"
  // Keyed by provider slug, e.g. `{ azure: { enhancedMode: { modelOptions: { transcribeStyle: "clean" } } } }`.
  readonly options?: Readonly<Record<string, object>>
}

export class SttError extends Schema.TaggedError<SttError>()("SttError", {
  message: Schema.String,
}) {}

export class Stt extends Context.Service<
  Stt,
  {
    // The text spoken in the audio, e.g. `Bun.file(path)` or a recorded Blob.
    readonly transcribe: (audio: Blob, options?: TranscribeOptions) => Effect.Effect<string, SttError | CredentialsError>
  }
>()("effect-lib/stt/Stt") {}

const Transcript = Schema.Struct({ text: Schema.String })
const ErrorBody = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }))

// The transcript of a 2xx response; otherwise fails with OpenRouter's error message when it sends one.
const decodeTranscript = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  if (response.status < 200 || response.status >= 300) {
    const text = yield* response.text
    const message = Schema.decodeOption(ErrorBody)(text).pipe(
      Option.match({ onNone: () => text.slice(0, 500), onSome: (body) => body.error.message })
    )
    return yield* new SttError({ message: `OpenRouter answered ${response.status}: ${message}` })
  }
  const transcript = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Transcript)))
  return transcript.text
})

export interface SttOptions {
  // Defaults to ORIGIN; tests point it at a local server.
  readonly origin?: string
  // Defaults to MODEL.
  readonly model?: string
  // The app name OpenRouter shows in its activity log, sent as X-OpenRouter-Title.
  readonly title?: string
}

export const make = (options: SttOptions = {}): Effect.Effect<Stt["Service"], never, HttpClient.HttpClient | Keyring> =>
  Effect.gen(function* () {
    const keyring = yield* Keyring
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(options.origin ?? ORIGIN)))

    const transcribe: (audio: Blob, transcribeOptions?: TranscribeOptions) => Effect.Effect<string, SttError | CredentialsError> = Effect.fn("Stt.transcribe")(function* transcribe(
      audio: Blob,
      transcribeOptions: TranscribeOptions = {}
    ) {
      const { model = options.model ?? MODEL, format: explicit, ...rest } = transcribeOptions
      const format = yield* Effect.fromOption(Option.orElse(Option.fromUndefinedOr(explicit), () => formatOf(audio.type))).pipe(
        Effect.mapError(() => new SttError({ message: `unknown audio format "${audio.type}"; pass the format option` }))
      )
      // Read on every request, so a rotated key is picked up without a restart.
      const key = yield* ApiKey.resolve.pipe(Effect.provideService(Keyring, keyring))
      const data = yield* Effect.tryPromise({
        try: async () => Buffer.from(await audio.arrayBuffer()).toString("base64"),
        catch: (cause) => new SttError({ message: `could not read the audio: ${String(cause)}` }),
      })
      return yield* HttpClientRequest.post("/api/v1/audio/transcriptions").pipe(
        HttpClientRequest.bearerToken(Redacted.value(key)),
        HttpClientRequest.setHeaders(Option.match(Option.fromUndefinedOr(options.title), { onNone: () => ({}), onSome: (title) => ({ "X-OpenRouter-Title": title }) })),
        HttpClientRequest.bodyJsonUnsafe({ model, input_audio: { data, format }, ...rest }),
        http.execute,
        Effect.flatMap(decodeTranscript),
        Effect.catchTags({
          HttpClientError: (error) => Effect.fail(new SttError({ message: `could not transcribe the audio (${format}, ${model}): ${error.message}` })),
          SchemaError: (error) => Effect.fail(new SttError({ message: `unexpected answer from OpenRouter: ${error.message}` })),
        })
      )
    })

    return Stt.of({ transcribe })
  })

// Needs an HttpClient (FetchHttpClient.layer) and the Keyring the API key is read from.
export const layer = (options: SttOptions = {}): Layer.Layer<Stt, never, HttpClient.HttpClient | Keyring> => Layer.effect(Stt, make(options))
