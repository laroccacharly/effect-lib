import { join } from "node:path"
import { type Duration, Effect, FileSystem, Logger } from "effect"
import { stateHome } from "../shared/xdg.ts"

export interface FileLogOptions {
  // Names the log file `<name>.log`, and its default directory.
  readonly name: string
  // Defaults to `$XDG_STATE_HOME/<name>`, `~/.local/state/<name>` when unset; created when missing.
  readonly directory?: string
  // Keep the loggers already installed, the console one by default. True by default.
  readonly console?: boolean
  // How long lines are buffered before a write, 1 second by default; the rest is written when the layer closes.
  readonly batchWindow?: Duration.Input
}

// The file `layer` appends to.
export const path = (options: FileLogOptions) => join(options.directory ?? join(stateHome(), options.name), `${options.name}.log`)

// Appends every `Effect.log*` to `path(options)` as JSON lines, in a private directory and file.
export const layer = (options: FileLogOptions) =>
  Logger.layer(
    [
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = path(options)
        yield* fs.makeDirectory(join(file, ".."), { recursive: true, mode: 0o700 })
        return yield* Logger.toFile(Logger.formatJson, file, { mode: 0o600, batchWindow: options.batchWindow })
      }),
    ],
    { mergeWithExisting: options.console ?? true }
  )
