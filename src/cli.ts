#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { Argument, Command } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import packageJson from "../package.json" with { type: "json" }
import { bunKeyring, type CredentialsError, type Keyring, layer, secret } from "./credentials/index.ts"

export class ClipboardError extends Schema.TaggedError<ClipboardError>()("ClipboardError", {
  message: Schema.String,
}) {}

const clipboardCommand = () => {
  if (process.platform === "darwin") {
    return "pbcopy"
  }
  return "wl-copy"
}

// The text goes over stdin, so it never shows in argv. Not detached, so closing the scope leaves wl-copy's forked clipboard server alive.
const copyToClipboard: (text: string) => Effect.Effect<void, ClipboardError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("copyToClipboard")(function* copyToClipboard(text: string) {
  const command = clipboardCommand()
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const code = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, [], { stdin: Stream.make(new TextEncoder().encode(text)), stdout: "ignore", stderr: "inherit", detached: false }))
      return yield* handle.exitCode
    })
  ).pipe(Effect.mapError((cause) => new ClipboardError({ message: `could not run ${command}: ${cause.message}` })))
  if (code !== 0) {
    return yield* new ClipboardError({ message: `${command} exited with ${code}` })
  }
})

// Copies the secret `name` to the clipboard: the environment first, then the keyring, like any app reading it.
const copyKey: (name: string) => Effect.Effect<void, CredentialsError | ClipboardError, Keyring | ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("keyring.cp")(function* copyKey(
  name: string
) {
  const value = yield* secret(name).resolve
  yield* copyToClipboard(Redacted.value(value))
  yield* Console.log(`Copied ${name} to the clipboard`)
})

const keyringCommand = Command.make("keyring").pipe(
  Command.withDescription("Read the OS keyring entries shared by effect-lib apps"),
  Command.withSubcommands([
    Command.make("cp", { name: Argument.String("name").pipe(Argument.withDescription("Key name, like MY_API_KEY")) }, ({ name }) => copyKey(name)).pipe(
      Command.withDescription("Copy a key from the keyring to the clipboard")
    ),
  ])
)

const elib = Command.make("elib").pipe(Command.withSubcommands([keyringCommand]))

Command.run(elib, { version: packageJson.version }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, layer(bunKeyring()))), BunRuntime.runMain)
