// An app's `src/deploy/deploy.ts`, run as `bun run deploy` with `"deploy": "bun src/deploy/deploy.ts"` in package.json:
//
//   bun run deploy login                          stores the Cloudflare token and account id, the Worker's url and the app's secrets, in the OS keyring
//   bun run deploy config set EMAIL_FROM sign-in@example.com
//   bun run deploy plan                           builds, then shows what would change
//   bun run deploy                                builds, deploys, then waits for BENCH_URL/health to answer the deployed version
//   bun run deploy status | logout | destroy
//
// alchemy gets CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, the url, every secret and every setting as environment
// variables, so alchemy.run.ts and the Worker read them with `Config.String("BENCH_URL")` or
// `Config.Redacted("EMAIL_AUTH_SECRET")`. On `deploy` and `plan` it gets DEPLOY_VERSION too, the commit from
// `git describe --always --dirty`: the Worker's /health answers it as JSON `{ "version": … }`. Where DEPLOY_VERSION is
// unset, as under `alchemy dev`, `Deploy.commitVersion()` gives the same value.

import { Schema } from "effect"
import * as Credentials from "effect-lib/credentials"
import * as Deploy from "effect-lib/deploy"

/** Where the Worker is reached; the CLI reads it too. */
const BenchUrl = Credentials.secret("BENCH_URL", {
  label: "bench Worker URL",
  schema: Schema.String.check(Schema.isPattern(/^https:\/\/[^/\s]+$/u, { expected: "an https origin without a path, e.g. https://bench.example.com" })),
  sensitive: false,
})

/** Signs the sign-in links and the session cookies. */
const EmailAuthSecret = Credentials.secret("EMAIL_AUTH_SECRET", { label: "Secret that signs the sign-in links" })

/** cmail's key, which sends the sign-in emails; other apps declaring CMAIL_API_KEY share it. */
const CmailApiKey = Credentials.secret("CMAIL_API_KEY", { label: "cmail API key" })

Deploy.run(
  {
    app: "bench",
    url: BenchUrl,
    secrets: [EmailAuthSecret, CmailApiKey],
    // Saved in ~/.config/bench/deploy.json; a variable of the same name in the shell wins over it.
    settings: Schema.Struct({ EMAIL_FROM: Schema.optionalKey(Schema.String) }),
    // Optional: omit it when the Worker has nothing to build.
    build: ["bun", "run", "build"],
  },
  { version: "1.0.0" }
)
