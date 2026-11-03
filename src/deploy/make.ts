import { Console, Effect, type FileSystem, Option, Redacted } from "effect"
import { Command, Flag } from "effect/cli"
import type { ChildProcessSpawner } from "effect/process"
import type { CredentialsError, Keyring } from "../credentials/keyring.ts"
import { make as makeCredentials } from "../credentials/make.ts"
import type { Secret } from "../credentials/secret.ts"
import { make as makeJsonStore } from "../json-store/index.ts"
import type { JsonStore, JsonStoreError } from "../json-store/store.ts"
import { CloudflareAccountId, cloudflareApiToken, workerUrl } from "./cloudflare.ts"
import { waitForHealth } from "./health.ts"
import { type CommandLine, type DeployError, type Environment, runInTerminal, shellEnvironment } from "./process.ts"
import { type Settings, type SettingsSchema, settingsEnvironment, settingsPath } from "./settings.ts"
import { commitVersion } from "./version.ts"

/** A secret the Worker needs, handed to alchemy as the environment variable of the same name. */
export type AppSecret = Secret<string, string, boolean>

type AppToken = ReturnType<typeof cloudflareApiToken>

type AppUrl = ReturnType<typeof workerUrl>

export interface DeployOptions<S extends Settings> {
  /** The app's name, for ~/.config/<app>/deploy.json. */
  readonly app: string
  /** The name of the Worker's URL, like `PROXY_URL`, read from the environment, then the keyring: an https origin, handed to alchemy like the secrets. `deploy` and `check` wait for its /health to answer the version. */
  readonly url: string
  /** The Worker's secrets, beyond the Cloudflare ones every app shares. */
  readonly secrets?: ReadonlyArray<AppSecret>
  /** The name of the token alchemy gets as CLOUDFLARE_API_TOKEN, read from the environment, then the keyring; WORKER_CLOUDFLARE_API_TOKEN when omitted. */
  readonly cloudflareApiToken?: string
  /** What deploying needs that isn't secret, like the domain; adds `config get | set | unset | list`. */
  readonly settings?: SettingsSchema<S>
  /** Runs before `deploy` and `plan`, like `["bun", "run", "build"]`, with the settings in its environment but no secret. */
  readonly build?: CommandLine
  /** alchemy's `--stage`; alchemy's default when omitted. */
  readonly stage?: string
}

type Services = Keyring | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

interface Environments {
  readonly build: Environment
  readonly alchemy: Environment
}

// An optional secret resolves to an Option, a required one to its value.
const asOption = <A>(resolved: A | Option.Option<A>): Option.Option<A> => {
  if (Option.isOption(resolved)) {
    return resolved
  }
  return Option.some(resolved)
}

const resolveSecret = Effect.fnUntraced(function* resolveSecret(secret: AppSecret) {
  const resolved = yield* secret.resolve
  return Option.map(asOption(resolved), (text): readonly [string, Redacted.Redacted<string>] => [secret.name, text])
})

const appSecretsEnvironment = (secrets: ReadonlyArray<AppSecret>) =>
  Effect.forEach(secrets, resolveSecret).pipe(Effect.map((entries) => Object.fromEntries(entries.flatMap(Option.toArray))))

const cloudflareEnvironment = Effect.fnUntraced(function* cloudflareEnvironment(token: AppToken) {
  return {
    CLOUDFLARE_API_TOKEN: yield* token.resolve,
    CLOUDFLARE_ACCOUNT_ID: Redacted.value(yield* CloudflareAccountId.resolve),
  }
})

const savedSettings = <S extends Settings>(store: Option.Option<JsonStore<S>>) =>
  Option.match(store, { onNone: () => Effect.succeed({}), onSome: settingsEnvironment })

const tokenOf = <S extends Settings>(options: DeployOptions<S>) => cloudflareApiToken(options.cloudflareApiToken)

const urlOf = <S extends Settings>(options: DeployOptions<S>): AppUrl => workerUrl(options.url)

// The url first, once, even when the app lists it among its secrets too.
const appSecrets = <S extends Settings>(options: DeployOptions<S>): ReadonlyArray<AppSecret> => [
  urlOf(options),
  ...(options.secrets ?? []).filter((secret) => secret.name !== options.url),
]

const allSecrets = <S extends Settings>(options: DeployOptions<S>) => [tokenOf(options), CloudflareAccountId, ...appSecrets(options)]

// The build never sees a secret, even one exported in the shell.
const withoutSecrets = <S extends Settings>(env: Readonly<Record<string, string>>, options: DeployOptions<S>) => {
  const names = new Set(allSecrets(options).map((secret) => secret.name))
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.has(name)))
}

// Resolved before building, so a missing secret fails at once. The shell's variables win over the saved settings.
const environments = Effect.fnUntraced(function* environments<S extends Settings>(options: DeployOptions<S>, store: Option.Option<JsonStore<S>>) {
  const settings = yield* savedSettings(store)
  const shell = shellEnvironment()
  const cloudflare = yield* cloudflareEnvironment(tokenOf(options))
  const secrets = yield* appSecretsEnvironment(appSecrets(options))
  return { build: withoutSecrets({ ...settings, ...shell }, options), alchemy: { ...settings, ...shell, ...cloudflare, ...secrets } } satisfies Environments
})

const stageArguments = (stage: Option.Option<string>) => Option.match(stage, { onNone: () => [], onSome: (name) => ["--stage", name] })

const buildIfWired = (build: Option.Option<CommandLine>, env: Environment) => Option.match(build, { onNone: () => Effect.void, onSome: (command) => runInTerminal(command, env) })

const adoptArguments = (adopting: boolean) => {
  if (adopting) {
    return ["--adopt"]
  }
  return []
}

const alchemy = (args: ReadonlyArray<string>, env: Environment) => runInTerminal(["bunx", "alchemy", ...args], env)

type Step = Effect.Effect<void, DeployError | CredentialsError | JsonStoreError, Services>

export const make = <S extends Settings>(options: DeployOptions<S>) => {
  const store = Option.map(Option.fromUndefinedOr(options.settings), (schema) => makeJsonStore(settingsPath(options.app), schema))
  const credentials = makeCredentials(allSecrets(options))
  const stage = stageArguments(Option.fromUndefinedOr(options.stage))

  // Builds, then runs alchemy with the commit as DEPLOY_VERSION, which it returns.
  const buildThenAlchemy = Effect.fnUntraced(function* buildThenAlchemy(args: ReadonlyArray<string>) {
    const env = yield* environments(options, store)
    const version = yield* commitVersion()
    yield* buildIfWired(Option.fromUndefinedOr(options.build), env.build)
    yield* alchemy([...args, ...stage], { ...env.alchemy, DEPLOY_VERSION: version })
    return version
  })

  // Done once the Worker answers the version just deployed.
  const deploy = (adopting: boolean): Step =>
    Effect.gen(function* deploy() {
      const version = yield* buildThenAlchemy(["deploy", "--yes", ...adoptArguments(adopting)])
      yield* waitForHealth(Redacted.value(yield* urlOf(options).resolve), version)
    })

  // Only the url: checking needs no Cloudflare secret, no build and no alchemy.
  const check: Step = Effect.gen(function* check() {
    const version = yield* commitVersion()
    const healthUrl = yield* waitForHealth(Redacted.value(yield* urlOf(options).resolve), version)
    yield* Console.log(`${healthUrl} answers ${version}`)
  })

  // No --yes: alchemy shows what it would delete and asks first.
  const destroy: Step = Effect.gen(function* destroy() {
    const env = yield* environments(options, store)
    yield* alchemy(["destroy", ...stage], env.alchemy)
  })

  const adopt = Flag.Boolean("adopt").pipe(Flag.withDefault(false), Flag.withDescription("Take over resources that already exist on Cloudflare under the same names"))

  const plan = Command.make("plan", { adopt }, (flags): Step => Effect.asVoid(buildThenAlchemy(["plan", ...adoptArguments(flags.adopt)]))).pipe(
    Command.withDescription("Build, then show what deploying would change")
  )
  const checkCommand = Command.make("check", {}, () => check).pipe(
    Command.withDescription("Wait for the Worker's /health to answer this checkout's version, as deploy does after deploying")
  )
  const destroyCommand = Command.make("destroy", {}, () => destroy).pipe(Command.withDescription("Delete the deployed resources, after alchemy asks"))
  const config = Option.match(store, { onNone: () => [], onSome: (settings) => [settings.commands("config")] })

  const command = Command.make("deploy", { adopt }, (flags) => deploy(flags.adopt)).pipe(
    Command.withDescription(`Build ${options.app}, deploy it with alchemy, then wait for its /health to answer the deployed version`),
    Command.withSubcommands([plan, checkCommand, destroyCommand, ...credentials.commands, ...config])
  )

  return { command, credentials }
}

/** Prints a deploy step's failure as one line and exits with 1, rather than a stack trace. */
export const reportFailure = (error: { readonly message: string }) =>
  Console.error(error.message).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1
      })
    )
  )
