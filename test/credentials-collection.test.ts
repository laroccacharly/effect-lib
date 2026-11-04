import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Option, Redacted } from "effect"
import { layer, secret } from "../src/credentials/index.ts"
import { collectionControl, collectionKeyring, type IsolatedSecretService, isolatedSecretService } from "../src/credentials/collection/index.ts"

const COLLECTION = "effect-lib-test"
// The isolated Secret Service needs dbus-daemon and gnome-keyring; skip where they are not installed.
const withoutSecretService = Bun.which("dbus-daemon") === null || Bun.which("gnome-keyring-daemon") === null
const PASSWORD = Redacted.make("correct horse")

// Runs against a Secret Service of its own, never the user's.
const withSecretService = <A, E>(use: (service: IsolatedSecretService) => Effect.Effect<A, E>) => Effect.runPromise(Effect.scoped(Effect.flatMap(isolatedSecretService, use)))

test.skipIf(withoutSecretService)("creates a keyring, stores in it, and only reads it back while it is unlocked", async () => {
  await withSecretService((service) =>
    Effect.gen(function* () {
      const control = collectionControl(COLLECTION, { busAddress: service.busAddress })
      const keyring = collectionKeyring(COLLECTION, { busAddress: service.busAddress })
      yield* control.create(PASSWORD)
      expect(existsSync(join(service.keyringsDirectory, `${COLLECTION}.keyring`))).toBe(true)
      yield* keyring.set("API_KEY", "s3cret")
      expect(yield* keyring.get("API_KEY")).toEqual(Option.some("s3cret"))

      yield* keyring.set("OTHER_KEY", "other")
      yield* control.lock
      expect(yield* control.isLocked).toBe(true)
      expect(yield* keyring.names).toEqual(["API_KEY", "OTHER_KEY"])
      expect((yield* Effect.flip(keyring.get("API_KEY"))).reason).toBe("locked")

      const refused = yield* Effect.flip(control.unlock(Redacted.make("wrong")))
      expect(refused.reason).toBe("locked")
      expect(yield* control.isLocked).toBe(true)

      yield* control.unlock(PASSWORD)
      expect(yield* control.isLocked).toBe(false)
      expect(yield* keyring.get("API_KEY")).toEqual(Option.some("s3cret"))
    })
  )
})

test.skipIf(withoutSecretService)("backs declared secrets, and removes them", async () => {
  await withSecretService((service) =>
    Effect.gen(function* () {
      yield* collectionControl(COLLECTION, { busAddress: service.busAddress }).create(PASSWORD)
      const keyring = collectionKeyring(COLLECTION, { busAddress: service.busAddress })
      const ApiKey = secret("TEST_API_KEY")
      const program = Effect.gen(function* () {
        yield* ApiKey.save(" stored\n")
        const value = yield* ApiKey.resolve
        const removed = yield* ApiKey.remove
        return { value: Redacted.value(value), removed, after: yield* keyring.get("TEST_API_KEY") }
      })
      const result = yield* program.pipe(Effect.provide(layer(keyring)), Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({})))
      expect(result).toEqual({ value: "stored", removed: true, after: Option.none() })
    })
  )
})

test.skipIf(withoutSecretService)("fails with missing before the keyring exists, and with exists when creating it twice", async () => {
  await withSecretService((service) =>
    Effect.gen(function* () {
      const control = collectionControl(COLLECTION, { busAddress: service.busAddress })
      expect(yield* control.exists).toBe(false)
      expect((yield* Effect.flip(collectionKeyring(COLLECTION, { busAddress: service.busAddress }).get("API_KEY"))).reason).toBe("missing")
      yield* control.create(PASSWORD)
      expect((yield* Effect.flip(control.create(PASSWORD))).reason).toBe("exists")
    })
  )
})

test.skipIf(withoutSecretService)("fails instead of hanging when the bus is unreachable", async () => {
  const error = await Effect.runPromise(Effect.flip(collectionControl(COLLECTION, { busAddress: "unix:path=/nonexistent/effect-lib-bus" }).exists))
  expect(error.reason).toBe("keyring")
  const malformed = await Effect.runPromise(Effect.flip(collectionControl(COLLECTION, { busAddress: "not an address" }).exists))
  expect(malformed.reason).toBe("keyring")
})
