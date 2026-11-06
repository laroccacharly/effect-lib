// The vault protocol: a separate process that holds secrets, can be locked, and answers GET /secrets/:name on a Unix socket.
// Read-only on purpose: apps read through it, and only the vault's own commands change what it holds.

import { join } from "node:path"
import { Config, Effect, Option, Schema } from "effect"

export const VaultAnswer = Schema.TaggedUnion({
  found: { value: Schema.String },
  missing: {},
  // The vault holds the secret but is locked; the message says how to unlock it.
  locked: { message: Schema.String },
  failed: { message: Schema.String },
})
export type VaultAnswer = typeof VaultAnswer.Type

export interface VaultOptions {
  // The vault's socket; defaults to $EFFECT_LIB_VAULT, then $XDG_RUNTIME_DIR/effect-lib/vault.sock.
  readonly socket?: string
}

export const secretPath = (name: string) => `/secrets/${encodeURIComponent(name)}`

const defaultSocket = Config.String("EFFECT_LIB_VAULT").pipe(
  Config.orElse(() => Config.String("XDG_RUNTIME_DIR").pipe(Config.map((directory) => join(directory, "effect-lib", "vault.sock"))))
)

// None when neither the options nor the environment name a socket.
export const vaultSocket = (options: VaultOptions = {}) => {
  if (options.socket !== undefined) {
    return Effect.succeedSome(options.socket)
  }
  return Config.option(defaultSocket).pipe(Effect.orElseSucceed(() => Option.none<string>()))
}
