import { Schema } from "effect"
import { secret } from "../credentials/secret.ts"

// What every app needs to deploy its Worker. Apps declare the same names, so one `bun run deploy login` serves them all.

/** The token alchemy deploys with, read from `name`: by default an account token with Workers Scripts Write, D1 Write, and Zone Read, DNS Write and Workers Routes Write on the app's zone. */
export const cloudflareApiToken = (name = "WORKER_CLOUDFLARE_API_TOKEN") => secret(name, { label: "Cloudflare token that deploys Workers" })

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
