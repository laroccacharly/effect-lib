import { Console, Effect, FileSystem, Option, Result, Schema } from "effect"
import { Argument, Command } from "effect/cli"
import { JsonStoreError, type JsonStore } from "./store.ts"

const parseJsonOrNone = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

// `180` is the number 180 and `"180"` the string, while text that is not JSON, like `fast`, is the string itself.
const candidateValues = (text: string): ReadonlyArray<Schema.Json> => Option.match(parseJsonOrNone(text), { onNone: () => [text], onSome: (parsed) => [parsed, text] })

const invalid = (path: string, message: string) => new JsonStoreError({ path, reason: "decode", message: `${path}: ${message}` })

const encodeStored = <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, value: A) =>
  Schema.encodeEffect(schema)(value).pipe(Effect.mapError((error) => invalid(store.path, error.message)))

// The stored value in its saved form, as an object since get, set and unset address one key path; an empty object when the file does not exist.
const loadEncodedObject = Effect.fnUntraced(function* <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>) {
  const current = yield* store.load
  if (Option.isNone(current)) {
    return {}
  }
  const encoded = yield* encodeStored(store, schema, current.value)
  return yield* Schema.decodeUnknownEffect(Schema.JsonObject)(encoded).pipe(Effect.mapError(() => invalid(store.path, "config commands need the stored value to be an object")))
})

const decodeWithoutExtraKeys = <A, I>(schema: Schema.Codec<A, I>, object: Schema.JsonObject) => Schema.decodeUnknownEffect(schema)(object, { onExcessProperty: "error" })

// A key path: `interval` is a top-level key, `sources.mic.node` the key `node` of the object at `sources.mic`.
const pathOf = (key: string) => key.split(".")

// The object with `key` set to `value`, built from entries: JsonObject's type reads as a class instance to the spread lint.
const withKey = (object: Schema.JsonObject, key: string, value: Schema.Json): Schema.JsonObject => Object.fromEntries([...Object.entries(object), [key, value]])

const isObject = (value: Schema.Json): value is Schema.JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)

const childOf = (object: Schema.JsonObject, key: string): Option.Option<Schema.Json> => {
  if (!Object.hasOwn(object, key)) {
    return Option.none()
  }
  return Option.fromUndefinedOr(object[key])
}

// The value at a key path, none when it is not set.
const valueAt = (object: Schema.JsonObject, path: ReadonlyArray<string>): Option.Option<Schema.Json> => {
  const [head = "", ...rest] = path
  return Option.flatMap(childOf(object, head), (child) => {
    if (rest.length === 0) {
      return Option.some(child)
    }
    if (!isObject(child)) {
      return Option.none()
    }
    return valueAt(child, rest)
  })
}

// The object with the value at a key path replaced, creating the objects on the way; fails at a part of the path that holds something other than an object.
const withValueAt = (object: Schema.JsonObject, path: ReadonlyArray<string>, value: Schema.Json, at = ""): Result.Result<Schema.JsonObject, string> => {
  const [head = "", ...rest] = path
  if (rest.length === 0) {
    return Result.succeed(withKey(object, head, value))
  }
  const here = [at, head].filter((part) => part !== "").join(".")
  const child = Option.getOrElse(childOf(object, head), (): Schema.Json => ({}))
  if (!isObject(child)) {
    return Result.fail(`${here} is not an object`)
  }
  return Result.map(withValueAt(child, rest, value, here), (updated) => withKey(object, head, updated))
}

// The object without the value at a key path, none when it is not set.
const withoutValueAt = (object: Schema.JsonObject, path: ReadonlyArray<string>): Option.Option<Schema.JsonObject> => {
  const [head = "", ...rest] = path
  return Option.flatMap(childOf(object, head), (child) => {
    if (rest.length === 0) {
      return Option.some(Object.fromEntries(Object.entries(object).filter(([name]) => name !== head)))
    }
    if (!isObject(child)) {
      return Option.none()
    }
    return Option.map(withoutValueAt(child, rest), (updated) => withKey(object, head, updated))
  })
}

// Strings print as plain text so scripts can use them directly; everything else prints as JSON.
const formatValue = (value: Schema.Json) => {
  if (typeof value === "string") {
    return value
  }
  return JSON.stringify(value, null, 2)
}

// Prints the stored value as it is saved, or says the file does not exist yet.
export const list: <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>) => Effect.Effect<void, JsonStoreError, FileSystem.FileSystem> = Effect.fn("jsonStore.list")(function* list<A, I>(
  store: JsonStore<A>,
  schema: Schema.Codec<A, I>
) {
  const value = yield* store.load
  if (Option.isNone(value)) {
    return yield* Console.log(`${store.path} does not exist yet`)
  }
  yield* Console.log(JSON.stringify(yield* encodeStored(store, schema, value.value), null, 2))
})

// Prints the value at a key path as it is saved, and fails when it is not set.
export const get: <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string) => Effect.Effect<void, JsonStoreError, FileSystem.FileSystem> = Effect.fn("jsonStore.get")(function* get<
  A,
  I,
>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string) {
  const value = valueAt(yield* loadEncodedObject(store, schema), pathOf(key))
  if (Option.isNone(value)) {
    return yield* new JsonStoreError({ path: store.path, reason: "missing", message: `${store.path}: ${key} is not set` })
  }
  yield* Console.log(formatValue(value.value))
})

// Sets the value at a key path, starting from an empty object when the file does not exist and creating the objects on the way, and saves only if the
// result matches the schema.
export const set: <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string, text: string) => Effect.Effect<void, JsonStoreError, FileSystem.FileSystem> = Effect.fn(
  "jsonStore.set"
)(function* set<A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string, text: string) {
  const encoded = yield* loadEncodedObject(store, schema)
  // Whether a part of the path is not an object does not depend on the value.
  const candidates = yield* Effect.forEach(candidateValues(text), (value) => Effect.fromResult(withValueAt(encoded, pathOf(key), value))).pipe(
    Effect.mapError((message: string) => invalid(store.path, `cannot set ${key}: ${message}`))
  )
  const attempts = candidates.map((candidate) => decodeWithoutExtraKeys(schema, candidate))
  const updated = yield* Effect.firstSuccessOf(attempts).pipe(Effect.mapError((error) => invalid(store.path, `cannot set ${key} to ${text}: ${error.message}`)))
  yield* store.save(updated)
  yield* Console.log(`Set ${key} in ${store.path}`)
})

// Removes the value at a key path; the schema refuses it for required keys, so only optional ones can be unset.
export const unset: <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string) => Effect.Effect<void, JsonStoreError, FileSystem.FileSystem> = Effect.fn("jsonStore.unset")(
  function* unset<A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string) {
    const rest = withoutValueAt(yield* loadEncodedObject(store, schema), pathOf(key))
    if (Option.isNone(rest)) {
      return yield* Console.log(`${key} is not set in ${store.path}`)
    }
    const updated = yield* decodeWithoutExtraKeys(schema, rest.value).pipe(Effect.mapError((error) => invalid(store.path, `cannot unset ${key}: ${error.message}`)))
    yield* store.save(updated)
    yield* Console.log(`Unset ${key} in ${store.path}`)
  }
)

const keyArgument = Argument.String("key").pipe(Argument.withDescription("Key, or a dotted path to a nested key, like sources.mic.node"))

// `<name> get | set | unset | list` for this store; add it to the root command's subcommands.
export const commands = <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, name = "config") =>
  Command.make(name).pipe(
    Command.withDescription(`Read or change ${store.path}`),
    Command.withSubcommands([
      Command.make("get", { key: keyArgument }, ({ key }) => get(store, schema, key)).pipe(Command.withDescription(`Print one key of ${store.path}`)),
      Command.make(
        "set",
        { key: keyArgument, value: Argument.String("value").pipe(Argument.withDescription("JSON value, or plain text for a string")) },
        ({ key, value }) => set(store, schema, key, value)
      ).pipe(Command.withDescription(`Set one key in ${store.path}, checked against its schema`)),
      Command.make("unset", { key: keyArgument }, ({ key }) => unset(store, schema, key)).pipe(Command.withDescription(`Remove one optional key from ${store.path}`)),
      Command.make("list", {}, () => list(store, schema)).pipe(Command.withDescription(`Print ${store.path}`)),
    ])
  )
