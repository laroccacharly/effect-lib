import { commands, login, logout, status, type LoginOptions } from "./commands.ts"
import { layer, type Keyring } from "./keyring.ts"
import type { SecretEntry } from "./secret.ts"

// An app's secrets, declared once so its commands and Effects cover the same names.
export const make = (secrets: ReadonlyArray<SecretEntry>) => ({
  // Provides the keyring these secrets are read from and written to.
  layer: (keyring: Keyring) => layer(keyring),
  // `auth login | logout | status` plus a top-level `login`; spread into the root command's subcommands.
  commands: commands(secrets),
  login: (options?: LoginOptions) => login(secrets, options),
  logout: logout(secrets),
  status: status(secrets),
})
