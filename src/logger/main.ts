import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Layer } from "effect"
import { layer, type FileLogOptions } from "./file.ts"

// Logs a failure while the file logger is still open, so it reaches the file even when acquiring or releasing a service failed.
export const withLogger = <A, E, R>(effect: Effect.Effect<A, E, R>, options: FileLogOptions) =>
  effect.pipe(
    Effect.tapCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void
      }
      return Effect.logError(cause)
    }),
    Effect.provide(layer(options).pipe(Layer.provide(BunServices.layer)))
  )

// The runtime's own report is off: withLogger has already written the failure to the file.
export const runMain = <A, E, R, E2>(
  effect: Effect.Effect<A, E, R>,
  options: { readonly logger: FileLogOptions; readonly services: Layer.Layer<R, E2> }
): void =>
  BunRuntime.runMain(withLogger(effect.pipe(Effect.provide(options.services)), options.logger), { disableErrorReporting: true })
