// The stock `omarchy` and `omarchy-shell` commands, which do the actual enabling and discovery.

import { Effect, Option, Schedule, Schema } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { runToEnd } from "../shared/process.ts"
import { OmarchyPluginError } from "./error.ts"

type Spawner = ChildProcessSpawner.ChildProcessSpawner

export interface ShellPlugin {
  readonly id: string
  readonly enabled: boolean
}

const ShellPlugins = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, enabled: Schema.Boolean })))

const commandLine = (command: string, args: readonly string[]) => [command, ...args].join(" ")

const run = (command: string, args: readonly string[]) =>
  runToEnd(ChildProcess.make(command, args, { stdout: "pipe", stderr: "pipe" })).pipe(
    Effect.mapError((cause) => new OmarchyPluginError({ message: `could not run ${commandLine(command, args)}: ${cause.message}` }))
  )

const failure = (command: string, args: readonly string[], code: number, stderr: string) => {
  const message = `${commandLine(command, args)} failed (exit ${code})`
  if (!stderr.trim()) {
    return new OmarchyPluginError({ message })
  }
  return new OmarchyPluginError({ message: `${message}:\n${stderr.trim()}` })
}

// The trimmed stdout; fails on a non-zero exit.
const runOrFail = Effect.fnUntraced(function* runOrFail(command: string, args: readonly string[]) {
  const { stdout, stderr, code } = yield* run(command, args)
  if (code !== 0) {
    return yield* failure(command, args, code, stderr)
  }
  return stdout.trim()
})

// Discovery and restarts finish after their command returns, so the result is polled for.
const pollUntilTrue = (check: Effect.Effect<boolean, OmarchyPluginError, Spawner>, attempts: number, spacing: `${number} millis`) =>
  check.pipe(Effect.repeat({ schedule: Schedule.spaced(spacing), times: attempts, until: (done) => done }))

export const isShellRunning: Effect.Effect<boolean, never, Spawner> = run("omarchy-shell", ["shell", "ping"]).pipe(
  Effect.map(({ stdout, code }) => code === 0 && stdout.trim() === "ok"),
  Effect.orElseSucceed(() => false)
)

export const requireShell: Effect.Effect<void, OmarchyPluginError, Spawner> = Effect.gen(function* () {
  if (!(yield* isShellRunning)) {
    return yield* new OmarchyPluginError({ message: "omarchy-shell is not running (omarchy-shell shell ping failed)" })
  }
})

// Every plugin the running shell knows about, keyed by id.
export const listPlugins: Effect.Effect<ReadonlyMap<string, ShellPlugin>, OmarchyPluginError, Spawner> = runOrFail("omarchy-shell", ["shell", "listPlugins"]).pipe(
  Effect.flatMap((stdout) => Schema.decodeEffect(ShellPlugins)(stdout || "[]")),
  Effect.mapError((cause) => new OmarchyPluginError({ message: `could not list the shell's plugins: ${cause.message}` })),
  Effect.map((plugins) => new Map(plugins.map((plugin) => [plugin.id, plugin])))
)

export const isEnabled = (id: string) => listPlugins.pipe(Effect.map((plugins) => plugins.get(id)?.enabled === true))

export const isDiscovered = (id: string) => listPlugins.pipe(Effect.map((plugins) => plugins.has(id)))

// True once `check` holds, false when it still does not after about five seconds.
export const rescanUntil = Effect.fnUntraced(function* rescanUntil(check: Effect.Effect<boolean, OmarchyPluginError, Spawner>) {
  yield* runOrFail("omarchy-shell", ["shell", "rescanPlugins"])
  return yield* pollUntilTrue(check, 50, "100 millis")
})

export const validate = (root: string) => runOrFail("omarchy", ["plugin", "validate", root]).pipe(Effect.asVoid)

const sectionArgs = (section: Option.Option<string>) => Option.match(section, { onNone: () => [], onSome: (name) => ["--section", name] })

export const enable = (id: string, section: Option.Option<string>) => runOrFail("omarchy", ["plugin", "enable", id, ...sectionArgs(section)]).pipe(Effect.asVoid)

export const disable = (id: string) => runOrFail("omarchy", ["plugin", "disable", id]).pipe(Effect.asVoid)

// Restarts the shell and waits up to 30 seconds for it to answer again.
export const restartShell: Effect.Effect<void, OmarchyPluginError, Spawner> = Effect.gen(function* () {
  yield* runOrFail("omarchy", ["restart", "shell"])
  if (!(yield* pollUntilTrue(isShellRunning, 150, "200 millis"))) {
    return yield* new OmarchyPluginError({ message: "the shell did not come back after the restart" })
  }
})
