import { delimiter, dirname, isAbsolute, join, sep } from "node:path"
import { Console, Effect, FileSystem, Schema, Stream } from "effect"
import { Command } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { unitFile, unitName, unitPath, type ServiceConfig } from "./unit.ts"

export { unitFile, unitName, unitPath, type Restart, type ServiceConfig } from "./unit.ts"

export class SystemdServiceError extends Schema.TaggedError<SystemdServiceError>()("SystemdServiceError", {
  message: Schema.String,
}) {}

type Services = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

// Fails on a non-zero exit unless `inherit`, which streams stdout to the terminal and returns the exit code.
const systemctl: (args: readonly string[], inherit?: boolean) => Effect.Effect<number, SystemdServiceError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn(
  "systemctl"
)(function* systemctl(args: readonly string[], inherit = false) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [stderr, code] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("systemctl", ["--user", ...args], { stdout: inherit ? "inherit" : "ignore", stderr: "pipe" }))
      return yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode], { concurrency: 2 })
    })
  ).pipe(Effect.mapError((cause) => new SystemdServiceError({ message: `could not run systemctl: ${cause.message}` })))
  if (!inherit && code !== 0) {
    return yield* new SystemdServiceError({ message: stderr.trim() || `systemctl --user ${args.join(" ")} exited with ${code}` })
  }
  return code
})

export const isInstalled: (config: ServiceConfig) => Effect.Effect<boolean, SystemdServiceError, FileSystem.FileSystem> = Effect.fn("isInstalled")(function* isInstalled(
  config: ServiceConfig
) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.exists(unitPath(config)).pipe(Effect.mapError((cause) => new SystemdServiceError({ message: cause.message })))
})

// A segment like 1.4.2, bun-1.4.2, v1 or 1: the path is one installed version of bun,
// which an upgrade removes (mise, asdf, Homebrew's Cellar, nix).
const isVersioned = (path: string) => path.split(sep).some((segment) => /\d+\.\d+/u.test(segment) || /^v?\d+$/u.test(segment))

// The first `bun` on `searchPath` that is not inside a versioned install, like a mise shim, a `latest`
// symlink or /usr/bin/bun, so the unit keeps working after bun is upgraded.
export const stableBun: (searchPath?: string) => Effect.Effect<string, SystemdServiceError, FileSystem.FileSystem> = Effect.fn("stableBun")(function* stableBun(
  searchPath = process.env["PATH"] ?? ""
) {
  const fs = yield* FileSystem.FileSystem
  for (const directory of searchPath.split(delimiter)) {
    const candidate = join(directory, "bun")
    if (!isAbsolute(directory) || isVersioned(candidate)) {
      continue
    }
    const isFile = yield* fs.stat(candidate).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false)
    )
    if (isFile) {
      return candidate
    }
  }
  return yield* new SystemdServiceError({
    message: "no bun on PATH outside a versioned install; put a stable one first, like the mise shims directory",
  })
})

const writeUnit: (config: ServiceConfig) => Effect.Effect<void, SystemdServiceError, Services> = Effect.fn("writeUnit")(function* writeUnit(config: ServiceConfig) {
  const fs = yield* FileSystem.FileSystem
  const path = unitPath(config)
  if (!isAbsolute(config.script)) {
    return yield* new SystemdServiceError({ message: `script must be an absolute path, got ${config.script}` })
  }
  const bun = yield* stableBun()
  yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(path, unitFile(config, bun))),
    Effect.mapError((cause) => new SystemdServiceError({ message: `could not write ${path}: ${cause.message}` }))
  )
  yield* systemctl(["daemon-reload"])
})

// Writes the unit, then enables and starts it; fails when it is already installed.
export const install: (config: ServiceConfig) => Effect.Effect<void, SystemdServiceError, Services> = Effect.fn("install")(function* install(config: ServiceConfig) {
  if (yield* isInstalled(config)) {
    return yield* new SystemdServiceError({ message: `${unitPath(config)} already exists; reinstall instead` })
  }
  yield* writeUnit(config)
  yield* systemctl(["enable", "--now", unitName(config)])
})

// Rewrites the unit, then enables and restarts it, whether or not it was installed.
export const reinstall: (config: ServiceConfig) => Effect.Effect<void, SystemdServiceError, Services> = Effect.fn("reinstall")(function* reinstall(config: ServiceConfig) {
  yield* writeUnit(config)
  yield* systemctl(["enable", unitName(config)])
  yield* systemctl(["restart", unitName(config)])
})

// Stops, disables and removes the unit; false when it was not installed.
export const uninstall: (config: ServiceConfig) => Effect.Effect<boolean, SystemdServiceError, Services> = Effect.fn("uninstall")(function* uninstall(config: ServiceConfig) {
  if (!(yield* isInstalled(config))) {
    return false
  }
  const fs = yield* FileSystem.FileSystem
  yield* systemctl(["disable", "--now", unitName(config)])
  yield* fs.remove(unitPath(config)).pipe(Effect.mapError((cause) => new SystemdServiceError({ message: `could not remove ${unitPath(config)}: ${cause.message}` })))
  yield* systemctl(["daemon-reload"])
  return true
})

// Prints `systemctl status` with the latest log lines. A non-zero exit only means the service is not running.
export const status: (config: ServiceConfig, lines?: number) => Effect.Effect<void, SystemdServiceError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("status")(function* status(
  config: ServiceConfig,
  lines = 20
) {
  yield* systemctl(["status", "--no-pager", `--lines=${lines}`, unitName(config)], true)
})

// A `service` command with install, reinstall, uninstall and status subcommands.
export const serviceCommand = (config: ServiceConfig, options: { readonly name?: string } = {}) => {
  const unit = unitName(config)
  return Command.make(options.name ?? "service").pipe(
    Command.withDescription(`Manage ${unit} as a systemd user service`),
    Command.withSubcommands([
      Command.make("install", {}, () =>
        install(config).pipe(Effect.andThen(Console.log(`Installed and started ${unit}; follow it with \`journalctl --user -u ${config.name} -f\``)))
      ).pipe(Command.withDescription(`Install ${unit}, enable it at login and start it`)),
      Command.make("reinstall", {}, () => reinstall(config).pipe(Effect.andThen(Console.log(`Rewrote and restarted ${unit}`)))).pipe(
        Command.withDescription(`Rewrite ${unit} with the current settings and restart it`)
      ),
      Command.make("uninstall", {}, () =>
        uninstall(config).pipe(Effect.flatMap((removed) => Console.log(removed ? `Stopped and removed ${unit}` : `${unit} is not installed`)))
      ).pipe(Command.withDescription(`Stop, disable and remove ${unit}`)),
      Command.make("status", {}, () =>
        isInstalled(config).pipe(Effect.flatMap((installed) => (installed ? status(config) : Console.log(`${unit} is not installed`))))
      ).pipe(Command.withDescription(`Show whether ${unit} is running, with its latest log lines`)),
    ])
  )
}
