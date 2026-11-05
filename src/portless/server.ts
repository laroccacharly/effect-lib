import { BunHttpServer } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import { HttpServer } from "effect/http"
import type { SocketAddress } from "effect/net/NetAddress"

export class LocalServer extends Context.Service<LocalServer, {
  readonly address: SocketAddress
  readonly url: string
}>()("effect-lib/portless/LocalServer") {}

// Use a fresh layer per listener: Effect memoizes a shared layer within a scope.
// Provide it to an app, serve with HttpServer, and read LocalServer.url after binding.
export const layer = () =>
  Layer.effect(LocalServer, Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    return LocalServer.of({
      address: server.address,
      url: HttpServer.formatAddress(server.address),
    })
  })).pipe(Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })))
