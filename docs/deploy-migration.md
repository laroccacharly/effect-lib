# Migrating to the v0.38 deploy API

The deploy runner no longer assumes Cloudflare. Update `Deploy.run` and `Deploy.make` calls before upgrading:

- Replace `secrets: [MySecret]` with `credentials: [{ secret: MySecret }]`. Set `env` on a binding if Alchemy expects a different variable name. Use `credentials: []` if Alchemy needs none.
- Remove `cloudflare: false`. Non-Cloudflare apps do not need a platform flag.
- For Workers, add `...Deploy.Cloudflare.deployCredentials()` to `credentials`. If you previously set `cloudflareApiToken`, pass that credential name to the helper.
- Replace `url: "MY_URL"` with `verification: Deploy.Cloudflare.workerHealth("MY_URL")` to keep the version-aware `/health` check. Other apps can inject their own `verification.wait`, or omit it if the stack already handles readiness. `deploy check` is available only when a verifier is configured.

Credential names in the vault and keyring do not change. See [the deploy example](../examples/deploy.ts) for a Worker configuration.
