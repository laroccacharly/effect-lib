// The serving side of the vault protocol, for the process that holds the vault.

import { Effect, Layer, Option, Schema } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { socketServer } from "../../shared/socket-server.ts"
import { CredentialsError } from "../keyring.ts"
import { VaultAnswer, type VaultOptions, vaultSocket } from "./protocol.ts"

const SECRET_PATH = /^\/secrets\/([^/]+)$/u

const encodeAnswer = Schema.encodeSync(VaultAnswer)

const nameOf = (url: string) => Option.fromNullishOr(SECRET_PATH.exec(new URL(url, "http://vault").pathname)?.[1]).pipe(Option.map(decodeURIComponent))

const answer = <R>(lookup: (name: string) => Effect.Effect<VaultAnswer, CredentialsError, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const name = nameOf(request.url)
    if (request.method !== "GET" || Option.isNone(name)) {
      return HttpServerResponse.text("Not found", { status: 404 })
    }
    const found = yield* lookup(name.value).pipe(Effect.catch((error) => Effect.succeed(VaultAnswer.cases.failed.make({ message: error.message }))))
    return HttpServerResponse.jsonUnsafe(encodeAnswer(found))
  })

const noSocket = new CredentialsError({ name: "vault", reason: "keyring", message: "no socket for the vault: set XDG_RUNTIME_DIR or EFFECT_LIB_VAULT" })

// Answers GET /secrets/:name with `lookup` on the vault's socket, for as long as the layer lives.
export const vaultServer = <R>(lookup: (name: string) => Effect.Effect<VaultAnswer, CredentialsError, R>, options: VaultOptions = {}) =>
  Layer.unwrap(
    vaultSocket(options).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(noSocket), onSome: Effect.succeed })),
      Effect.map((socket) => HttpServer.serve(answer(lookup)).pipe(Layer.provide(socketServer(socket))))
    )
  )
