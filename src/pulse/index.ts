import { hostname } from "node:os"
import { Context, Duration, Effect, Layer, Redacted, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { type CredentialsError, Keyring, secret } from "../credentials/index.ts"

// Where the pulse worker is deployed.
export const ORIGIN = "https://pulse.laroccadev.com"

// Shared with the pulse CLI, so `pulse login` is enough.
export const ApiKey = secret("PULSE_API_KEY", { label: "Pulse API key" })

export class PulseError extends Schema.TaggedError<PulseError>()("PulseError", {
  message: Schema.String,
}) {}

export interface PulseClientOptions {
  // Defaults to ORIGIN; tests point it at a local server.
  readonly origin?: string
}

export class PulseClient extends Context.Service<
  PulseClient,
  {
    // Checks in `host`, this machine's hostname by default. Succeeds when the server answers 2xx.
    readonly ping: (host?: string) => Effect.Effect<void, PulseError | CredentialsError>
  }
>()("effect-lib/pulse/PulseClient") {}

export const make = (options: PulseClientOptions = {}): Effect.Effect<PulseClient["Service"], never, HttpClient.HttpClient | Keyring> =>
  Effect.gen(function* () {
    const keyring = yield* Keyring
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl(options.origin ?? ORIGIN)),
      HttpClient.filterStatusOk
    )

    const ping: (host?: string) => Effect.Effect<void, PulseError | CredentialsError> = Effect.fn("PulseClient.ping")(function* ping(host = hostname()) {
      // Read on every ping, so a rotated key is picked up without a restart.
      const apiKey = yield* ApiKey.resolve.pipe(Effect.provideService(Keyring, keyring))
      return yield* HttpClientRequest.post("/api/ping").pipe(
        HttpClientRequest.bearerToken(Redacted.value(apiKey)),
        HttpClientRequest.bodyJsonUnsafe({ host }),
        http.execute,
        Effect.asVoid,
        Effect.mapError((error) => new PulseError({ message: `could not ping pulse for ${host}: ${error.message}` }))
      )
    })

    return PulseClient.of({ ping })
  })

// Needs an HttpClient (FetchHttpClient.layer) and the Keyring the API key is read from.
export const layer = (options: PulseClientOptions = {}): Layer.Layer<PulseClient, never, HttpClient.HttpClient | Keyring> =>
  Layer.effect(PulseClient, make(options))

export interface HeartbeatOptions extends PulseClientOptions {
  // Defaults to one hour, well under the server's alert delay.
  readonly interval?: Duration.Input
  // Defaults to this machine's hostname.
  readonly host?: string
}

// Pings now and then every `interval` in a background fiber, for as long as the layer is alive.
// A failed ping is logged and retried on the next tick, so it never takes the app down.
export const heartbeat = (options: HeartbeatOptions = {}): Layer.Layer<never, never, HttpClient.HttpClient | Keyring> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const client = yield* make(options)
      yield* client.ping(options.host).pipe(
        Effect.catch((error) => Effect.logWarning(`pulse heartbeat failed: ${error.message}`)),
        Effect.repeat(Schedule.spaced(options.interval ?? Duration.hours(1))),
        Effect.forkScoped
      )
    })
  )
