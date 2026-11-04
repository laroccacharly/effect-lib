import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Option, Schema } from "effect"
import { Command } from "effect/cli"
import { layer, memoryKeyring, secret } from "../src/credentials/index.ts"
import { commitVersion, type DeployOptions, make, type Settings, workerVersion } from "../src/deploy/index.ts"

const EmailAuthSecret = secret("EMAIL_AUTH_SECRET")
const PushToken = secret("PUSH_TOKEN", { optional: true })
const DeploySettings = Schema.Struct({ PUBLIC_URL: Schema.optionalKey(Schema.String) })

// The deployed Worker: /health answers `served`, or a 503 when it is none.
let served = Option.none<string>()
let healthChecks = 0
const worker = Bun.serve({
  port: 0,
  routes: {
    "/health": () => {
      healthChecks++
      if (Option.isNone(served)) {
        return new Response("starting", { status: 503 })
      }
      return Response.json({ status: "ok", version: served.value })
    },
  },
})

afterAll(() => worker.stop(true))

const stored = { WORKER_CLOUDFLARE_API_TOKEN: "worker-token", CLOUDFLARE_ACCOUNT_ID: "account", DEMO_URL: worker.url.origin }

// A project whose node_modules/.bin/alchemy records its arguments and environment instead of deploying.
const fakeAlchemy = `#!/bin/sh
printf '%s\\n' "$@" > alchemy-args
env > alchemy-env
exit \${FAKE_ALCHEMY_EXIT:-0}
`

let project = ""
const originalDirectory = process.cwd()
const originalEnv = { ...process.env }

const git = (...args: ReadonlyArray<string>) => Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: project })

const projectVersion = () => Effect.runPromise(commitVersion(project))

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "deploy-"))
  await writeFile(join(project, "worker.ts"), "export default {}\n")
  git("init", "-q")
  git("add", "worker.ts")
  git("commit", "-qm", "first")
  await mkdir(join(project, "node_modules", ".bin"), { recursive: true })
  await writeFile(join(project, "node_modules", ".bin", "alchemy"), fakeAlchemy)
  await chmod(join(project, "node_modules", ".bin", "alchemy"), 0o755)
  process.chdir(project)
  process.env["XDG_CONFIG_HOME"] = join(project, "config")
  served = Option.some(await projectVersion())
  healthChecks = 0
})

afterEach(() => {
  process.chdir(originalDirectory)
  process.env = { ...originalEnv }
})

// Runs `bun run deploy <args>` with `env` as the secrets' environment and `stored` in the keyring, never the real ones.
const runDeploy = <S extends Settings>(options: DeployOptions<S>, args: ReadonlyArray<string>, env: Record<string, string> = {}, keyring: Record<string, string> = stored) => {
  const deploy = make(options)
  return Effect.runPromise(
    Command.runWith(deploy.command, { version: "0.0.0" })(args).pipe(
      Effect.provide(layer(memoryKeyring(keyring))),
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
  const options = { app: "demo", url: "DEMO_URL", secrets: [EmailAuthSecret, PushToken], settings: DeploySettings, build: recordBuildEnv, stage: "prod" }
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
  expect(deployed["DEMO_URL"]).toBe(worker.url.origin)
  expect(deployed["DEPLOY_VERSION"]).toBe(await projectVersion())
})

test("the deployed version is the commit, -dirty with uncommitted changes", async () => {
  const commit = git("rev-parse", "--short", "HEAD").stdout.toString().trim()
  expect(await projectVersion()).toBe(commit)
  await writeFile(join(project, "worker.ts"), "export default { changed: true }\n")
  served = Option.some(`${commit}-dirty`)
  await runDeploy({ app: "demo", url: "DEMO_URL" }, [])
  expect((await readEnvFile("alchemy-env"))["DEPLOY_VERSION"]).toBe(`${commit}-dirty`)
})

test("a Worker's version is DEPLOY_VERSION, the commit where it is unset", async () => {
  const versionWith = (env: Record<string, string>) => Effect.runPromise(workerVersion(project).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))))
  expect(await versionWith({ DEPLOY_VERSION: "abc1234" })).toBe("abc1234")
  expect(await versionWith({})).toBe(await projectVersion())
})

test("deploy waits until /health answers the version just deployed", async () => {
  const deployed = served
  served = Option.none()
  setTimeout(() => {
    served = Option.some("0000000")
  }, 200)
  setTimeout(() => {
    served = deployed
  }, 600)
  await runDeploy({ app: "demo", url: "DEMO_URL" }, [])
  expect(healthChecks).toBeGreaterThan(1)
})

test("deploy fails when /health still answers another version after 10 seconds", async () => {
  served = Option.some("04a40f3")
  const error = await runDeploy({ app: "demo", url: "DEMO_URL" }, []).catch((failure: Error) => failure)
  expect(String(error)).toContain(`${worker.url.origin}/health still answers 04a40f3, not ${await projectVersion()}`)
}, 15_000)

test("check waits for /health to answer this checkout's version, with only the url and no alchemy", async () => {
  const deployedVersion = await projectVersion()
  served = Option.none()
  setTimeout(() => {
    served = Option.some(deployedVersion)
  }, 300)
  await runDeploy({ app: "demo", url: "DEMO_URL", secrets: [EmailAuthSecret], build: recordBuildEnv }, ["check"], {}, { DEMO_URL: worker.url.origin })
  expect(healthChecks).toBeGreaterThan(1)
  expect(await exists("build-env")).toBe(false)
  expect(await exists("alchemy-args")).toBe(false)
})

test("a url that is no https origin fails before building", async () => {
  const error = await runDeploy({ app: "demo", url: "DEMO_URL", build: recordBuildEnv }, [], {}, { ...stored, DEMO_URL: "http://demo.example.com" }).catch((failure: Error) => failure)
  expect(String(error)).toContain("DEMO_URL")
  expect(await exists("build-env")).toBe(false)
})

test("a checkout outside git fails before building", async () => {
  await rm(join(project, ".git"), { recursive: true })
  const error = await runDeploy({ app: "demo", url: "DEMO_URL", build: recordBuildEnv }, []).catch((failure: Error) => failure)
  expect(String(error)).toContain("git describe failed")
  expect(await exists("build-env")).toBe(false)
})

test("an app can deploy with another token, such as CLOUDFLARE_API_TOKEN", async () => {
  await runDeploy({ app: "demo", url: "DEMO_URL", cloudflareApiToken: "CLOUDFLARE_API_TOKEN" }, [], {}, { ...stored, CLOUDFLARE_API_TOKEN: "app-token" })
  expect((await readEnvFile("alchemy-env"))["CLOUDFLARE_API_TOKEN"]).toBe("app-token")
})

test("the build never sees a secret, even one exported in the shell", async () => {
  process.env["EMAIL_AUTH_SECRET"] = "shell-secret"
  process.env["WORKER_CLOUDFLARE_API_TOKEN"] = "shell-worker-token"
  await runDeploy({ app: "demo", url: "DEMO_URL", secrets: [EmailAuthSecret], build: recordBuildEnv }, [], { EMAIL_AUTH_SECRET: "shell-secret" })
  const built = await readEnvFile("build-env")
  expect(built["EMAIL_AUTH_SECRET"]).toBeUndefined()
  expect(built["WORKER_CLOUDFLARE_API_TOKEN"]).toBeUndefined()
  expect((await readEnvFile("alchemy-env"))["EMAIL_AUTH_SECRET"]).toBe("shell-secret")
})

test("a variable in the shell wins over the saved setting", async () => {
  const options = { app: "demo", url: "DEMO_URL", settings: DeploySettings }
  await runDeploy(options, ["config", "set", "PUBLIC_URL", "https://saved.example.com"])
  process.env["PUBLIC_URL"] = "https://shell.example.com"
  await runDeploy(options, [])
  expect((await readEnvFile("alchemy-env"))["PUBLIC_URL"]).toBe("https://shell.example.com")
})

test("a missing secret fails before building", async () => {
  const error = await runDeploy({ app: "demo", url: "DEMO_URL", secrets: [EmailAuthSecret], build: recordBuildEnv }, []).catch((failure: Error) => failure)
  expect(String(error)).toContain("EMAIL_AUTH_SECRET")
  expect(await exists("build-env")).toBe(false)
  expect(await exists("alchemy-args")).toBe(false)
})

test("plan --adopt runs alchemy plan with the version, with no build when none is wired, and never asks /health", async () => {
  await runDeploy({ app: "demo", url: "DEMO_URL" }, ["plan", "--adopt"])
  expect(await alchemyArgs()).toEqual(["plan", "--adopt"])
  expect((await readEnvFile("alchemy-env"))["DEPLOY_VERSION"]).toBe(await projectVersion())
  expect(healthChecks).toBe(0)
})

test("destroy leaves alchemy to ask before deleting", async () => {
  await runDeploy({ app: "demo", url: "DEMO_URL", build: recordBuildEnv }, ["destroy"])
  expect(await alchemyArgs()).toEqual(["destroy"])
  expect(await exists("build-env")).toBe(false)
  expect(healthChecks).toBe(0)
})

test("alchemy exiting with an error fails the deploy", async () => {
  process.env["FAKE_ALCHEMY_EXIT"] = "3"
  const error = await runDeploy({ app: "demo", url: "DEMO_URL" }, []).catch((failure: Error) => failure)
  expect(String(error)).toContain("bunx alchemy deploy --yes exited with 3")
})
