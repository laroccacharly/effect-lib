import { expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option, Schema } from "effect"
import { Command } from "effect/cli"
import { get, make, set, unset } from "../src/json-store/index.ts"

const Settings = Schema.Struct({ interval: Schema.Finite, name: Schema.optional(Schema.String) })

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

const runCli = (store: ReturnType<typeof make<typeof Settings.Type, typeof Settings.Encoded>>, args: ReadonlyArray<string>) =>
  run(Command.runWith(store.commands(), { version: "0.0.0" })(args))

const captureLogs = async (action: () => Promise<void>) => {
  const lines: string[] = []
  const log = spyOn(console, "log").mockImplementation((line: string) => lines.push(line))
  try {
    await action()
  } finally {
    log.mockRestore()
  }
  return lines.join("\n")
}

test("config set checks each value against the schema, and get and list print it", async () => {
  const store = make(await temporaryPath(), Settings)
  await runCli(store, ["set", "interval", "180"])
  await runCli(store, ["set", "name", "42"])
  expect(await run(store.load)).toEqual(Option.some({ interval: 180, name: "42" }))
  expect(await captureLogs(() => runCli(store, ["get", "name"]))).toBe("42")
  expect(await captureLogs(() => runCli(store, ["list"]))).toBe('{\n  "interval": 180,\n  "name": "42"\n}')
})

test("config set refuses unknown keys and values that do not match, keeping the file", async () => {
  const store = make(await temporaryPath(), Settings)
  await run(store.save({ interval: 1 }))
  const unknown = await run(Effect.flip(set(store, Settings, "intervall", "2")))
  expect(unknown.reason).toBe("decode")
  const wrongType = await run(Effect.flip(set(store, Settings, "interval", "soon")))
  expect(wrongType.message).toContain("cannot set interval to soon")
  expect(await run(store.load)).toEqual(Option.some({ interval: 1 }))
})

test("config unset removes optional keys only, and get fails on a key that is not set", async () => {
  const store = make(await temporaryPath(), Settings)
  await run(store.save({ interval: 1, name: "a" }))
  await run(unset(store, Settings, "name"))
  expect(await run(store.load)).toEqual(Option.some({ interval: 1 }))
  expect((await run(Effect.flip(get(store, Settings, "name")))).reason).toBe("missing")
  const required = await run(Effect.flip(unset(store, Settings, "interval")))
  expect(required.message).toContain("cannot unset interval")
  expect(await run(store.load)).toEqual(Option.some({ interval: 1 }))
})

const Nested = Schema.Struct({
  sources: Schema.Record(Schema.String, Schema.Struct({ node: Schema.String, channels: Schema.optional(Schema.Finite) })),
  tags: Schema.optional(Schema.Array(Schema.String)),
})

test("a dotted key reaches into nested objects for get, set and unset, still checked against the schema", async () => {
  const store = make(await temporaryPath(), Nested)
  await run(store.save({ sources: { mic: { node: "a", channels: 2 } }, tags: ["x"] }))
  await run(set(store, Nested, "sources.mic.node", "b"))
  await run(set(store, Nested, "sources.cam.node", "c"))
  expect(await captureLogs(() => run(get(store, Nested, "sources.mic.node")))).toBe("b")
  await run(unset(store, Nested, "sources.mic.channels"))
  expect(await run(store.load)).toEqual(Option.some({ sources: { mic: { node: "b" }, cam: { node: "c" } }, tags: ["x"] }))
  expect((await run(Effect.flip(get(store, Nested, "sources.mic.channels")))).reason).toBe("missing")
  expect((await run(Effect.flip(get(store, Nested, "sources.mic.node.deeper")))).reason).toBe("missing")
  expect((await run(Effect.flip(set(store, Nested, "sources.mic.nod", "d")))).message).toContain("cannot set sources.mic.nod to d")
  expect((await run(Effect.flip(set(store, Nested, "sources.mic.node.deeper", "d")))).message).toContain("cannot set sources.mic.node.deeper: sources.mic.node is not an object")
  expect((await run(Effect.flip(set(store, Nested, "tags.0", "y")))).message).toContain("tags is not an object")
  expect((await run(Effect.flip(unset(store, Nested, "sources.mic.node")))).message).toContain("cannot unset sources.mic.node")
  expect(await run(store.load)).toEqual(Option.some({ sources: { mic: { node: "b" }, cam: { node: "c" } }, tags: ["x"] }))
})
