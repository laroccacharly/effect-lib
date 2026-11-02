import { Effect, Option, type Redacted, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** A deploy step that failed, said in one line. */
export class DeployError extends Schema.TaggedError<DeployError>()("DeployError", { message: Schema.String }) {}

/** A command and its arguments, like `["bun", "run", "build"]`. */
export type CommandLine = readonly [string, ...ReadonlyArray<string>]

/** The whole environment a child process runs with; nothing else is inherited. */
export type Environment = Readonly<Record<string, string | Redacted.Redacted<string>>>

/** Runs a command in this terminal with exactly `env`, failing unless it exits with 0. */
export const runInTerminal: (commandLine: CommandLine, env: Environment) => Effect.Effect<void, DeployError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fnUntraced(
  function* runInTerminal(commandLine: CommandLine, env: Environment) {
    const [command, ...args] = commandLine
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = ChildProcess.make(command, args, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    const exitCode = yield* spawner.exitCode(child).pipe(Effect.mapError((error) => new DeployError({ message: `could not run ${command}: ${error.message}` })))
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* new DeployError({ message: `${commandLine.join(" ")} exited with ${exitCode}` })
    }
  }
)

/** The variables of `record` that hold a value. */
export const definedVariables = (record: Partial<Readonly<Record<string, string>>>): ReadonlyArray<readonly [string, string]> =>
  Object.entries(record).flatMap(([name, value]) => Option.toArray(Option.map(Option.fromUndefinedOr(value), (text) => [name, text] as const)))

/** This process's environment without its CLOUDFLARE_ variables, which the keyring's values replace. */
export const shellEnvironment = (): Readonly<Record<string, string>> =>
  Object.fromEntries(definedVariables(process.env).filter(([name]) => !name.startsWith("CLOUDFLARE_")))
