import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { defaultKeyring, memoryKeyring, vaultKeyring } from "../src/credentials/index.ts"
import { VaultAnswer, vaultServer } from "../src/credentials/vault/index.ts"

const directory = mkdtempSync(join(tmpdir(), "vault-test-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

let sockets = 0
const freshSocket = () => join(directory, `vault-${++sockets}.sock`)

// A vault holding VAULT_KEY, and LOCKED_KEY behind its lock.
const lookup = (name: string) => {
  if (name === "VAULT_KEY") {
    return Effect.succeed(VaultAnswer.cases.found.make({ value: "from-vault" }))
  }
  if (name === "LOCKED_KEY") {
    return Effect.succeed(VaultAnswer.cases.locked.make({ message: "unlock it with Face ID" }))
  }
  return Effect.succeed(VaultAnswer.cases.missing.make({}))
}

// Runs `effect` while a vault serves on `socket`.
const withVault = <A, E>(socket: string, effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.scoped(Layer.build(vaultServer(lookup, { socket })).pipe(Effect.andThen(effect))))

test("reads what the vault holds and falls back for the rest; writes only to the fallback", async () => {
  const socket = freshSocket()
  const fallback = memoryKeyring({ VAULT_KEY: "stale", OTHER_KEY: "from-fallback" })
  const keyring = defaultKeyring({ socket, fallback })
  const [vault, other, absent] = await withVault(socket, Effect.all([keyring.get("VAULT_KEY"), keyring.get("OTHER_KEY"), keyring.get("ABSENT_KEY")]))
  expect(vault).toEqual(Option.some("from-vault"))
  expect(other).toEqual(Option.some("from-fallback"))
  expect(absent).toEqual(Option.none())

  await withVault(socket, keyring.set("VAULT_KEY", "written"))
  expect(await Effect.runPromise(fallback.get("VAULT_KEY"))).toEqual(Option.some("written"))
})

test("a secret in the locked vault fails as locked instead of reading the fallback's copy", async () => {
  const socket = freshSocket()
  const keyring = defaultKeyring({ socket, fallback: memoryKeyring({ LOCKED_KEY: "stale" }) })
  const error = await withVault(socket, Effect.flip(keyring.get("LOCKED_KEY")))
  expect(error.reason).toBe("locked")
  expect(error.message).toContain("unlock it with Face ID")
})

test("with no vault running, everything comes from the fallback", async () => {
  const keyring = defaultKeyring({ socket: freshSocket(), fallback: memoryKeyring({ VAULT_KEY: "from-fallback" }) })
  expect(await Effect.runPromise(keyring.get("VAULT_KEY"))).toEqual(Option.some("from-fallback"))
})

test("vaultKeyring reads only the vault, fails without one, and never writes", async () => {
  const socket = freshSocket()
  const keyring = vaultKeyring({ socket })
  expect(await withVault(socket, keyring.get("VAULT_KEY"))).toEqual(Option.some("from-vault"))
  expect(await withVault(socket, keyring.get("ABSENT_KEY"))).toEqual(Option.none())
  expect((await Effect.runPromise(Effect.flip(keyring.get("VAULT_KEY")))).message).toContain("no vault is running")
  expect((await Effect.runPromise(Effect.flip(keyring.set("VAULT_KEY", "x")))).message).toContain("read-only")
})

test("a second vault on a live socket fails, and a left-over socket file is replaced", async () => {
  const socket = freshSocket()
  const second = Effect.scoped(Layer.build(vaultServer(lookup, { socket })))
  expect(await withVault(socket, Effect.flip(second))).toMatchObject({ _tag: "SocketServerError" })

  writeFileSync(socket, "")
  expect(await withVault(socket, vaultKeyring({ socket }).get("VAULT_KEY"))).toEqual(Option.some("from-vault"))
})

test("the socket only lets its user connect, and is gone once the vault stops", async () => {
  const socket = freshSocket()
  expect(await withVault(socket, Effect.sync(() => statSync(socket).mode & 0o777))).toBe(0o600)
  expect(existsSync(socket)).toBe(false)
})
