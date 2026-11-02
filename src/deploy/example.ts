// An app's `src/deploy/deploy.ts`, run as `bun run deploy` with `"deploy": "bun src/deploy/deploy.ts"` in package.json:
//
//   bun run deploy login                          stores the Cloudflare token and account id, and the app's secrets, in the OS keyring
//   bun run deploy config set PUBLIC_URL https://bench.example.com
//   bun run deploy plan                           builds, then shows what would change
//   bun run deploy                                builds, then deploys
//   bun run deploy status | logout | destroy
//
// alchemy gets CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, every secret and every setting as environment variables, so
// alchemy.run.ts and the Worker read them with `Config.String("PUBLIC_URL")` or `Config.Redacted("EMAIL_AUTH_SECRET")`.

import { Schema } from "effect"
import * as Credentials from "effect-lib/credentials"
import * as Deploy from "effect-lib/deploy"

/** Signs the sign-in links and the session cookies. */
const EmailAuthSecret = Credentials.secret("EMAIL_AUTH_SECRET", { label: "Secret that signs the sign-in links" })

/** cmail's key, which sends the sign-in emails; other apps declaring CMAIL_API_KEY share it. */
const CmailApiKey = Credentials.secret("CMAIL_API_KEY", { label: "cmail API key" })

const PublicUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^/\s]+$/u, { expected: "an https origin without a path, e.g. https://bench.example.com" }))

Deploy.run(
  {
    app: "bench",
    secrets: [EmailAuthSecret, CmailApiKey],
    // Saved in ~/.config/bench/deploy.json; a variable of the same name in the shell wins over it.
    settings: Schema.Struct({ PUBLIC_URL: Schema.optionalKey(PublicUrl) }),
    // Optional: omit it when the Worker has nothing to build.
    build: ["bun", "run", "build"],
  },
  { version: "1.0.0" }
)
