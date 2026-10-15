import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { type CredentialsError, Keyring, secret } from "../credentials/index.ts"

export const ORIGIN = "https://api.pushover.net"

// Shared with every app that declares them, so one login is enough.
export const AppToken = secret("PUSH_APP_TOKEN", { label: "Pushover application token" })
export const UserKey = secret("PUSH_USER_KEY", { label: "Pushover user key" })

export interface NotifyOptions {
  // Shown above the message; Pushover falls back to the application name.
  readonly title?: string
}

export class PushError extends Schema.TaggedError<PushError>()("PushError", {
  message: Schema.String,
}) {}

export class Push extends Context.Service<
  Push,
  {
    // Sends a notification. Succeeds once Pushover has accepted it.
    readonly notify: (message: string, options?: NotifyOptions) => Effect.Effect<void, PushError | CredentialsError>
  }
>()("effect-lib/push/Push") {}

const Answer = Schema.Struct({ status: Schema.Int, errors: Schema.optional(Schema.Array(Schema.String)) })
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer))

// Pushover answers `status: 1` when it accepts a message, otherwise its reasons in `errors`.
const checkAnswer = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  // An unreadable body is reported like an unexpected one.
  const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
  const answer = decodeAnswer(text)
  if (response.status >= 200 && response.status < 300 && Option.exists(answer, ({ status }) => status === 1)) {
    return
  }
  const reasons = answer.pipe(
    Option.flatMap(({ errors }) => Option.fromUndefinedOr(errors)),
    Option.match({ onNone: () => text.slice(0, 500), onSome: (errors) => errors.join(", ") })
  )
  return yield* new PushError({ message: `Pushover answered ${response.status}: ${reasons}` })
})

export interface PushOptions {
  // Defaults to ORIGIN; tests point it at a local server.
  readonly origin?: string
}

export const make = (options: PushOptions = {}): Effect.Effect<Push["Service"], never, HttpClient.HttpClient | Keyring> =>
  Effect.gen(function* () {
    const keyring = yield* Keyring
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(options.origin ?? ORIGIN)))

    const notify: (message: string, notifyOptions?: NotifyOptions) => Effect.Effect<void, PushError | CredentialsError> = Effect.fn("Push.notify")(function* notify(
      message: string,
      notifyOptions: NotifyOptions = {}
    ) {
      // Read on every notification, so a rotated key is picked up without a restart.
      const token = yield* AppToken.resolve.pipe(Effect.provideService(Keyring, keyring))
      const user = yield* UserKey.resolve.pipe(Effect.provideService(Keyring, keyring))
      return yield* HttpClientRequest.post("/1/messages.json").pipe(
        HttpClientRequest.bodyJsonUnsafe({ token: Redacted.value(token), user: Redacted.value(user), message, ...notifyOptions }),
        http.execute,
        Effect.mapError((error) => new PushError({ message: `could not reach Pushover: ${error.message}` })),
        Effect.flatMap(checkAnswer)
      )
    })

    return Push.of({ notify })
  })

// Needs an HttpClient (FetchHttpClient.layer) and the Keyring the credentials are read from.
export const layer = (options: PushOptions = {}): Layer.Layer<Push, never, HttpClient.HttpClient | Keyring> => Layer.effect(Push, make(options))
