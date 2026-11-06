import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class ClipboardError extends Schema.TaggedError<ClipboardError>()("ClipboardError", {
  message: Schema.String,
}) {}

const clipboardCommand = () => {
  if (process.platform === "darwin") {
    return "pbcopy"
  }
  return "wl-copy"
}

// The text goes over stdin, so it never shows in argv. Not detached, so closing the scope leaves wl-copy's forked clipboard server alive.
export const copyToClipboard: (text: string) => Effect.Effect<void, ClipboardError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("copyToClipboard")(function* copyToClipboard(
  text: string
) {
  const command = clipboardCommand()
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = ChildProcess.make(command, [], { stdin: Stream.make(new TextEncoder().encode(text)), stdout: "ignore", stderr: "inherit", detached: false })
  const code = yield* spawner.exitCode(child).pipe(Effect.mapError((cause) => new ClipboardError({ message: `could not run ${command}: ${cause.message}` })))
  if (code !== 0) {
    return yield* new ClipboardError({ message: `${command} exited with ${code}` })
  }
})
