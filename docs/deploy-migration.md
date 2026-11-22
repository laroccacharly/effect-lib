# Migrating the deploy API

## v0.41: secrets instead of credential bindings

A secret carries the name alchemy receives it as, so `Deploy.run` takes the secrets themselves:

- Replace `credentials: [{ secret: MySecret }]` with `secrets: [MySecret]`, and `credentials: []` with `secrets: []`.
- Replace a binding's `env: "OTHER_NAME"` with `exportAs: "OTHER_NAME"` on the secret: `secret("MY_SECRET", { exportAs: "OTHER_NAME" })`.
- Replace `Deploy.Cloudflare.deployCredentials()` with `Deploy.Cloudflare.deploySecrets()`.
- In a custom `verification`, replace `credentials: [{ secret: Url }]` with `secrets: [Url]`.
- The `CredentialBinding` type is gone; use `AppSecret`.

## v0.38: no Cloudflare by default

The deploy runner no longer assumes Cloudflare:

- Remove `cloudflare: false`. Non-Cloudflare apps do not need a platform flag.
- For Workers, add `...Deploy.Cloudflare.deploySecrets()` to `secrets`. If you previously set `cloudflareApiToken`, pass that secret's name to the helper.
- Replace `url: "MY_URL"` with `verification: Deploy.Cloudflare.workerHealth("MY_URL")` to keep the version-aware `/health` check. Other apps can inject their own `verification.wait`, or omit it if the stack already handles readiness. `deploy check` is available only when a verifier is configured.

Secret names in the vault and keyring do not change. See [the deploy example](../examples/deploy.ts) for a Worker configuration.
