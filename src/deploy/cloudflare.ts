import { secret } from "../credentials/secret.ts"

// What every app needs to deploy its Worker. Apps declare the same names, so one `bun run deploy login` serves them all.

/** The token alchemy deploys with, read from `name`: by default an account token with Workers Scripts Write, D1 Write, and Zone Read, DNS Write and Workers Routes Write on the app's zone. */
export const cloudflareApiToken = (name = "WORKER_CLOUDFLARE_API_TOKEN") => secret(name, { label: "Cloudflare token that deploys Workers" })

export const WorkerCloudflareApiToken = cloudflareApiToken()

/** The account the Worker deploys into. */
export const CloudflareAccountId = secret("CLOUDFLARE_ACCOUNT_ID", { label: "Cloudflare account id", sensitive: false })
