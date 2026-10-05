import { Console, Effect, Option, Redacted, type Terminal } from "effect"
import { Command, Flag, Prompt } from "effect/cli"
import { CredentialsError } from "./keyring.ts"
import type { SecretEntry } from "./secret.ts"

export interface LoginOptions {
  // Never prompt: store what the environment has and fail listing the required secrets it lacks.
  readonly fromEnv?: boolean
  // Prompt again for secrets the keyring already has, e.g. to rotate a key.
  readonly force?: boolean
}

const promptFor = (entry: SecretEntry) => {
  const details = [...(entry.label === entry.name ? [] : [entry.name]), ...(entry.optional ? ["empty to skip"] : [])]
  const options = {
    message: details.length === 0 ? entry.label : `${entry.label} (${details.join(", ")})`,
    validate: (value: string) => {
      const trimmed = value.trim()
      if (trimmed === "") {
        return entry.optional ? Effect.succeed("") : Effect.fail("required")
      }
      return entry.validate(trimmed).pipe(Effect.as(trimmed))
    },
  }
  return entry.sensitive ? Prompt.run(Prompt.Password(options)).pipe(Effect.map(Redacted.value)) : Prompt.run(Prompt.String(options))
}

// Stores each secret the environment has, keeps what the keyring already has, and prompts for the rest.
// Without a terminal it behaves as `fromEnv`.
export const login: (secrets: ReadonlyArray<SecretEntry>, options?: LoginOptions) => Effect.Effect<void, CredentialsError | Terminal.QuitError, Prompt.Environment> = Effect.fn(
  "credentials.login"
)(function* login(secrets: ReadonlyArray<SecretEntry>, options: LoginOptions = {}) {
  const interactive = options.fromEnv !== true && process.stdin.isTTY
  const missing: string[] = []
  for (const entry of secrets) {
    const found = yield* entry.lookup
    if (Option.isSome(found) && found.value.source === "env") {
      yield* entry.save(Redacted.value(found.value.text))
      yield* Console.log(`Stored ${entry.name} from the environment`)
    } else if (Option.isSome(found) && options.force !== true) {
      yield* Console.log(`${entry.name} is already stored`)
    } else if (interactive) {
      const text = yield* promptFor(entry)
      if (text === "") {
        yield* Console.log(`Skipped ${entry.name}`)
      } else {
        yield* entry.save(text)
        yield* Console.log(`Stored ${entry.name}`)
      }
    } else if (!entry.optional) {
      missing.push(entry.name)
    }
  }
  if (missing.length > 0) {
    return yield* new CredentialsError({
      name: missing.join(", "),
      reason: "missing",
      message: `not set: ${missing.join(", ")}; export them, or run login in a terminal to be prompted`,
    })
  }
})

// Removes each secret from the keyring. Other apps that declare the same names lose them too.
export const logout: (secrets: ReadonlyArray<SecretEntry>) => Effect.Effect<void, CredentialsError> = Effect.fn("credentials.logout")(function* logout(
  secrets: ReadonlyArray<SecretEntry>
) {
  for (const entry of secrets) {
    const removed = yield* entry.remove
    yield* Console.log(removed ? `Removed ${entry.name}` : `No stored ${entry.name}`)
  }
})

const preview = (entry: SecretEntry, text: string) => {
  if (!entry.sensitive) {
    return text
  }
  return text.length >= 16 ? `${text.slice(0, 4)}…${text.slice(-4)}` : "••••"
}

// Prints where each secret comes from, with a masked preview; a keyring failure is printed, not raised.
export const status: (secrets: ReadonlyArray<SecretEntry>) => Effect.Effect<void> = Effect.fn("credentials.status")(function* status(secrets: ReadonlyArray<SecretEntry>) {
  const width = Math.max(...secrets.map((entry) => entry.name.length))
  for (const entry of secrets) {
    const line = yield* entry.lookup.pipe(
      Effect.map(
        Option.match({
          onNone: () => (entry.optional ? "not set (optional)" : "missing"),
          onSome: ({ source, text }) => `${source.padEnd(7)} ${preview(entry, Redacted.value(text))}`,
        })
      ),
      Effect.catch((error) => Effect.succeed(`error   ${error.message}`))
    )
    yield* Console.log(`${entry.name.padEnd(width)}  ${line}`)
  }
})

const loginCommand = (secrets: ReadonlyArray<SecretEntry>, description: string) =>
  Command.make(
    "login",
    {
      fromEnv: Flag.Boolean("from-env").pipe(Flag.withDefault(false), Flag.withDescription("Never prompt; store only what the environment has")),
      force: Flag.Boolean("force").pipe(Flag.withDefault(false), Flag.withDescription("Prompt again for secrets that are already stored")),
    },
    (options) => login(secrets, options)
  ).pipe(Command.withDescription(description))

// `auth login | logout | status` for these secrets, plus a top-level `login` shortcut for `auth login`.
// Spread both into the root command: `Command.withSubcommands([...commands(secrets), ...])`.
export const commands = (secrets: ReadonlyArray<SecretEntry>) => {
  const names = secrets.map((entry) => entry.name).join(", ")
  const auth = Command.make("auth").pipe(
    Command.withDescription(`Manage ${names}: environment first, then the OS keyring`),
    Command.withSubcommands([
      loginCommand(secrets, `Store ${names} in the OS keyring, from the environment or prompts`),
      Command.make("logout", {}, () => logout(secrets)).pipe(
        Command.withDescription(`Remove ${names} from the OS keyring; other apps using these names lose them too`)
      ),
      Command.make("status", {}, () => status(secrets)).pipe(Command.withDescription(`Show where ${names} come from: environment, keyring or missing`)),
    ])
  )
  return [auth, loginCommand(secrets, "Shortcut for `auth login`")] as const
}
