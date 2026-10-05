import { ConfigProvider, Context, type Duration, Effect, Layer, Option, Schedule, Schema } from "effect"

// One service for every app, so apps that declare the same secret name share the stored value.
export const SERVICE = "effect-lib/credentials"

export class CredentialsError extends Schema.TaggedError<CredentialsError>()("CredentialsError", {
  name: Schema.String,
  // missing: login found neither the environment nor a terminal; invalid: does not match the schema; keyring: the OS keyring failed.
  reason: Schema.Literals(["missing", "invalid", "keyring"]),
  message: Schema.String,
}) {}

// Raw keyring access, one entry per name; get is none when the entry does not exist.
export interface Keyring {
  readonly get: (name: string) => Effect.Effect<Option.Option<string>, CredentialsError>
  readonly set: (name: string, value: string) => Effect.Effect<void, CredentialsError>
  // False when there was nothing to remove.
  readonly remove: (name: string) => Effect.Effect<boolean, CredentialsError>
}

// A way to reach the keyring; recovery tries each in order.
export interface Backend {
  readonly get: (name: string) => Promise<string | null>
  readonly set: (name: string, value: string) => Promise<void>
  readonly remove: (name: string) => Promise<boolean>
}

// Bun.secrets in this process. Its connection goes stale when the keyring daemon restarts.
export const inProcess = (service: string): Backend => ({
  get: async (name) => await Bun.secrets.get({ service, name }),
  set: async (name, value) => {
    await Bun.secrets.set({ service, name, value })
  },
  remove: async (name) => await Bun.secrets.delete({ service, name }),
})

const freshScript = `
const { op, service, name, value } = await Bun.stdin.json()
const result = op === "get" ? await Bun.secrets.get({ service, name }) : op === "set" ? await Bun.secrets.set({ service, name, value }) : await Bun.secrets.delete({ service, name })
process.stdout.write(JSON.stringify(result ?? null))
`

const fresh = async <A, I>(schema: Schema.Codec<A, I>, request: { readonly op: string; readonly service: string; readonly name: string; readonly value?: string }) => {
  // BUN_BE_BUN makes a `bun build --compile` binary act as bun. The request goes over stdin, so a value never shows in argv.
  const child = Bun.spawn([process.execPath, "-e", freshScript], {
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) {
    throw new Error(stderr.trim() || `keyring subprocess exited with ${code}`)
  }
  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(stdout)
}

// Bun.secrets in a new process, which opens a new keyring connection.
export const freshProcess = (service: string): Backend => ({
  get: async (name) => await fresh(Schema.NullOr(Schema.String), { op: "get", service, name }),
  set: async (name, value) => {
    await fresh(Schema.Null, { op: "set", service, name, value })
  },
  remove: async (name) => await fresh(Schema.Boolean, { op: "delete", service, name }),
})

const describe = <C>(cause: C) => (cause instanceof Error ? cause.message : String(cause))

export interface RecoveryOptions {
  // Retries back off exponentially from `retryDelay`; the defaults, 3 from 200ms, wait about 1.4s in total,
  // enough for a restarted keyring daemon to come back.
  readonly retryDelay?: Duration.Input
  readonly retryTimes?: number
}

// Tries each backend in order, then retries the whole sequence on the schedule.
export const fromBackends = (backends: ReadonlyArray<Backend>, options: RecoveryOptions = {}): Keyring => {
  const attempt = <A>(name: string, action: string, run: (backend: Backend) => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        const failures: string[] = []
        for (const backend of backends) {
          try {
            return await run(backend)
          } catch (cause) {
            failures.push(describe(cause))
          }
        }
        throw new Error(failures.join("; then "))
      },
      catch: (cause) =>
        new CredentialsError({
          name,
          reason: "keyring",
          message: `could not ${action} ${name} in the OS keyring (${describe(cause)}); on Linux this needs a running secret service such as GNOME Keyring`,
        }),
    }).pipe(Effect.retry({ schedule: Schedule.exponential(options.retryDelay ?? "200 millis"), times: options.retryTimes ?? 3 }))

  return {
    get: (name) => attempt(name, "read", async (backend) => await backend.get(name)).pipe(Effect.map(Option.fromNullishOr)),
    set: (name, value) => attempt(name, "store", async (backend) => await backend.set(name, value)),
    remove: (name) => attempt(name, "delete", async (backend) => await backend.remove(name)),
  }
}

// The OS keyring through Bun.secrets, falling back to a fresh process and retrying while the daemon restarts.
export const bunKeyring = (service = SERVICE, options: RecoveryOptions = {}): Keyring => fromBackends([inProcess(service), freshProcess(service)], options)

// An in-memory keyring for tests.
export const memoryKeyring = (initial: Readonly<Record<string, string>> = {}): Keyring => {
  const entries = new Map(Object.entries(initial))
  return {
    get: (name) => Effect.sync(() => Option.fromNullishOr(entries.get(name))),
    set: (name, value) => Effect.sync(() => void entries.set(name, value)),
    remove: (name) => Effect.sync(() => entries.delete(name)),
  }
}

// The keyring login and logout write to. Provide it with `layer`, which also lets Config read from it.
export const Keyring: Context.Service<Keyring, Keyring> = Context.Service("effect-lib/credentials/Keyring")

// Answers only the given names, so other Config lookups, e.g. a defaulted PORT, never touch the keyring.
// Values are trimmed and a blank one counts as absent; a keyring failure is a SourceError.
export const configProvider = (keyring: Keyring, names: ReadonlyArray<string>): ConfigProvider.ConfigProvider => {
  const known = new Set(names)
  return ConfigProvider.make((path) => {
    const name = path.length === 1 ? String(path[0]) : ""
    const stored = known.has(name)
      ? keyring.get(name).pipe(Effect.mapError((error) => new ConfigProvider.SourceError({ message: error.message, cause: error })))
      : Effect.succeed(Option.none<string>())
    return stored.pipe(
      Effect.map((entry) =>
        entry.pipe(
          Option.map((text) => text.trim()),
          Option.filter((text) => text !== ""),
          Option.map(ConfigProvider.makeValue),
          Option.getOrUndefined
        )
      )
    )
  })
}

// Provides `keyring` and adds it to the current ConfigProvider as a fallback for these secrets,
// so the environment wins and `Config.Redacted(name)` anywhere in the app reads the keyring too.
export const layer = (keyring: Keyring, secrets: ReadonlyArray<{ readonly name: string }>): Layer.Layer<Keyring> =>
  Layer.merge(
    Layer.succeed(Keyring)(keyring),
    ConfigProvider.layerAdd(
      configProvider(
        keyring,
        secrets.map((entry) => entry.name)
      )
    )
  )
