// A private session bus whose Secret Service keeps its keyrings in a temporary directory, for tests that must not touch the user's.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, type Scope } from "effect"
import { CredentialsError } from "../keyring.ts"

export interface IsolatedSecretService {
  // Pass as `busAddress` to collectionKeyring and collectionControl.
  readonly busAddress: string
  // Where its keyring files are written: one `<label>.keyring` per collection.
  readonly keyringsDirectory: string
}

const firstLine = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true })
    if (text.includes("\n")) {
      break
    }
  }
  return text.split("\n")[0]?.trim() ?? ""
}

const temporaryDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "secret-service-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
)

// dbus-daemon on its own bus; it starts gnome-keyring-daemon on the first call, through its D-Bus activation file, with this environment.
const startBus = (directory: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(["dbus-daemon", "--session", "--nofork", "--print-address=1"], {
        env: { ...process.env, XDG_DATA_HOME: directory, XDG_RUNTIME_DIR: directory, DBUS_SESSION_BUS_ADDRESS: "" },
        stdout: "pipe",
        stderr: "ignore",
      })
    ),
    (daemon) => Effect.promise(async () => {
      daemon.kill()
      await daemon.exited
    })
  )

// The bus and the keyrings go away when the scope closes; gnome-keyring-daemon exits with its bus.
export const isolatedSecretService: Effect.Effect<IsolatedSecretService, CredentialsError, Scope.Scope> = Effect.gen(function* () {
  const directory = yield* temporaryDirectory
  const daemon = yield* startBus(directory)
  const busAddress = yield* Effect.promise(async () => await firstLine(daemon.stdout))
  if (busAddress === "") {
    return yield* new CredentialsError({ name: "dbus-daemon", reason: "keyring", message: "dbus-daemon did not print its address; is dbus installed?" })
  }
  return { busAddress, keyringsDirectory: join(directory, "keyrings") }
})
