import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Schema } from "effect"
import { Command } from "effect/cli"
import { layer, memoryKeyring, secret } from "../src/credentials/index.ts"
import { type DeployOptions, make, type Settings } from "../src/deploy/index.ts"

const EmailAuthSecret = secret("EMAIL_AUTH_SECRET")
const PushToken = secret("PUSH_TOKEN", { optional: true })
const DeploySettings = Schema.Struct({ PUBLIC_URL: Schema.optionalKey(Schema.String) })

const storedCloudflare = { WORKER_CLOUDFLARE_API_TOKEN: "worker-token", CLOUDFLARE_ACCOUNT_ID: "account" }

// A project whose node_modules/.bin/alchemy records its arguments and environment instead of deploying.
const fakeAlchemy = `#!/bin/sh
printf '%s\\n' "$@" > alchemy-args
env > alchemy-env
exit \${FAKE_ALCHEMY_EXIT:-0}
`

let project = ""
const originalDirectory = process.cwd()
const originalEnv = { ...process.env }

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "deploy-"))
  await mkdir(join(project, "node_modules", ".bin"), { recursive: true })
  await writeFile(join(project, "node_modules", ".bin", "alchemy"), fakeAlchemy)
  await chmod(join(project, "node_modules", ".bin", "alchemy"), 0o755)
  process.chdir(project)
  process.env["XDG_CONFIG_HOME"] = join(project, "config")
})

afterEach(() => {
  process.chdir(originalDirectory)
  process.env = { ...originalEnv }
})

// Runs `bun run deploy <args>` with `env` as the secrets' environment and `stored` in the keyring, never the real ones.
const runDeploy = <S extends Settings>(options: DeployOptions<S>, args: ReadonlyArray<string>, env: Record<string, string> = {}, stored: Record<string, string> = storedCloudflare) => {
  const deploy = make(options)
  return Effect.runPromise(
    Command.runWith(deploy.command, { version: "0.0.0" })(args).pipe(
      Effect.provide(layer(memoryKeyring(stored))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
      Effect.provide(BunServices.layer)
    )
  )
}

const readEnvFile = async (name: string) => Object.fromEntries((await readFile(join(project, name), "utf8")).trim().split("\n").map((line) => line.split(/=(.*)/su).slice(0, 2)))

const alchemyArgs = async () => (await readFile(join(project, "alchemy-args"), "utf8")).trim().split("\n")

const exists = async (name: string) => await Bun.file(join(project, name)).exists()

const recordBuildEnv = ["sh", "-c", 'env > "$0"', "build-env"] as const

test("builds with the settings but no secret, then deploys with the keyring's token, the secrets and the settings", async () => {
  const options = { app: "demo", secrets: [EmailAuthSecret, PushToken], settings: DeploySettings, build: recordBuildEnv, stage: "prod" }
  await runDeploy(options, ["config", "set", "PUBLIC_URL", "https://demo.example.com"])
  process.env["CLOUDFLARE_API_TOKEN"] = "shell-token"
  await runDeploy(options, [], { EMAIL_AUTH_SECRET: "signing-secret" })

  const built = await readEnvFile("build-env")
  expect(built["PUBLIC_URL"]).toBe("https://demo.example.com")
  expect(built["CLOUDFLARE_API_TOKEN"]).toBeUndefined()
  expect(built["EMAIL_AUTH_SECRET"]).toBeUndefined()

  expect(await alchemyArgs()).toEqual(["deploy", "--yes", "--stage", "prod"])
  const deployed = await readEnvFile("alchemy-env")
  expect(deployed["CLOUDFLARE_API_TOKEN"]).toBe("worker-token")
  expect(deployed["CLOUDFLARE_ACCOUNT_ID"]).toBe("account")
  expect(deployed["EMAIL_AUTH_SECRET"]).toBe("signing-secret")
  expect(deployed["PUSH_TOKEN"]).toBeUndefined()
  expect(deployed["PUBLIC_URL"]).toBe("https://demo.example.com")
})

test("the build never sees a secret, even one exported in the shell", async () => {
  process.env["EMAIL_AUTH_SECRET"] = "shell-secret"
  process.env["WORKER_CLOUDFLARE_API_TOKEN"] = "shell-worker-token"
  await runDeploy({ app: "demo", secrets: [EmailAuthSecret], build: recordBuildEnv }, [], { EMAIL_AUTH_SECRET: "shell-secret" })
  const built = await readEnvFile("build-env")
  expect(built["EMAIL_AUTH_SECRET"]).toBeUndefined()
  expect(built["WORKER_CLOUDFLARE_API_TOKEN"]).toBeUndefined()
  expect((await readEnvFile("alchemy-env"))["EMAIL_AUTH_SECRET"]).toBe("shell-secret")
})

test("a variable in the shell wins over the saved setting", async () => {
  const options = { app: "demo", settings: DeploySettings }
  await runDeploy(options, ["config", "set", "PUBLIC_URL", "https://saved.example.com"])
  process.env["PUBLIC_URL"] = "https://shell.example.com"
  await runDeploy(options, [])
  expect((await readEnvFile("alchemy-env"))["PUBLIC_URL"]).toBe("https://shell.example.com")
})

test("a missing secret fails before building", async () => {
  const error = await runDeploy({ app: "demo", secrets: [EmailAuthSecret], build: recordBuildEnv }, []).catch((failure: Error) => failure)
  expect(String(error)).toContain("EMAIL_AUTH_SECRET")
  expect(await exists("build-env")).toBe(false)
  expect(await exists("alchemy-args")).toBe(false)
})

test("plan --adopt runs alchemy plan, with no build when none is wired", async () => {
  await runDeploy({ app: "demo" }, ["plan", "--adopt"])
  expect(await alchemyArgs()).toEqual(["plan", "--adopt"])
})

test("destroy leaves alchemy to ask before deleting", async () => {
  await runDeploy({ app: "demo", build: recordBuildEnv }, ["destroy"])
  expect(await alchemyArgs()).toEqual(["destroy"])
  expect(await exists("build-env")).toBe(false)
})

test("alchemy exiting with an error fails the deploy", async () => {
  process.env["FAKE_ALCHEMY_EXIT"] = "3"
  const error = await runDeploy({ app: "demo" }, []).catch((failure: Error) => failure)
  expect(String(error)).toContain("bunx alchemy deploy --yes exited with 3")
})
