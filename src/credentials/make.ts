import { commands, login, logout, status, type LoginOptions } from "./commands.ts"
import { layer, type Keyring } from "./keyring.ts"
import type { SecretEntry } from "./secret.ts"

// An app's secrets, declared once so its keyring layer and its commands cover the same names.
export const make = (secrets: ReadonlyArray<SecretEntry>) => ({
  // Provides `keyring` and makes Config read these secrets from it when the environment lacks them.
  layer: (keyring: Keyring) => layer(keyring, secrets),
  // `auth login | logout | status` plus a top-level `login`; spread into the root command's subcommands.
  commands: commands(secrets),
  login: (options?: LoginOptions) => login(secrets, options),
  logout: logout(secrets),
  status: status(secrets),
})
