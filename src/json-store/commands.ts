import { Console, Effect, FileSystem, Option, Schema } from "effect"
import { Argument, Command } from "effect/cli"
import { JsonStoreError, type JsonStore } from "./store.ts"

const parseJsonOrNone = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

// `180` is the number 180 and `"180"` the string, while text that is not JSON, like `fast`, is the string itself.
const candidateValues = (text: string): ReadonlyArray<Schema.Json> => Option.match(parseJsonOrNone(text), { onNone: () => [text], onSome: (parsed) => [parsed, text] })

const invalid = (path: string, message: string) => new JsonStoreError({ path, reason: "decode", message: `${path}: ${message}` })

const encodeStored = <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, value: A) =>
  Schema.encodeEffect(schema)(value).pipe(Effect.mapError((error) => invalid(store.path, error.message)))

// The stored value in its saved form, as an object since get, set and unset address one key; an empty object when the file does not exist.
const loadEncodedObject = Effect.fnUntraced(function* <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>) {
  const current = yield* store.load
  if (Option.isNone(current)) {
    return {}
  }
  const encoded = yield* encodeStored(store, schema, current.value)
  return yield* Schema.decodeUnknownEffect(Schema.JsonObject)(encoded).pipe(Effect.mapError(() => invalid(store.path, "config commands need the stored value to be an object")))
})

const decodeWithoutExtraKeys = <A, I>(schema: Schema.Codec<A, I>, object: Schema.JsonObject) => Schema.decodeUnknownEffect(schema)(object, { onExcessProperty: "error" })

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

// Prints one top-level key as it is saved, and fails when it is not set.
export const get: <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string) => Effect.Effect<void, JsonStoreError, FileSystem.FileSystem> = Effect.fn("jsonStore.get")(function* get<
  A,
  I,
>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string) {
  const encoded = yield* loadEncodedObject(store, schema)
  const value = encoded[key]
  if (!Object.hasOwn(encoded, key) || value === undefined) {
    return yield* new JsonStoreError({ path: store.path, reason: "missing", message: `${store.path}: ${key} is not set` })
  }
  yield* Console.log(formatValue(value))
})

// Sets one top-level key, starting from an empty object when the file does not exist, and saves only if the result matches the schema.
export const set: <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string, text: string) => Effect.Effect<void, JsonStoreError, FileSystem.FileSystem> = Effect.fn(
  "jsonStore.set"
)(function* set<A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string, text: string) {
  const encoded = yield* loadEncodedObject(store, schema)
  const attempts = candidateValues(text).map((value) => decodeWithoutExtraKeys(schema, { ...encoded, [key]: value }))
  const updated = yield* Effect.firstSuccessOf(attempts).pipe(Effect.mapError((error) => invalid(store.path, `cannot set ${key} to ${text}: ${error.message}`)))
  yield* store.save(updated)
  yield* Console.log(`Set ${key} in ${store.path}`)
})

// Removes one top-level key; the schema refuses it for required keys, so only optional ones can be unset.
export const unset: <A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string) => Effect.Effect<void, JsonStoreError, FileSystem.FileSystem> = Effect.fn("jsonStore.unset")(
  function* unset<A, I>(store: JsonStore<A>, schema: Schema.Codec<A, I>, key: string) {
    const encoded = yield* loadEncodedObject(store, schema)
    if (!Object.hasOwn(encoded, key)) {
      return yield* Console.log(`${key} is not set in ${store.path}`)
    }
    const { [key]: _removed, ...rest } = encoded
    const updated = yield* decodeWithoutExtraKeys(schema, rest).pipe(Effect.mapError((error) => invalid(store.path, `cannot unset ${key}: ${error.message}`)))
    yield* store.save(updated)
    yield* Console.log(`Unset ${key} in ${store.path}`)
  }
)

const keyArgument = Argument.String("key").pipe(Argument.withDescription("Top-level key"))

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
