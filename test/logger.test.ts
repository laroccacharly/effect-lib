import { expect, spyOn, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, Effect, Fiber, Layer } from "effect"
import { Command } from "effect/cli"
import { layer, logsCommand, path } from "../src/logger/index.ts"

const temporaryOptions = async () => ({ name: "app", directory: join(await mkdtemp(join(tmpdir(), "logger-")), "nested", "logs"), console: false })

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) => Effect.runPromise(Effect.provide(effect, BunServices.layer))

const cli = (options: Awaited<ReturnType<typeof temporaryOptions>>, args: ReadonlyArray<string>) => Command.runWith(logsCommand(options), { version: "0.0.0" })(args)

const captureLogs = async <A>(action: () => Promise<A>) => {
  const lines: string[] = []
  const log = spyOn(console, "log").mockImplementation((line: string) => lines.push(line))
  try {
    await action()
  } finally {
    log.mockRestore()
  }
  return lines.join("\n")
}

// Writes three entries through the layer, like an app would.
const writeEntries = async (options: Awaited<ReturnType<typeof temporaryOptions>>) => {
  const program = Effect.gen(function* () {
    yield* Effect.logInfo("started").pipe(Effect.annotateLogs({ port: 3000 }))
    yield* Effect.logWarning("slow request")
    yield* Effect.logError("failed", Cause.fail(new Error("boom")))
  })
  await run(program.pipe(Effect.provide(layer(options))))
}

test("appends JSON lines to <directory>/<name>.log, creating the directory", async () => {
  const options = await temporaryOptions()
  const program = Effect.gen(function* () {
    yield* Effect.logInfo("started").pipe(Effect.annotateLogs({ port: 3000 }))
    yield* Effect.logError("failed")
  })
  const runOnce = () => Effect.runPromise(program.pipe(Effect.provide(layer(options).pipe(Layer.provide(BunServices.layer)))))
  await runOnce()
  await runOnce()

  expect(path(options)).toBe(join(options.directory, "app.log"))
  const lines = (await readFile(path(options), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line))
  expect(lines.map((line) => [line.level, line.message])).toEqual([
    ["INFO", "started"],
    ["ERROR", "failed"],
    ["INFO", "started"],
    ["ERROR", "failed"],
  ])
  expect(lines[0].annotations).toEqual({ port: 3000 })
  expect((await stat(options.directory)).mode & 0o777).toBe(0o700)
  expect((await stat(path(options))).mode & 0o777).toBe(0o600)
})

test("defaults to $XDG_STATE_HOME/<name>/<name>.log", () => {
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = "/state"
  try {
    expect(path({ name: "app" })).toBe("/state/app/app.log")
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  }
})

test("logs show prints the last entries, filtered by level or text, pretty or as JSON", async () => {
  const options = await temporaryOptions()
  expect(await captureLogs(() => run(cli(options, ["show"])))).toBe(`${path(options)} does not exist yet`)
  await writeEntries(options)

  const all = (await captureLogs(() => run(cli(options, ["show"])))).split("\n")
  expect(all[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO  started port=3000$/u)
  expect(all[1]).toEndWith("WARN  slow request")
  expect(all[2]).toEndWith("ERROR failed")
  expect(all[3]).toContain("  Error: boom")

  const last = await captureLogs(() => run(cli(options, ["show", "-n", "1", "--json"])))
  expect(JSON.parse(last)).toMatchObject({ level: "ERROR", message: "failed" })
  const warnings = await captureLogs(() => run(cli(options, ["show", "--level", "warn", "--json"])))
  expect(warnings.split("\n").map((line) => JSON.parse(line).message)).toEqual(["slow request", "failed"])
  expect(await captureLogs(() => run(cli(options, ["show", "--grep", "SLOW"])))).toEndWith("WARN  slow request")
})

test("logs show --follow prints entries appended after it started", async () => {
  const options = await temporaryOptions()
  await writeEntries(options)
  const output = await captureLogs(() =>
    run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(cli(options, ["show", "-n", "0", "--follow"]))
        yield* Effect.sleep("100 millis")
        yield* Effect.promise(() => appendFile(path(options), `${JSON.stringify({ level: "INFO", timestamp: new Date().toISOString(), message: "later" })}\n`))
        yield* Effect.sleep("700 millis")
        yield* Fiber.interrupt(fiber)
      })
    )
  )
  expect(output).toEndWith("INFO  later")
  expect(output).not.toContain("started")
})

test("logs path prints the file, and logs clear empties it", async () => {
  const options = await temporaryOptions()
  expect(await captureLogs(() => run(cli(options, ["path"])))).toBe(path(options))
  await writeEntries(options)
  expect(await captureLogs(() => run(cli(options, ["clear"])))).toBe(`Cleared ${path(options)}`)
  expect(await readFile(path(options), "utf8")).toBe("")
})

test("logs show reads a log larger than its read chunk from the end", async () => {
  const options = await temporaryOptions()
  await mkdir(options.directory, { recursive: true })
  const levels = ["INFO", "ERROR"]
  const line = (index: number) => JSON.stringify({ level: levels[index % 2], timestamp: new Date().toISOString(), message: `entry ${index}`, padding: "x".repeat(100) })
  const count = 3000
  await writeFile(path(options), `${Array.from({ length: count }, (_, index) => line(index)).join("\n")}\n{"level":"INFO","mess`)
  const output = await captureLogs(() => run(cli(options, ["show", "-n", "1200", "--level", "error", "--json"])))
  const messages = output.split("\n").map((entry) => JSON.parse(entry).message)
  expect(messages).toEqual(Array.from({ length: 1200 }, (_, index) => `entry ${count - 2400 + index * 2 + 1}`))
})

test("logs show --follow leaves an entry still being written until it is complete", async () => {
  const options = await temporaryOptions()
  await mkdir(options.directory, { recursive: true })
  const entry = JSON.stringify({ level: "INFO", timestamp: new Date().toISOString(), message: "x".repeat(100_000) })
  await writeFile(path(options), entry.slice(0, 80_000))
  const output = await captureLogs(() =>
    run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(cli(options, ["show", "--follow", "--json"]))
        yield* Effect.sleep("100 millis")
        yield* Effect.promise(() => appendFile(path(options), `${entry.slice(80_000)}\n`))
        yield* Effect.sleep("700 millis")
        yield* Fiber.interrupt(fiber)
      })
    )
  )
  expect(output).toBe(entry)
})

test("withLogger flushes failures and preserves the original cause", async () => {
  const { withLogger } = await import("../src/logger/index.ts")
  const options = await temporaryOptions()
  const error = new Error("cli-failure-check")
  const exit = await Effect.runPromiseExit(withLogger(Effect.fail(error), options))
  expect(exit._tag).toBe("Failure")
  const entries = (await readFile(path(options), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  expect(entries).toHaveLength(1)
  expect(entries[0].level).toBe("ERROR")
  expect(JSON.stringify(entries[0])).toContain("cli-failure-check")
})
