import { Console, Effect, type FileSystem, Option, Redacted } from "effect"
import { Command, Flag } from "effect/cli"
import type { ChildProcessSpawner } from "effect/process"
import type { CredentialsError, Keyring } from "../credentials/keyring.ts"
import { make as makeCredentials } from "../credentials/make.ts"
import type { Secret } from "../credentials/secret.ts"
import { make as makeJsonStore } from "../json-store/make.ts"
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

type SettingsStore<S extends Settings> = ReturnType<typeof makeJsonStore<S, S>>

// DeployOptions read once: the secrets they name, the settings store, and alchemy's stage arguments.
interface Plan<S extends Settings> {
  readonly app: string
  readonly token: AppToken
  readonly url: AppUrl
  // The url first, once, even when the app lists it among its secrets too.
  readonly appSecrets: ReadonlyArray<AppSecret>
  readonly secretNames: ReadonlySet<string>
  readonly store: Option.Option<SettingsStore<S>>
  readonly stage: ReadonlyArray<string>
  readonly build: Option.Option<CommandLine>
}

const stageArguments = (stage: Option.Option<string>) => Option.match(stage, { onNone: () => [], onSome: (name) => ["--stage", name] })

const planOf = <S extends Settings>(options: DeployOptions<S>): Plan<S> => {
  const token = cloudflareApiToken(options.cloudflareApiToken)
  const url = workerUrl(options.url)
  const appSecrets = [url, ...(options.secrets ?? []).filter((secret) => secret.name !== options.url)]
  return {
    app: options.app,
    token,
    url,
    appSecrets,
    secretNames: new Set([token.name, CloudflareAccountId.name, ...appSecrets.map((secret) => secret.name)]),
    store: Option.map(Option.fromUndefinedOr(options.settings), (schema) => makeJsonStore(settingsPath(options.app), schema)),
    stage: stageArguments(Option.fromUndefinedOr(options.stage)),
    build: Option.fromUndefinedOr(options.build),
  }
}

const allSecrets = <S extends Settings>(plan: Plan<S>) => [plan.token, CloudflareAccountId, ...plan.appSecrets]

// The build never sees a secret, even one exported in the shell.
const withoutSecrets = (env: Readonly<Record<string, string>>, secretNames: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !secretNames.has(name)))

// Resolved before building, so a missing secret fails at once. The shell's variables win over the saved settings.
const environments = Effect.fnUntraced(function* environments<S extends Settings>(plan: Plan<S>) {
  const settings = yield* savedSettings(plan.store)
  const shell = shellEnvironment()
  const cloudflare = yield* cloudflareEnvironment(plan.token)
  const secrets = yield* appSecretsEnvironment(plan.appSecrets)
  return { build: withoutSecrets({ ...settings, ...shell }, plan.secretNames), alchemy: { ...settings, ...shell, ...cloudflare, ...secrets } } satisfies Environments
})

const buildIfWired = (build: Option.Option<CommandLine>, env: Environment) => Option.match(build, { onNone: () => Effect.void, onSome: (command) => runInTerminal(command, env) })

const adoptArguments = (adopting: boolean) => {
  if (adopting) {
    return ["--adopt"]
  }
  return []
}

const alchemy = (args: ReadonlyArray<string>, env: Environment) => runInTerminal(["bunx", "alchemy", ...args], env)

type Step = Effect.Effect<void, DeployError | CredentialsError | JsonStoreError, Services>

// Builds, then runs alchemy with the commit as DEPLOY_VERSION, which it returns.
const buildThenAlchemy = Effect.fnUntraced(function* buildThenAlchemy<S extends Settings>(plan: Plan<S>, args: ReadonlyArray<string>) {
  const env = yield* environments(plan)
  const version = yield* commitVersion()
  yield* buildIfWired(plan.build, env.build)
  yield* alchemy([...args, ...plan.stage], { ...env.alchemy, DEPLOY_VERSION: version })
  return version
})

// Done once the Worker answers the version just deployed.
const deploy = <S extends Settings>(plan: Plan<S>, adopting: boolean): Step =>
  Effect.gen(function* deploy() {
    const version = yield* buildThenAlchemy(plan, ["deploy", "--yes", ...adoptArguments(adopting)])
    yield* waitForHealth(Redacted.value(yield* plan.url.resolve), version)
  })

const showPlan = <S extends Settings>(plan: Plan<S>, adopting: boolean): Step => Effect.asVoid(buildThenAlchemy(plan, ["plan", ...adoptArguments(adopting)]))

// Only the url: checking needs no Cloudflare secret, no build and no alchemy.
const check = <S extends Settings>(plan: Plan<S>): Step =>
  Effect.gen(function* check() {
    const version = yield* commitVersion()
    const healthUrl = yield* waitForHealth(Redacted.value(yield* plan.url.resolve), version)
    yield* Console.log(`${healthUrl} answers ${version}`)
  })

// No --yes: alchemy shows what it would delete and asks first.
const destroy = <S extends Settings>(plan: Plan<S>): Step =>
  Effect.gen(function* destroy() {
    const env = yield* environments(plan)
    yield* alchemy(["destroy", ...plan.stage], env.alchemy)
  })

type Credentials = ReturnType<typeof makeCredentials>

const adoptFlag = Flag.Boolean("adopt").pipe(Flag.withDefault(false), Flag.withDescription("Take over resources that already exist on Cloudflare under the same names"))

const deployCommand = <S extends Settings>(plan: Plan<S>, credentials: Credentials) => {
  const config = Option.match(plan.store, { onNone: () => [], onSome: (settings) => [settings.commands("config")] })
  return Command.make("deploy", { adopt: adoptFlag }, (flags) => deploy(plan, flags.adopt)).pipe(
    Command.withDescription(`Build ${plan.app}, deploy it with alchemy, then wait for its /health to answer the deployed version`),
    Command.withSubcommands([
      Command.make("plan", { adopt: adoptFlag }, (flags) => showPlan(plan, flags.adopt)).pipe(Command.withDescription("Build, then show what deploying would change")),
      Command.make("check", {}, () => check(plan)).pipe(
        Command.withDescription("Wait for the Worker's /health to answer this checkout's version, as deploy does after deploying")
      ),
      Command.make("destroy", {}, () => destroy(plan)).pipe(Command.withDescription("Delete the deployed resources, after alchemy asks")),
      ...credentials.commands,
      ...config,
    ])
  )
}

export const make = <S extends Settings>(options: DeployOptions<S>) => {
  const plan = planOf(options)
  const credentials = makeCredentials(allSecrets(plan))
  return { command: deployCommand(plan, credentials), credentials }
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
