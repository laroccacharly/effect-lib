import { Console, Effect, Redacted, Schema } from "effect"
import { secret } from "../credentials/secret.ts"
import { waitForHealth } from "./health.ts"
import type { AppSecret, Verification } from "./make.ts"

// What every app needs to deploy its Worker. Apps declare the same names, so one `bun run deploy login` serves them all.

/** The token alchemy deploys with, read from `name` and passed as CLOUDFLARE_API_TOKEN, which effect-lib strips from the shell so a broader token is never used by accident: by default an account token with Workers Scripts Write, D1 Write, and Zone Read, DNS Write and Workers Routes Write on the app's zone. */
export const cloudflareApiToken = (name = "WORKER_CLOUDFLARE_API_TOKEN") => secret(name, { label: "Cloudflare token that deploys Workers", exportAs: "CLOUDFLARE_API_TOKEN" })

export const WorkerCloudflareApiToken = cloudflareApiToken()

// An https origin without a path, e.g. `https://proxy.example.com`, or a local Worker, e.g. `http://localhost:1340`.
const Origin = Schema.String.check(
  Schema.isPattern(/^(?:https:\/\/[^/\s]+|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/u, {
    expected: "an https origin without a path, e.g. https://proxy.example.com, or http://localhost:<port>",
  })
)

/** Where the deployed Worker is reached, read from `name`, like `PROXY_URL`; an app's CLI declaring the same name shares it. */
export const workerUrl = (name: string) => secret(name, { label: "Worker URL", schema: Origin, sensitive: false })

/** The account the Worker deploys into. */
export const CloudflareAccountId = secret("CLOUDFLARE_ACCOUNT_ID", { label: "Cloudflare account id", sensitive: false })

export const deploySecrets = (tokenName?: string): ReadonlyArray<AppSecret> => [cloudflareApiToken(tokenName), CloudflareAccountId]

export const workerHealth = (urlName: string): Verification => {
  const url = workerUrl(urlName)
  return {
    secrets: [url],
    wait: ({ version }) =>
      Effect.gen(function* () {
        const origin = Redacted.value(yield* url.resolve)
        const healthUrl = yield* waitForHealth(origin, version)
        yield* Console.log(`${healthUrl} answers ${version}`)
      }),
  }
}
