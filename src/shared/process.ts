import { Effect, Stream } from "effect"
import { type ChildProcess, ChildProcessSpawner } from "effect/process"

export interface Output {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

// Runs `command` to its end. Read apart, so warnings on stderr never corrupt stdout; a stream that is not piped reads as "".
export const runToEnd = Effect.fnUntraced(function* runToEnd(command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command)
      const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 3 })
      return { stdout, stderr, code } satisfies Output
    })
  )
})
