import { dirname } from "node:path"
import { Effect, FileSystem, Option, Schema } from "effect"

export class JsonStoreError extends Schema.TaggedError<JsonStoreError>()("JsonStoreError", {
  path: Schema.String,
  // read and write are I/O failures, decode means the file exists but does not match the schema.
  reason: Schema.Literals(["read", "decode", "write"]),
  message: Schema.String,
}) {}

export interface JsonStore<A> {
  readonly path: string
  // None when the file does not exist.
  readonly load: Effect.Effect<Option.Option<A>, JsonStoreError, FileSystem.FileSystem>
  // Writes to a temporary file and renames it over the target, so readers never see a partial file.
  readonly save: (value: A) => Effect.Effect<void, JsonStoreError, FileSystem.FileSystem>
}

export interface JsonStoreOptions {
  // Defaults to 0o600 for the file and 0o700 for directories created on save.
  readonly mode?: number
  readonly directoryMode?: number
}

// A JSON file at `path` holding a value of `schema`, saved pretty-printed with a trailing newline.
export const make = <A, I>(path: string, schema: Schema.Codec<A, I>, options: JsonStoreOptions = {}): JsonStore<A> => {
  const json = Schema.fromJsonString(schema, { space: 2 })
  const decode = Schema.decodeUnknownEffect(json)
  const encode = Schema.encodeEffect(json)
  const storeError = (reason: JsonStoreError["reason"], cause: Error) =>
    new JsonStoreError({ path, reason, message: `could not ${reason} ${path}: ${cause.message}` })

  const load = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(path).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (error) => (error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error))),
      Effect.mapError((error) => storeError("read", error))
    )
    if (Option.isNone(text)) {
      return Option.none<A>()
    }
    return Option.some(yield* decode(text.value).pipe(Effect.mapError((error) => storeError("decode", error))))
  })

  const save: (value: A) => Effect.Effect<void, JsonStoreError, FileSystem.FileSystem> = Effect.fnUntraced(function* save(value: A) {
    const fs = yield* FileSystem.FileSystem
    const text = yield* encode(value).pipe(Effect.mapError((error) => storeError("write", error)))
    const temporary = `${path}.${process.pid}.tmp`
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: options.directoryMode ?? 0o700 }).pipe(
      Effect.andThen(fs.writeFileString(temporary, `${text}\n`, { mode: options.mode ?? 0o600 })),
      Effect.andThen(fs.rename(temporary, path)),
      Effect.mapError((error) => storeError("write", error))
    )
  })

  return { path, load, save }
}
