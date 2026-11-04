// Creates, locks and unlocks a Secret Service collection with a password given in the call; gnome-keyring only.

import dbus from "@particle/dbus-next"
import { Effect, Option, type Redacted, Schema } from "effect"
import { CredentialsError } from "../keyring.ts"
import { COLLECTION_INTERFACE, type CollectionOptions, type Connection, connect, failure, GNOME_INTERFACE, SERVICE_INTERFACE, SERVICE_PATH } from "./connection.ts"

export interface CollectionControl {
  readonly exists: Effect.Effect<boolean, CredentialsError>
  // Creates the collection, unlocked, with `password` as the password that unlocks it; fails with "exists" when it exists.
  readonly create: (password: Redacted.Redacted<string>) => Effect.Effect<void, CredentialsError>
  // These fail with "missing" when the collection does not exist.
  readonly isLocked: Effect.Effect<boolean, CredentialsError>
  readonly lock: Effect.Effect<void, CredentialsError>
  // Fails with "locked" when the password is not the collection's.
  readonly unlock: (password: Redacted.Redacted<string>) => Effect.Effect<void, CredentialsError>
}

const ObjectPath = Schema.String
const ObjectPaths = Schema.Array(ObjectPath)

// The object path of the collection labelled `collection`; gnome-keyring keeps no aliases but "default".
export const findCollection = (connection: Connection, collection: string) =>
  Effect.gen(function* () {
    const paths = yield* connection.property(SERVICE_PATH, SERVICE_INTERFACE, "Collections").pipe(Effect.flatMap(Schema.decodeUnknownEffect(ObjectPaths)))
    const labels = yield* Effect.forEach(paths, (path) => connection.property(path, COLLECTION_INTERFACE, "Label").pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.String))))
    return Option.fromUndefinedOr(paths[labels.indexOf(collection)])
  }).pipe(Effect.mapError(failure(collection, `find the ${collection} keyring`)))

const missing = (collection: string) =>
  new CredentialsError({ name: collection, reason: "missing", message: `the ${collection} keyring does not exist; create it first` })

const refused = (collection: string) =>
  new CredentialsError({ name: collection, reason: "locked", message: `the password does not unlock the ${collection} keyring; it stays locked` })

// UnlockWithMasterPassword answers a wrong password with Denied, which reads as "locked".
const explainRefusal = (collection: string, error: CredentialsError) => {
  if (error.reason === "locked") {
    return refused(collection)
  }
  return error
}

export const requireCollection = (connection: Connection, collection: string) =>
  findCollection(connection, collection).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.fail(missing(collection)), onSome: Effect.succeed })))

export const collectionIsLocked = (connection: Connection, collection: string, path: string) =>
  connection.property(path, COLLECTION_INTERFACE, "Locked").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)),
    Effect.mapError(failure(collection, `read whether the ${collection} keyring is locked`))
  )

// The Secret Service collection labelled `collection`, on the session bus.
export const collectionControl = (collection: string, options: CollectionOptions = {}): CollectionControl => {
  const connected = <A>(use: (connection: Connection) => Effect.Effect<A, CredentialsError>) => Effect.scoped(connect(collection, options).pipe(Effect.flatMap(use)))

  const exists = connected((connection) => findCollection(connection, collection).pipe(Effect.map(Option.isSome)))

  const create = (password: Redacted.Redacted<string>) =>
    connected((connection) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* findCollection(connection, collection))) {
          return yield* new CredentialsError({ name: collection, reason: "exists", message: `the ${collection} keyring already exists` })
        }
        const properties = { "org.freedesktop.Secret.Collection.Label": new dbus.Variant("s", collection) }
        const created = yield* connection.call(SERVICE_PATH, GNOME_INTERFACE, "CreateWithMasterPassword", properties, connection.secret(password))
        yield* Schema.decodeUnknownEffect(ObjectPath)(created).pipe(Effect.mapError(failure(collection, `create the ${collection} keyring`)))
      })
    )

  const isLocked = connected((connection) => requireCollection(connection, collection).pipe(Effect.flatMap((path) => collectionIsLocked(connection, collection, path))))

  const lock = connected((connection) =>
    requireCollection(connection, collection).pipe(
      Effect.flatMap((path) => connection.call(SERVICE_PATH, SERVICE_INTERFACE, "Lock", [path])),
      Effect.asVoid
    )
  )

  const unlock = (password: Redacted.Redacted<string>) =>
    connected((connection) =>
      requireCollection(connection, collection).pipe(
        Effect.flatMap((path) => connection.call(SERVICE_PATH, GNOME_INTERFACE, "UnlockWithMasterPassword", path, connection.secret(password))),
        Effect.asVoid,
        Effect.mapError((error) => explainRefusal(collection, error))
      )
    )

  return { exists, create, isLocked, lock, unlock }
}
