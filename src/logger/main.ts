import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Layer } from "effect"
import { layer, type FileLogOptions } from "./file.ts"

// Report failures while the file logger is still alive, including failures
// acquiring or releasing application services. Preserve the original cause.
export const withLogger = <A, E, R>(effect: Effect.Effect<A, E, R>, options: FileLogOptions) =>
  effect.pipe(
    Effect.tapCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      return Effect.logError(cause)
    }),
    Effect.provide(layer(options).pipe(Layer.provide(BunServices.layer)))
  )

// Both the logger configuration and application dependencies are explicit.
// Disable the runtime's later report: our report is already flushed to disk.
export const runMain = <A, E, R, E2>(
  effect: Effect.Effect<A, E, R>,
  options: { readonly logger: FileLogOptions; readonly services: Layer.Layer<R, E2> }
): void =>
  BunRuntime.runMain(withLogger(effect.pipe(Effect.provide(options.services)), options.logger), { disableErrorReporting: true })
