import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Option, Redacted, Schema } from "effect"
import {
  type Backend,
  bunKeyring,
  freshProcess,
  fromBackends,
  type Keyring,
  layer,
  make,
  memoryKeyring,
  secret,
  type Value,
} from "../src/credentials/index.ts"

const ApiKey = secret("TEST_API_KEY", { label: "Test API key" })
const Email = secret("TEST_EMAIL", { optional: true, sensitive: false, schema: Schema.String.check(Schema.isPattern(/^\S+@\S+$/u)) })
const Port = secret("TEST_PORT", { schema: Schema.FiniteFromString })

// Runs with only `env` as the environment and `keyring` as the keyring, never the real ones.
const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Keyring>, env: Record<string, string> = {}, keyring: Keyring = memoryKeyring()) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer(keyring)),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
      Effect.provide(BunServices.layer)
    )
  )

test("the environment wins over the keyring", async () => {
  const key = await run(ApiKey.resolve, { TEST_API_KEY: "from-env" }, memoryKeyring({ TEST_API_KEY: "stored" }))
  expect(Redacted.value(key)).toBe("from-env")
})

test("falls back to the keyring when the environment is unset or blank, trimming the value", async () => {
  const key = await run(ApiKey.resolve, { TEST_API_KEY: "  " }, memoryKeyring({ TEST_API_KEY: " stored\n" }))
  expect(Redacted.value(key)).toBe("stored")
})

test("a missing required secret fails; a missing optional one is none", async () => {
  const error = await run(Effect.flip(ApiKey.resolve))
  expect(error.reason).toBe("missing")
  expect(error.message).toContain("TEST_API_KEY")
  expect(await run(Email.resolve)).toEqual(Option.none())
})

test("decodes with the schema and rejects values that do not match", async () => {
  expect(Redacted.value(await run(Port.resolve, { TEST_PORT: "8080" }))).toBe(8080)
  const error = await run(Effect.flip(Email.resolve), {}, memoryKeyring({ TEST_EMAIL: "not an email" }))
  expect(error.reason).toBe("invalid")
  expect(error.message).toContain("keyring")
})

test("values are typed and branded by name", async () => {
  const program = Effect.gen(function* () {
    const key: Value<"TEST_API_KEY"> = yield* ApiKey.resolve
    const email: Option.Option<Value<"TEST_EMAIL">> = yield* Email.resolve
    const port: Value<"TEST_PORT", number> = yield* Port.resolve
    // @ts-expect-error a key is not interchangeable with another secret's
    const wrong: Value<"OTHER_KEY"> = key
    return [key, email, port, wrong]
  })
  await run(program, { TEST_API_KEY: "k", TEST_PORT: "1" })
})

const failing = (failures: { count: number }): Backend => ({
  get: async () => {
    failures.count += 1
    throw new Error("stale connection")
  },
  set: async () => {
    throw new Error("stale connection")
  },
  remove: async () => {
    throw new Error("stale connection")
  },
})

const working = (entries: Map<string, string>): Backend => ({
  get: async (name) => entries.get(name) ?? null,
  set: async (name, value) => {
    entries.set(name, value)
  },
  remove: async (name) => entries.delete(name),
})

test("recovers through the next backend when the first fails", async () => {
  const failures = { count: 0 }
  const keyring = fromBackends([failing(failures), working(new Map([["TEST_API_KEY", "recovered"]]))], { retryDelay: "1 millis" })
  expect(Redacted.value(await run(ApiKey.resolve, {}, keyring))).toBe("recovered")
  expect(failures.count).toBe(1)
})

test("retries while the keyring comes back, then reports every backend's failure", async () => {
  const entries = new Map([["TEST_API_KEY", "back"]])
  let down = 2
  const flaky: Backend = {
    ...working(entries),
    get: async (name) => {
      if (down > 0) {
        down -= 1
        throw new Error("daemon restarting")
      }
      return entries.get(name) ?? null
    },
  }
  expect(Redacted.value(await run(ApiKey.resolve, {}, fromBackends([flaky], { retryDelay: "1 millis" })))).toBe("back")

  const failures = { count: 0 }
  const keyring = fromBackends([failing(failures), failing(failures)], { retryDelay: "1 millis", retryTimes: 2 })
  const error = await run(Effect.flip(ApiKey.resolve), {}, keyring)
  expect(error.reason).toBe("keyring")
  expect(error.message).toContain("stale connection; then stale connection")
  expect(failures.count).toBe(6)
})

test("login --from-env stores the environment, keeps what is stored, and lists required secrets it lacks", async () => {
  const keyring = memoryKeyring({ TEST_PORT: "1" })
  await run(make([ApiKey, Port, Email]).login({ fromEnv: true }), { TEST_API_KEY: "new" }, keyring)
  expect(await run(keyring.get("TEST_API_KEY"))).toEqual(Option.some("new"))
  expect(await run(keyring.get("TEST_PORT"))).toEqual(Option.some("1"))

  const error = await run(Effect.flip(make([ApiKey, Port]).login({ fromEnv: true })), {}, memoryKeyring())
  expect(error._tag === "CredentialsError" && error.message).toContain("TEST_API_KEY, TEST_PORT")
})

test("login refuses an environment value that does not match the schema", async () => {
  const error = await run(Effect.flip(make([Port]).login({ fromEnv: true })), { TEST_PORT: "eighty" })
  expect(error._tag === "CredentialsError" && error.reason).toBe("invalid")
})

test("lookup tells the environment from the keyring", async () => {
  const keyring = memoryKeyring({ TEST_API_KEY: "stored", TEST_PORT: "1" })
  const sources = await run(
    Effect.all([ApiKey.lookup, Port.lookup, Email.lookup]).pipe(Effect.map((found) => found.map(Option.map((entry) => entry.source)))),
    { TEST_API_KEY: "from-env" },
    keyring
  )
  expect(sources).toEqual([Option.some("env"), Option.some("keyring"), Option.none()])
})

test("logout removes stored secrets", async () => {
  const keyring = memoryKeyring({ TEST_API_KEY: "k" })
  await run(make([ApiKey, Email]).logout, {}, keyring)
  expect(await run(keyring.get("TEST_API_KEY"))).toEqual(Option.none())
})

// Touches the real OS keyring, under its own service: CREDENTIALS_SMOKE=1 bun test credentials
test.skipIf(process.env["CREDENTIALS_SMOKE"] !== "1")("round-trips through Bun.secrets, in process and in a fresh process", async () => {
  const service = "effect-lib/credentials-smoke"
  const keyring = bunKeyring(service)
  await run(keyring.set("SMOKE", "value"))
  expect(await run(fromBackends([freshProcess(service)]).get("SMOKE"))).toEqual(Option.some("value"))
  expect(await run(keyring.remove("SMOKE"))).toBe(true)
  expect(await run(keyring.get("SMOKE"))).toEqual(Option.none())
})
