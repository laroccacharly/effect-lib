// A connection to the Secret Service (org.freedesktop.secrets) on a D-Bus session bus, with a plain transfer session.

import dbus from "@particle/dbus-next"
import { Effect, Redacted, Schema, type Scope } from "effect"
import { constVoid } from "effect/Function"
import { CredentialsError } from "../keyring.ts"

const SECRETS = "org.freedesktop.secrets"
export const SERVICE_PATH = "/org/freedesktop/secrets"
export const SERVICE_INTERFACE = "org.freedesktop.Secret.Service"
export const COLLECTION_INTERFACE = "org.freedesktop.Secret.Collection"
export const ITEM_INTERFACE = "org.freedesktop.Secret.Item"
// gnome-keyring's own interface: create and unlock with a password given in the call, where the standard API prompts.
export const GNOME_INTERFACE = "org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface"
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties"

const LOCKED_ERRORS = new Set(["org.freedesktop.Secret.Error.IsLocked", "org.gnome.keyring.Error.Denied"])

export interface CollectionOptions {
  // The session bus to reach the Secret Service on; defaults to $DBUS_SESSION_BUS_ADDRESS.
  readonly busAddress?: string
}

export interface Connection {
  readonly call: (path: string, iface: string, method: string, ...args: ReadonlyArray<object | string | boolean>) => Effect.Effect<object | string, CredentialsError>
  readonly property: (path: string, iface: string, name: string) => Effect.Effect<object | string | boolean, CredentialsError>
  // A Secret struct (session, parameters, value, content type) carrying `value` in this connection's session.
  readonly secret: (value: Redacted.Redacted<string>) => ReadonlyArray<string | Buffer>
  readonly session: string
}

const describe = <C>(cause: C) => {
  if (cause instanceof Error) {
    return cause.message
  }
  return String(cause)
}

const reasonOf = <C>(cause: C) => {
  if (cause instanceof dbus.DBusError && LOCKED_ERRORS.has(cause.type)) {
    return "locked"
  }
  return "keyring"
}

// A failure talking to the Secret Service, about `name` (a collection or a secret).
export const failure =
  (name: string, action: string) =>
  <C>(cause: C) =>
    new CredentialsError({ name, reason: reasonOf(cause), message: `could not ${action} (${describe(cause)}); this needs gnome-keyring on the session bus` })

const OpenSessionReply = Schema.Tuple([Schema.Unknown, Schema.String])

const busOptions = (options: CollectionOptions) => {
  if (options.busAddress === undefined) {
    return {}
  }
  return { busAddress: options.busAddress }
}

interface OpenBus {
  readonly bus: dbus.MessageBus
  // Rejects on the bus's first transport error, which dbus-next never turns into a rejection of the calls waiting on it.
  readonly broken: Promise<never>
}

const openBus = (name: string, options: CollectionOptions) =>
  Effect.acquireRelease(
    Effect.try({
      try: (): OpenBus => {
        const bus = dbus.sessionBus(busOptions(options))
        const broken = new Promise<never>((_resolve, reject) => bus.on("error", reject))
        // Only calls racing it observe the rejection.
        broken.catch(constVoid)
        return { bus, broken }
      },
      catch: failure(name, "connect to the session bus"),
    }),
    ({ bus }) => Effect.sync(() => bus.disconnect())
  )

// Opens the bus and a plain session for the scope; secrets cross the bus unencrypted, as with libsecret on a local bus.
export const connect = (name: string, options: CollectionOptions = {}): Effect.Effect<Connection, CredentialsError, Scope.Scope> =>
  Effect.gen(function* () {
    const { bus, broken } = yield* openBus(name, options)
    const invoke = async (path: string, iface: string, method: string, args: ReadonlyArray<object | string | boolean>) => {
      const proxy = await bus.getProxyObject(SECRETS, path)
      return await proxy.getInterface(iface)[method]?.(...args)
    }
    const call: Connection["call"] = (path, iface, method, ...args) =>
      Effect.tryPromise({
        try: async () => await Promise.race([broken, invoke(path, iface, method, args)]),
        catch: failure(name, `call ${method} on the Secret Service`),
      })
    const property: Connection["property"] = (path, iface, propertyName) =>
      call(path, PROPERTIES_INTERFACE, "Get", iface, propertyName).pipe(Effect.map((variant) => (variant as dbus.Variant<object | string | boolean>).value))
    const opened = yield* call(SERVICE_PATH, SERVICE_INTERFACE, "OpenSession", "plain", new dbus.Variant("s", ""))
    const [, session] = yield* Schema.decodeUnknownEffect(OpenSessionReply)(opened).pipe(Effect.mapError(failure(name, "open a Secret Service session")))
    const secret: Connection["secret"] = (value) => [session, Buffer.alloc(0), Buffer.from(Redacted.value(value)), "text/plain"]
    return { call, property, secret, session }
  })
