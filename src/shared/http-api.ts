import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { type CredentialsError, Keyring } from "../credentials/keyring.ts"

const ErrorBody = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }))

export const isOk = (response: HttpClientResponse.HttpClientResponse) => response.status >= 200 && response.status < 300

// The `{ "error": { "message" } }` OpenAI and OpenRouter send; the start of the body otherwise.
export const errorMessage = (body: string) =>
  Schema.decodeOption(ErrorBody)(body).pipe(Option.match({ onNone: () => body.slice(0, 500), onSome: ({ error }) => error.message }))

/**
 * An HttpClient sending to `origin`, and `resolve`, which reads a secret from the keyring captured here. Read it on every
 * request, so a rotated key is picked up without a restart.
 */
export const apiClient = Effect.fnUntraced(function* apiClient(origin: string) {
  const keyring = yield* Keyring
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(origin)))
  const resolve = <A>(secret: { readonly resolve: Effect.Effect<A, CredentialsError, Keyring> }) => secret.resolve.pipe(Effect.provideService(Keyring, keyring))
  return { http, resolve }
})
