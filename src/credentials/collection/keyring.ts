// A Keyring over one Secret Service collection, with entries shaped like Bun.secrets' so tools such as secret-tool read them alike.

import dbus from "@particle/dbus-next"
import { Effect, Option, Redacted, Schema } from "effect"
import { CredentialsError, type Keyring, SERVICE } from "../keyring.ts"
import { type CollectionOptions, type Connection, connect, failure, COLLECTION_INTERFACE, ITEM_INTERFACE } from "./connection.ts"
import { collectionIsLocked, requireCollection } from "./control.ts"

export interface CollectionKeyringOptions extends CollectionOptions {
  // The `service` attribute of every entry; defaults to the one bunKeyring uses, so the same names are the same secrets.
  readonly service?: string
}

const BUN_SCHEMA = "com.oven-sh.bun.Secret"

const ItemPaths = Schema.Array(Schema.String)
const ItemAttributes = Schema.Record(Schema.String, Schema.String)

export interface CollectionKeyring extends Keyring {
  // The names stored under this service, sorted; listed while locked too, as the Secret Service shows attributes then.
  readonly names: Effect.Effect<ReadonlyArray<string>, CredentialsError>
}
const SecretReply = Schema.Tuple([Schema.String, Schema.Unknown, Schema.Uint8Array, Schema.String])

const lockedError = (collection: string, name: string) =>
  new CredentialsError({ name, reason: "locked", message: `the ${collection} keyring is locked; unlock it to use ${name}` })

// The collection's path, failing with "locked" when it is locked, as reading or writing it then would prompt.
const unlockedCollection = (connection: Connection, collection: string, name: string) =>
  Effect.gen(function* () {
    const path = yield* requireCollection(connection, collection)
    if (yield* collectionIsLocked(connection, collection, path)) {
      return yield* lockedError(collection, name)
    }
    return path
  })

// The entries of the Secret Service collection labelled `collection`; it must exist, and every call fails with "locked" while it is locked.
export const collectionKeyring = (collection: string, options: CollectionKeyringOptions = {}): CollectionKeyring => {
  const service = options.service ?? SERVICE
  const attributes = (name: string) => ({ "xdg:schema": BUN_SCHEMA, service, account: name })

  const connected = <A>(name: string, use: (connection: Connection, path: string) => Effect.Effect<A, CredentialsError>) =>
    Effect.scoped(
      connect(name, options).pipe(Effect.flatMap((connection) => unlockedCollection(connection, collection, name).pipe(Effect.flatMap((path) => use(connection, path)))))
    )

  const items = (connection: Connection, path: string, name: string) =>
    connection
      .call(path, COLLECTION_INTERFACE, "SearchItems", attributes(name))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ItemPaths)), Effect.mapError(failure(name, `search ${collection} for ${name}`)))

  const read = (connection: Connection, item: string, name: string) =>
    connection.call(item, ITEM_INTERFACE, "GetSecret", connection.session).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SecretReply)),
      Effect.mapError(failure(name, `read ${name} from ${collection}`)),
      Effect.map(([, , value]) => new TextDecoder().decode(value))
    )

  const get = (name: string) =>
    connected(name, (connection, path) =>
      items(connection, path, name).pipe(
        Effect.flatMap((found) => Option.match(Option.fromUndefinedOr(found[0]), { onNone: () => Effect.succeedNone, onSome: (item) => Effect.asSome(read(connection, item, name)) }))
      )
    )

  const set = (name: string, value: string) =>
    connected(name, (connection, path) => {
      const properties = {
        "org.freedesktop.Secret.Item.Label": new dbus.Variant("s", `${service}/${name}`),
        "org.freedesktop.Secret.Item.Attributes": new dbus.Variant("a{ss}", attributes(name)),
      }
      return connection.call(path, COLLECTION_INTERFACE, "CreateItem", properties, connection.secret(Redacted.make(value)), true).pipe(Effect.asVoid)
    })

  const remove = (name: string) =>
    connected(name, (connection, path) =>
      items(connection, path, name).pipe(
        Effect.tap((found) => Effect.forEach(found, (item) => connection.call(item, ITEM_INTERFACE, "Delete"), { discard: true })),
        Effect.map((found) => found.length > 0)
      )
    )

  const nameOf = (connection: Connection, item: string) =>
    connection.property(item, ITEM_INTERFACE, "Attributes").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ItemAttributes)),
      Effect.mapError(failure(collection, `read the entries of ${collection}`)),
      Effect.map((attributes) => Option.fromUndefinedOr(attributes["account"]).pipe(Option.filter(() => attributes["service"] === service)))
    )

  const names = Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* connect(collection, options)
      const path = yield* requireCollection(connection, collection)
      const items = yield* connection.property(path, COLLECTION_INTERFACE, "Items").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ItemPaths)),
        Effect.mapError(failure(collection, `list the entries of ${collection}`))
      )
      const found = yield* Effect.forEach(items, (item) => nameOf(connection, item))
      return found.flatMap(Option.toArray).toSorted()
    })
  )

  return { get, set, remove, names }
}
