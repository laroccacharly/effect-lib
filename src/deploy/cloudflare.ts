import { secret } from "../credentials/secret.ts"

// What every app needs to deploy its Worker. Apps declare the same names, so one `bun run deploy login` serves them all.

/** An account token with Workers Scripts Write, D1 Write, and Zone Read, DNS Write and Workers Routes Write on the app's zone. */
export const WorkerCloudflareApiToken = secret("WORKER_CLOUDFLARE_API_TOKEN", { label: "Cloudflare token that deploys Workers" })

/** A broader account token, for apps that deploy with the one they already use, like one that can also edit Email Routing. */
export const CloudflareApiToken = secret("CLOUDFLARE_API_TOKEN", { label: "Cloudflare API token" })

/** The account the Worker deploys into. */
export const CloudflareAccountId = secret("CLOUDFLARE_ACCOUNT_ID", { label: "Cloudflare account id", sensitive: false })
