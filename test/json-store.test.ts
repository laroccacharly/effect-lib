import { expect, test } from "bun:test"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option, Schema } from "effect"
import { make } from "../src/json-store/index.ts"

const Settings = Schema.Struct({ interval: Schema.Number, name: Schema.optional(Schema.String) })

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) => Effect.runPromise(Effect.provide(effect, BunServices.layer))

const temporaryPath = async () => join(await mkdtemp(join(tmpdir(), "json-store-")), "nested", "settings.json")

test("a missing file loads as none", async () => {
  expect(await run(make(await temporaryPath(), Settings).load)).toEqual(Option.none())
})

test("saves pretty-printed and private, then loads the same value", async () => {
  const store = make(await temporaryPath(), Settings)
  await run(store.save({ interval: 180 }))
  expect(await readFile(store.path, "utf8")).toBe('{\n  "interval": 180\n}\n')
  expect((await stat(store.path)).mode & 0o777).toBe(0o600)
  expect(await run(store.load)).toEqual(Option.some({ interval: 180 }))
})

test("a file that does not match the schema fails to decode", async () => {
  const store = make(await temporaryPath(), Settings)
  await run(store.save({ interval: 1 }))
  await writeFile(store.path, '{ "interval": "soon" }')
  const error = await run(Effect.flip(store.load))
  expect(error.reason).toBe("decode")
})
