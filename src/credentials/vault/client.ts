// Apps reading secrets from a running vault, falling back to the OS keyring for the secrets the vault does not hold.

import { Effect, Option, Schema } from "effect"
import { bunKeyring, CredentialsError, type Keyring } from "../keyring.ts"
import { secretPath, VaultAnswer, type VaultOptions, vaultSocket } from "./protocol.ts"

const unreadable = (name: string, socket: string) => () =>
  new CredentialsError({ name, reason: "keyring", message: `the vault at ${socket} gave an unreadable answer about ${name}` })

// None when no vault listens on the socket.
const request = (socket: string, name: string) =>
  Effect.tryPromise(async () => await fetch(`http://vault${secretPath(name)}`, { unix: socket })).pipe(Effect.option)

const decodeAnswer = (name: string, socket: string, response: Response) =>
  Effect.tryPromise(async () => await response.text()).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(VaultAnswer))),
    Effect.mapError(unreadable(name, socket))
  )

// The vault's answer about `name`; none when there is no vault to ask.
const askVault = (name: string, options: VaultOptions) =>
  Effect.gen(function* () {
    const socket = yield* vaultSocket(options)
    if (Option.isNone(socket)) {
      return Option.none<VaultAnswer>()
    }
    const response = yield* request(socket.value, name)
    if (Option.isNone(response)) {
      return Option.none<VaultAnswer>()
    }
    return Option.some(yield* decodeAnswer(name, socket.value, response.value))
  })

// `missing` decides what a secret the vault does not hold resolves to.
const valueOf = (name: string, missing: Effect.Effect<Option.Option<string>, CredentialsError>) =>
  VaultAnswer.match({
    found: ({ value }) => Effect.succeedSome(value),
    missing: () => missing,
    locked: ({ message }) => Effect.fail(new CredentialsError({ name, reason: "locked", message: `${name} is in the vault, which is locked: ${message}` })),
    failed: ({ message }) => Effect.fail(new CredentialsError({ name, reason: "keyring", message: `the vault could not read ${name}: ${message}` })),
  })

const readOnly = (name: string) =>
  Effect.fail(new CredentialsError({ name, reason: "keyring", message: `the vault is read-only here: change ${name} with the vault's own commands` }))

// Only the vault: fails when none is running, and never writes.
export const vaultKeyring = (options: VaultOptions = {}): Keyring => {
  const notRunning = (name: string) =>
    new CredentialsError({ name, reason: "keyring", message: `no vault is running to read ${name} from; start it, or point EFFECT_LIB_VAULT at its socket` })

  return {
    get: (name) =>
      askVault(name, options).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(notRunning(name)), onSome: valueOf(name, Effect.succeedNone) }))
      ),
    set: readOnly,
    remove: readOnly,
  }
}

// The vault first, then `fallback` for what it does not hold, or for everything while no vault runs.
// A secret the locked vault holds fails rather than falling back, so a stale copy is never read; writes go to `fallback` only.
export const defaultKeyring = (options: VaultOptions & { readonly fallback?: Keyring } = {}): Keyring => {
  const fallback = options.fallback ?? bunKeyring()

  return {
    get: (name) =>
      askVault(name, options).pipe(Effect.flatMap(Option.match({ onNone: () => fallback.get(name), onSome: valueOf(name, fallback.get(name)) }))),
    set: fallback.set,
    remove: fallback.remove,
  }
}
