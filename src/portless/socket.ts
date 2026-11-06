import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"

export class SocketServerError extends Schema.TaggedError<SocketServerError>()("SocketServerError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const failure = (path: string, action: string) => <C>(cause: C) => new SocketServerError({ path, message: `could not ${action} ${path}: ${String(cause)}` })

const answers = (path: string) => Effect.tryPromise(async () => await fetch("http://socket/", { unix: path })).pipe(Effect.isSuccess)

// A socket file nothing answers on is left over from a crash, and replaced. Directories it creates are the user's alone.
const claim = (path: string) =>
  Effect.gen(function* () {
    if (yield* answers(path)) {
      return yield* new SocketServerError({ path, message: `another server already answers on ${path}` })
    }
    yield* Effect.try({
      try: () => {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        rmSync(path, { force: true })
      },
      catch: failure(path, "prepare"),
    })
  })

const inodeOf = (path: string) => statSync(path, { throwIfNoEntry: false })?.ino

// Only the user may connect; on close, the socket is removed unless another server has replaced it since.
const own = (path: string) =>
  Effect.gen(function* () {
    const inode = yield* Effect.try({
      try: () => {
        chmodSync(path, 0o600)
        return inodeOf(path)
      },
      catch: failure(path, "restrict"),
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (inodeOf(path) === inode) {
          rmSync(path, { force: true })
        }
      })
    )
  })

// An HttpServer on the Unix socket at `path`, which only this user can connect to.
export const socketServer = (path: string) => Layer.unwrap(claim(path).pipe(Effect.as(BunHttpServer.layer({ unix: path }).pipe(Layer.tap(() => own(path))))))
