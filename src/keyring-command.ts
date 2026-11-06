import { Console, Effect, Redacted } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { ChildProcessSpawner } from "effect/process"
import { type ClipboardError, copyToClipboard } from "./clipboard.ts"
import { exists, generate } from "./credentials/commands.ts"
import type { CredentialsError, Keyring } from "./credentials/keyring.ts"
import { secret } from "./credentials/secret.ts"

// Copies the secret `name` to the clipboard: the environment first, then the keyring, like any app reading it.
const copyKey: (name: string) => Effect.Effect<void, CredentialsError | ClipboardError, Keyring | ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("keyring.cp")(function* copyKey(
  name: string
) {
  const value = yield* secret(name).resolve
  yield* copyToClipboard(Redacted.value(value))
  yield* Console.log(`Copied ${name} to the clipboard`)
})

const nameArgument = Argument.String("name").pipe(Argument.withDescription("Key name, like MY_API_KEY"))

// `elib keyring cp | exists | generate`.
export const keyringCommand = Command.make("keyring").pipe(
  Command.withDescription("Read the vault, then the OS keyring entries shared by effect-lib apps"),
  Command.withSubcommands([
    Command.make("cp", { name: nameArgument }, ({ name }) => copyKey(name)).pipe(Command.withDescription("Copy a key from the keyring to the clipboard")),
    Command.make("exists", { name: nameArgument }, ({ name }) => exists(name)).pipe(
      Command.withDescription("Say whether the keyring has a key, without showing it; fails when it hasn't")
    ),
    Command.make(
      "generate",
      {
        name: nameArgument,
        yes: Flag.Boolean("yes").pipe(Flag.withDefault(false), Flag.withDescription("Replace the key if the keyring already has it")),
      },
      ({ name, yes }) => generate(name, { overwrite: yes })
    ).pipe(Command.withDescription("Store a new random key in the keyring; never replaces one without --yes")),
  ])
)
