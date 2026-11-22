import { Console, Effect, type FileSystem, Option, Redacted } from "effect"
import { Command, Flag } from "effect/cli"
import type { ChildProcessSpawner } from "effect/process"
import type { CredentialsError, Keyring } from "../credentials/keyring.ts"
import { make as makeCredentials } from "../credentials/make.ts"
import type { Secret } from "../credentials/secret.ts"
import { make as makeJsonStore } from "../json-store/make.ts"
import type { JsonStore, JsonStoreError } from "../json-store/store.ts"
import { type CommandLine, type DeployError, type Environment, runInTerminal, shellEnvironment } from "./process.ts"
import { type Settings, type SettingsSchema, settingsEnvironment, settingsPath } from "./settings.ts"
import { commitVersion } from "./version.ts"

/** A credential managed by the deploy CLI. */
export type AppSecret = Secret<string, string, boolean>

export interface Verification {
  readonly secrets?: ReadonlyArray<AppSecret>
  readonly wait: (input: { readonly version: string }) => Effect.Effect<void, DeployError | CredentialsError, Keyring>
}

export interface DeployOptions<S extends Settings> {
  /** The app's name, for ~/.config/<app>/deploy.json. */
  readonly app: string
  /** What alchemy needs, each passed as its `exportAs`. Use an empty list when it needs none. */
  readonly secrets: ReadonlyArray<AppSecret>
  /** Runs after a successful deploy and enables the standalone check command. */
  readonly verification?: Verification
  /** What deploying needs that isn't secret, like the domain; adds `config get | set | unset | list`. */
  readonly settings?: SettingsSchema<S>
  /** Runs before `deploy` and `plan`, like `["bun", "run", "build"]`, with the settings and the non-sensitive secrets, such as the url, in its environment but no sensitive one. */
  readonly build?: CommandLine
  /** Checks run in order before `deploy` and `plan`, like `[["bun", "run", "lint"], ["bun", "test"]]`; the first that exits non-zero stops the deploy. They run before secrets are resolved, in the build's environment without them. */
  readonly preflight?: ReadonlyArray<CommandLine>
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
  return Option.map(asOption(resolved), (text): readonly [string, Redacted.Redacted<string>] => [secret.exportAs, text])
})

const secretsEnvironment = (secrets: ReadonlyArray<AppSecret>) =>
  Effect.forEach(secrets, resolveSecret).pipe(Effect.map((entries) => Object.fromEntries(entries.flatMap(Option.toArray))))

const savedSettings = <S extends Settings>(store: Option.Option<JsonStore<S>>) =>
  Option.match(store, { onNone: () => Effect.succeed({}), onSome: settingsEnvironment })

type SettingsStore<S extends Settings> = ReturnType<typeof makeJsonStore<S, S>>

// DeployOptions read once: the secrets they name, the settings store, and alchemy's stage arguments.
interface Plan<S extends Settings> {
  readonly app: string
  readonly secrets: ReadonlyArray<AppSecret>
  readonly verification: Option.Option<Verification>
  readonly boundNames: ReadonlySet<string>
  readonly sensitiveNames: ReadonlySet<string>
  readonly publicNames: ReadonlySet<string>
  readonly store: Option.Option<SettingsStore<S>>
  readonly stage: ReadonlyArray<string>
  readonly build: Option.Option<CommandLine>
  readonly preflight: ReadonlyArray<CommandLine>
}

const stageArguments = (stage: Option.Option<string>) => Option.match(stage, { onNone: () => [], onSome: (name) => ["--stage", name] })

const planOf = <S extends Settings>(options: DeployOptions<S>): Plan<S> => {
  const secrets = [...options.secrets, ...(options.verification?.secrets ?? [])]
  const sensitiveNames = new Set(secrets.filter((secret) => secret.sensitive).flatMap((secret) => [secret.name, secret.exportAs]))
  return {
    app: options.app,
    secrets,
    verification: Option.fromUndefinedOr(options.verification),
    boundNames: new Set(secrets.map((secret) => secret.exportAs)),
    sensitiveNames,
    publicNames: new Set(secrets.map((secret) => secret.exportAs).filter((name) => !sensitiveNames.has(name))),
    store: Option.map(Option.fromUndefinedOr(options.settings), (schema) => makeJsonStore(settingsPath(options.app), schema)),
    stage: stageArguments(Option.fromUndefinedOr(options.stage)),
    build: Option.fromUndefinedOr(options.build),
    preflight: options.preflight ?? [],
  }
}

const withoutSecrets = (env: Readonly<Record<string, string>>, secretNames: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !secretNames.has(name)))

const onlyNamed = (env: Environment, names: ReadonlySet<string>) => Object.fromEntries(Object.entries(env).filter(([name]) => names.has(name)))

// The build never sees a sensitive secret, even one exported in the shell, and sees the non-sensitive ones with the
// values alchemy gets, so both agree on, say, the url.
const buildEnvironment = <S extends Settings>(plan: Plan<S>, env: Readonly<Record<string, string>>, resolved: Environment) => ({
  ...withoutSecrets(withoutSecrets(env, plan.boundNames), plan.sensitiveNames),
  ...onlyNamed(resolved, plan.publicNames),
})

// Resolved before building, so a missing secret fails at once. The shell's variables win over the saved settings.
const environments = Effect.fnUntraced(function* environments<S extends Settings>(plan: Plan<S>) {
  const settings = yield* savedSettings(plan.store)
  const shell = shellEnvironment()
  const resolved = yield* secretsEnvironment(plan.secrets)
  return { build: buildEnvironment(plan, { ...settings, ...shell }, resolved), alchemy: { ...withoutSecrets({ ...settings, ...shell }, plan.boundNames), ...resolved } } satisfies Environments
})

const buildIfWired = (build: Option.Option<CommandLine>, env: Environment) => Option.match(build, { onNone: () => Effect.void, onSome: (command) => runInTerminal(command, env) })

// The build's environment before any secret is resolved: checks like lint and tests need none.
const runPreflight = <S extends Settings>(plan: Plan<S>) =>
  Effect.forEach(plan.preflight, (command) => runInTerminal(command, buildEnvironment(plan, shellEnvironment(), {})), { discard: true })

const adoptArguments = (adopting: boolean) => {
  if (adopting) {
    return ["--adopt"]
  }
  return []
}

const alchemy = (args: ReadonlyArray<string>, env: Environment) => runInTerminal(["bunx", "alchemy", ...args], env)

type Step = Effect.Effect<void, DeployError | CredentialsError | JsonStoreError, Services>

// Runs the preflight checks first, so a failing one stops before the vault is unlocked or anything is built.
// Then builds and runs alchemy with the commit as DEPLOY_VERSION, which it returns.
const buildThenAlchemy = Effect.fnUntraced(function* buildThenAlchemy<S extends Settings>(plan: Plan<S>, args: ReadonlyArray<string>) {
  yield* runPreflight(plan)
  const env = yield* environments(plan)
  const version = yield* commitVersion()
  yield* buildIfWired(plan.build, env.build)
  yield* alchemy([...args, ...plan.stage], { ...env.alchemy, DEPLOY_VERSION: version })
  return version
})

const deploy = <S extends Settings>(plan: Plan<S>, adopting: boolean): Step =>
  Effect.gen(function* deploy() {
    const version = yield* buildThenAlchemy(plan, ["deploy", "--yes", ...adoptArguments(adopting)])
    yield* Option.match(plan.verification, { onNone: () => Effect.void, onSome: ({ wait }) => wait({ version }) })
  })

const showPlan = <S extends Settings>(plan: Plan<S>, adopting: boolean): Step => Effect.asVoid(buildThenAlchemy(plan, ["plan", ...adoptArguments(adopting)]))

const check = ({ wait }: Verification): Step => commitVersion().pipe(Effect.flatMap((version) => wait({ version })))

// No --yes: alchemy shows what it would delete and asks first.
const destroy = <S extends Settings>(plan: Plan<S>): Step =>
  Effect.gen(function* destroy() {
    const env = yield* environments(plan)
    yield* alchemy(["destroy", ...plan.stage], env.alchemy)
  })

type Credentials = ReturnType<typeof makeCredentials>

const deployDescription = <S extends Settings>(plan: Plan<S>) => {
  const description = `Build ${plan.app}, then deploy it with alchemy`
  if (Option.isNone(plan.verification)) {
    return description
  }
  return `${description} and verify readiness`
}

const checkCommands = (verification: Option.Option<Verification>) =>
  Option.match(verification, {
    onNone: () => [],
    onSome: (value) => [
      Command.make("check", {}, () => check(value)).pipe(Command.withDescription("Verify that the deployed app is ready for this checkout's version")),
    ],
  })

const adoptFlag = Flag.Boolean("adopt").pipe(Flag.withDefault(false), Flag.withDescription("Take over resources that already exist under the same names"))

const deployCommand = <S extends Settings>(plan: Plan<S>, credentials: Credentials) => {
  const config = Option.match(plan.store, { onNone: () => [], onSome: (settings) => [settings.commands("config")] })
  return Command.make("deploy", { adopt: adoptFlag }, (flags) => deploy(plan, flags.adopt)).pipe(
    Command.withDescription(deployDescription(plan)),
    Command.withSubcommands([
      Command.make("plan", { adopt: adoptFlag }, (flags) => showPlan(plan, flags.adopt)).pipe(Command.withDescription("Build, then show what deploying would change")),
      ...checkCommands(plan.verification),
      Command.make("destroy", {}, () => destroy(plan)).pipe(Command.withDescription("Delete the deployed resources, after alchemy asks")),
      ...credentials.commands,
      ...config,
    ])
  )
}

const validateOptions = (options: object) => {
  const removed = ["url", "credentials", "cloudflare", "cloudflareApiToken"].filter((name) => Object.hasOwn(options, name))
  if (removed.length > 0) {
    throw new TypeError(`Removed deploy options: ${removed.join(", ")}. Use secrets and verification instead, with exportAs on a secret alchemy reads under another name. For Workers, use Deploy.Cloudflare.deploySecrets() and Deploy.Cloudflare.workerHealth(urlName).`)
  }
  // A verifier written for the old API would otherwise lose its secrets silently.
  if ("verification" in options && typeof options.verification === "object" && options.verification !== null && Object.hasOwn(options.verification, "credentials")) {
    throw new TypeError("Removed verification option: credentials. Use secrets instead.")
  }
  if (!("secrets" in options) || !Array.isArray(options.secrets)) {
    throw new TypeError("Declare deploy secrets explicitly: use secrets: [] for none or Deploy.Cloudflare.deploySecrets() for Workers.")
  }
}

const declaredSecrets = (secrets: ReadonlyArray<AppSecret>): ReadonlyArray<AppSecret> => {
  const sources = new Map<string, AppSecret>()
  const destinations = new Map<string, AppSecret>()
  for (const secret of secrets) {
    const name = secret.exportAs
    const source = sources.get(secret.name)
    const destination = destinations.get(name)
    if (source !== undefined && source !== secret) {
      throw new TypeError(`Conflicting definitions for deploy secret ${secret.name}. Reuse the same credential declaration.`)
    }
    if (destination !== undefined && destination !== secret) {
      throw new TypeError(`Multiple deploy secrets export as ${name}.`)
    }
    sources.set(secret.name, secret)
    destinations.set(name, secret)
  }
  return [...sources.values()]
}

export const make = <S extends Settings>(options: DeployOptions<S>) => {
  validateOptions(options)
  const plan = planOf(options)
  const credentials = makeCredentials(declaredSecrets(plan.secrets))
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
