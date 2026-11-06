#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import packageJson from "../package.json" with { type: "json" }
import { layer } from "./credentials/keyring.ts"
import { defaultKeyring } from "./credentials/vault/client.ts"
import { keyringCommand } from "./keyring-command.ts"

const elib = Command.make("elib").pipe(Command.withSubcommands([keyringCommand]))

Command.run(elib, { version: packageJson.version }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, layer(defaultKeyring()))), BunRuntime.runMain)
