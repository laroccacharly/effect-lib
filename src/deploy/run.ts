import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { defaultKeyring } from "../credentials/vault/client.ts"
import { type DeployOptions, make, reportFailure } from "./make.ts"
import type { Settings } from "./settings.ts"

/** Runs `bun run deploy` from the command line, with the vault, then the OS keyring: the whole body of an app's deploy script. */
export const run = <S extends Settings>(options: DeployOptions<S>, { version }: { readonly version: string }) => {
  const deploy = make(options)
  Command.run(deploy.command, { version }).pipe(
    Effect.catchTags({ DeployError: reportFailure, CredentialsError: reportFailure, JsonStoreError: reportFailure }),
    Effect.provide(Layer.mergeAll(BunServices.layer, deploy.credentials.layer(defaultKeyring()))),
    BunRuntime.runMain
  )
}
