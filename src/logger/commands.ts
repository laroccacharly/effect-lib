import { Console, Effect, FileSystem, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { path, type FileLogOptions } from "./file.ts"

const Entry = Schema.Struct({
  level: Schema.String,
  timestamp: Schema.String,
  message: Schema.Json,
  cause: Schema.optional(Schema.String),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  spans: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
})
type Entry = typeof Entry.Type

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(Entry))

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const
type Level = (typeof LEVELS)[number]

interface Filter {
  readonly level: Option.Option<Level>
  readonly grep: Option.Option<string>
}

// Lines that are not entries, like a line cut by a crash, only pass when no level is asked for.
const matches = (filter: Filter, line: string, entry: Option.Option<Entry>) => {
  const atLevel = Option.match(filter.level, {
    onNone: () => true,
    onSome: (level) => Option.match(entry, { onNone: () => false, onSome: (entry) => LEVELS.indexOf(entry.level.toLowerCase() as Level) >= LEVELS.indexOf(level) }),
  })
  return atLevel && Option.match(filter.grep, { onNone: () => true, onSome: (text) => line.toLowerCase().includes(text.toLowerCase()) })
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0")

// Local time, like 2026-11-04 14:24:06.764.
const localTime = (timestamp: string) => {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

const text = (value: Schema.Json) => {
  if (typeof value === "string") {
    return value
  }
  return JSON.stringify(value)
}

// `Effect.log("a", 1)` stores ["a", 1], printed as `a 1`.
const messageText = (message: Schema.Json) => {
  if (Array.isArray(message)) {
    return message.map(text).join(" ")
  }
  return text(message)
}

// `<time> <LEVEL> <message> key=value span=12ms`, then the cause, indented.
const pretty = (entry: Entry) => {
  const fields = [
    ...Object.entries(entry.annotations ?? {}).map(([key, value]) => `${key}=${text(value)}`),
    ...Object.entries(entry.spans ?? {}).map(([label, millis]) => `${label}=${millis}ms`),
  ]
  const head = [localTime(entry.timestamp), entry.level.padEnd(5), messageText(entry.message), ...fields].join(" ")
  if (entry.cause === undefined) {
    return head
  }
  return `${head}\n${entry.cause.replace(/^/gmu, "  ")}`
}

// The matching lines among `lines`, as JSON or pretty-printed.
const render = (lines: ReadonlyArray<string>, filter: Filter, json: boolean) =>
  lines.flatMap((line) => {
    const entry = decodeEntry(line)
    if (line === "" || !matches(filter, line, entry)) {
      return []
    }
    if (json) {
      return [line]
    }
    return [Option.match(entry, { onNone: () => line, onSome: pretty })]
  })

const printAll = (lines: ReadonlyArray<string>) => {
  if (lines.length === 0) {
    return Effect.void
  }
  return Console.log(lines.join("\n"))
}

const fileSize = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0)
  )

// Prints what is appended after byte `offset` every half second, until interrupted; starts over when the file is cleared.
const follow = Effect.fnUntraced(function* follow(file: string, offset: number, filter: Filter, json: boolean) {
  const fs = yield* FileSystem.FileSystem
  const decoder = new TextDecoder()
  let position = offset
  for (;;) {
    yield* Effect.sleep("500 millis")
    const size = yield* fileSize(fs, file)
    if (size < position) {
      position = 0
    }
    if (size === position) {
      continue
    }
    const bytes = yield* Effect.scoped(fs.open(file, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.readAlloc(size - position, { position: BigInt(position) }))))
    const chunk = decoder.decode(Option.getOrElse(bytes, () => new Uint8Array()))
    // Keeps a line still being written for the next read.
    const complete = chunk.slice(0, chunk.lastIndexOf("\n") + 1)
    position += new TextEncoder().encode(complete).length
    yield* printAll(render(complete.split("\n"), filter, json))
  }
})

const CHUNK = 64 * 1024

const concat = (head: Uint8Array, tail: Uint8Array) => {
  const bytes = new Uint8Array(head.length + tail.length)
  bytes.set(head)
  bytes.set(tail, head.length)
  return bytes
}

// The last `count` matching entries, read backwards in chunks so a large log is never loaded whole, and where they end: a line still being written is left
// for `follow`.
const lastEntries = Effect.fnUntraced(function* lastEntries(file: string, count: number, filter: Filter, json: boolean) {
  const fs = yield* FileSystem.FileSystem
  const size = yield* fileSize(fs, file)
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(file, { flag: "r" })
      const read = (from: number, to: number) =>
        handle.readAlloc(to - from, { position: BigInt(from) }).pipe(Effect.map(Option.getOrElse(() => new Uint8Array())))
      // After the last newline; the start of the file when no line is complete yet.
      let end = 0
      for (let to = size; to > 0; to = Math.max(0, to - CHUNK)) {
        const from = Math.max(0, to - CHUNK)
        const lastNewline = (yield* read(from, to)).lastIndexOf(10)
        if (lastNewline !== -1) {
          end = from + lastNewline + 1
          break
        }
      }
      let start = end
      let carry: Uint8Array = new Uint8Array()
      let found: ReadonlyArray<string> = []
      while (start > 0 && found.length < count) {
        const from = Math.max(0, start - CHUNK)
        const bytes = concat(yield* read(from, start), carry)
        start = from
        // The first line of a chunk may have begun in the one before it.
        const firstNewline = bytes.indexOf(10)
        if (start > 0 && firstNewline === -1) {
          carry = bytes
          continue
        }
        let cut = 0
        if (start > 0) {
          cut = firstNewline + 1
        }
        carry = bytes.subarray(0, cut)
        found = [...render(new TextDecoder().decode(bytes.subarray(cut)).split("\n"), filter, json), ...found].slice(-count)
      }
      return { entries: found, end }
    })
  )
})

const show = Effect.fnUntraced(function* show(file: string, options: Filter & { readonly lines: number; readonly json: boolean; readonly follow: boolean }) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(file)
  if (!exists && !options.follow) {
    return yield* Console.log(`${file} does not exist yet`)
  }
  let end = 0
  if (exists) {
    const last = yield* lastEntries(file, options.lines, options, options.json)
    yield* printAll(last.entries)
    end = last.end
  }
  if (options.follow) {
    return yield* follow(file, end, options, options.json)
  }
})

const clear = Effect.fnUntraced(function* clear(file: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(file))) {
    return yield* Console.log(`${file} does not exist yet`)
  }
  yield* fs.truncate(file)
  yield* Console.log(`Cleared ${file}`)
})

// A `logs` command with show, path and clear subcommands for the file `layer(options)` writes; add it to the root command's subcommands.
export const logsCommand = (options: FileLogOptions, command: { readonly name?: string } = {}) => {
  const file = path(options)
  return Command.make(command.name ?? "logs").pipe(
    Command.withDescription(`Read ${file}`),
    Command.withSubcommands([
      Command.make(
        "show",
        {
          lines: Flag.Int("lines").pipe(Flag.withAlias("n"), Flag.withDefault(50), Flag.withDescription("How many of the last matching entries to print")),
          level: Flag.Literals("level", LEVELS).pipe(Flag.optional, Flag.withDescription("Only entries at this level or above")),
          grep: Flag.String("grep").pipe(Flag.withAlias("g"), Flag.optional, Flag.withDescription("Only entries containing this text, ignoring case")),
          follow: Flag.Boolean("follow").pipe(Flag.withAlias("f"), Flag.withDefault(false), Flag.withDescription("Keep printing new entries until Ctrl-C")),
          json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Print the entries as stored, one JSON object per line")),
        },
        (flags) => show(file, flags)
      ).pipe(Command.withDescription(`Print the latest entries of ${file}`)),
      Command.make("path", {}, () => Console.log(file)).pipe(Command.withDescription("Print the log file's path")),
      Command.make("clear", {}, () => clear(file)).pipe(Command.withDescription(`Empty ${file}`)),
    ])
  )
}
