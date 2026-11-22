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
  /** The name of the Worker's URL, like `PROXY_URL`, read from the environment, then the keyring: an https origin, handed to alchemy like the secrets. `deploy` and `check` wait for its /health to answer the version. When omitted, as for an app whose address is an output of the stack, `deploy` waits for no /health and there is no `check`: the stack waits for its app itself. */
  readonly url?: string
  /** The Worker's secrets, beyond the Cloudflare ones every app shares. */
  readonly secrets?: ReadonlyArray<AppSecret>
  /** The name of the token alchemy gets as CLOUDFLARE_API_TOKEN, read from the environment, then the keyring; WORKER_CLOUDFLARE_API_TOKEN when omitted. */
  readonly cloudflareApiToken?: string
  /** False for an app deployed somewhere other than Cloudflare: alchemy gets no CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID, and none is asked for. True when omitted. */
  readonly cloudflare?: boolean
  /** What deploying needs that isn't secret, like the domain; adds `config get | set | unset | list`. */
  readonly settings?: SettingsSchema<S>
  /** Runs before `deploy` and `plan`, like `["bun", "run", "build"]`, with the settings and the non-sensitive secrets, such as the url, in its environment but no sensitive one. */
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

const cloudflareEnvironment = Effect.fnUntraced(function* cloudflareEnvironment(token: Option.Option<AppToken>): Effect.fn.Return<Environment, CredentialsError, Keyring> {
  if (Option.isNone(token)) {
    return {}
  }
  return {
    CLOUDFLARE_API_TOKEN: yield* token.value.resolve,
    CLOUDFLARE_ACCOUNT_ID: Redacted.value(yield* CloudflareAccountId.resolve),
  }
})

const savedSettings = <S extends Settings>(store: Option.Option<JsonStore<S>>) =>
  Option.match(store, { onNone: () => Effect.succeed({}), onSome: settingsEnvironment })

type SettingsStore<S extends Settings> = ReturnType<typeof makeJsonStore<S, S>>

// DeployOptions read once: the secrets they name, the settings store, and alchemy's stage arguments.
interface Plan<S extends Settings> {
  readonly app: string
  // None when the app does not deploy to Cloudflare.
  readonly token: Option.Option<AppToken>
  readonly url: Option.Option<AppUrl>
  // The url first, once, even when the app lists it among its secrets too.
  readonly appSecrets: ReadonlyArray<AppSecret>
  readonly secretNames: ReadonlySet<string>
  // The secrets marked `sensitive: false`, which the build gets as alchemy does.
  readonly publicNames: ReadonlySet<string>
  readonly store: Option.Option<SettingsStore<S>>
  readonly stage: ReadonlyArray<string>
  readonly build: Option.Option<CommandLine>
}

const stageArguments = (stage: Option.Option<string>) => Option.match(stage, { onNone: () => [], onSome: (name) => ["--stage", name] })

const cloudflareTokenOf = <S extends Settings>(options: DeployOptions<S>) => {
  if (options.cloudflare === false) {
    return Option.none<AppToken>()
  }
  return Option.some(cloudflareApiToken(options.cloudflareApiToken))
}

const cloudflareSecrets = (token: Option.Option<AppToken>): ReadonlyArray<AppSecret> => Option.match(token, { onNone: () => [], onSome: (value) => [value, CloudflareAccountId] })

const planOf = <S extends Settings>(options: DeployOptions<S>): Plan<S> => {
  const token = cloudflareTokenOf(options)
  const url = Option.map(Option.fromUndefinedOr(options.url), workerUrl)
  const appSecrets = [...Option.toArray(url), ...(options.secrets ?? []).filter((secret) => secret.name !== options.url)]
  const every = [...cloudflareSecrets(token), ...appSecrets]
  return {
    app: options.app,
    token,
    url,
    appSecrets,
    secretNames: new Set(every.map((secret) => secret.name)),
    publicNames: new Set(every.filter((secret) => !secret.sensitive).map((secret) => secret.name)),
    store: Option.map(Option.fromUndefinedOr(options.settings), (schema) => makeJsonStore(settingsPath(options.app), schema)),
    stage: stageArguments(Option.fromUndefinedOr(options.stage)),
    build: Option.fromUndefinedOr(options.build),
  }
}

const allSecrets = <S extends Settings>(plan: Plan<S>) => [...cloudflareSecrets(plan.token), ...plan.appSecrets]

const withoutSecrets = (env: Readonly<Record<string, string>>, secretNames: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !secretNames.has(name)))

const onlyNamed = (env: Environment, names: ReadonlySet<string>) => Object.fromEntries(Object.entries(env).filter(([name]) => names.has(name)))

// The build never sees a sensitive secret, even one exported in the shell, and sees the non-sensitive ones with the
// values alchemy gets, so both agree on, say, the url.
const buildEnvironment = <S extends Settings>(plan: Plan<S>, env: Readonly<Record<string, string>>, resolved: Environment) => ({
  ...withoutSecrets(env, plan.secretNames),
  ...onlyNamed(resolved, plan.publicNames),
})

// Resolved before building, so a missing secret fails at once. The shell's variables win over the saved settings.
const environments = Effect.fnUntraced(function* environments<S extends Settings>(plan: Plan<S>) {
  const settings = yield* savedSettings(plan.store)
  const shell = shellEnvironment()
  const cloudflare = yield* cloudflareEnvironment(plan.token)
  const secrets = yield* appSecretsEnvironment(plan.appSecrets)
  const resolved = { ...cloudflare, ...secrets }
  return { build: buildEnvironment(plan, { ...settings, ...shell }, resolved), alchemy: { ...settings, ...shell, ...resolved } } satisfies Environments
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

// Done once the Worker answers the version just deployed; without a url, once alchemy is.
const deploy = <S extends Settings>(plan: Plan<S>, adopting: boolean): Step =>
  Effect.gen(function* deploy() {
    const version = yield* buildThenAlchemy(plan, ["deploy", "--yes", ...adoptArguments(adopting)])
    if (Option.isNone(plan.url)) {
      return
    }
    yield* waitForHealth(Redacted.value(yield* plan.url.value.resolve), version)
  })

const showPlan = <S extends Settings>(plan: Plan<S>, adopting: boolean): Step => Effect.asVoid(buildThenAlchemy(plan, ["plan", ...adoptArguments(adopting)]))

// Only the url: checking needs no Cloudflare secret, no build and no alchemy.
const check = (url: AppUrl): Step =>
  Effect.gen(function* check() {
    const version = yield* commitVersion()
    const healthUrl = yield* waitForHealth(Redacted.value(yield* url.resolve), version)
    yield* Console.log(`${healthUrl} answers ${version}`)
  })

// No --yes: alchemy shows what it would delete and asks first.
const destroy = <S extends Settings>(plan: Plan<S>): Step =>
  Effect.gen(function* destroy() {
    const env = yield* environments(plan)
    yield* alchemy(["destroy", ...plan.stage], env.alchemy)
  })

type Credentials = ReturnType<typeof makeCredentials>

const deployDescription = <S extends Settings>(plan: Plan<S>) => {
  if (Option.isNone(plan.url)) {
    return `Build ${plan.app}, then deploy it with alchemy`
  }
  return `Build ${plan.app}, deploy it with alchemy, then wait for its /health to answer the deployed version`
}

const checkCommands = (url: Option.Option<AppUrl>) =>
  Option.match(url, {
    onNone: () => [],
    onSome: (value) => [
      Command.make("check", {}, () => check(value)).pipe(Command.withDescription("Wait for the Worker's /health to answer this checkout's version, as deploy does after deploying")),
    ],
  })

const adoptFlag = Flag.Boolean("adopt").pipe(Flag.withDefault(false), Flag.withDescription("Take over resources that already exist under the same names"))

const deployCommand = <S extends Settings>(plan: Plan<S>, credentials: Credentials) => {
  const config = Option.match(plan.store, { onNone: () => [], onSome: (settings) => [settings.commands("config")] })
  return Command.make("deploy", { adopt: adoptFlag }, (flags) => deploy(plan, flags.adopt)).pipe(
    Command.withDescription(deployDescription(plan)),
    Command.withSubcommands([
      Command.make("plan", { adopt: adoptFlag }, (flags) => showPlan(plan, flags.adopt)).pipe(Command.withDescription("Build, then show what deploying would change")),
      ...checkCommands(plan.url),
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
