# effect-lib

Small [Effect](https://effect.website) building blocks in one package, one subpath export each. `effect` (4.0.0) is a peer dependency.

```sh
bun add github:laroccacharly/effect-lib#<tag>
```

| Import | What it is |
| --- | --- |
| `effect-lib/credentials` | Typed secrets from the environment or the OS keyring, with `auth login | logout | status` commands |
| `effect-lib/json-store` | A JSON file decoded and encoded with an Effect `Schema`, written atomically |
| `effect-lib/pulse` | A client that pings the pulse server with `PULSE_API_KEY` |
| `effect-lib/systemd` | Install, reinstall, uninstall and inspect a systemd user service from an Effect CLI |

## credentials

Secrets an app declares by name, read from the environment variable of that name, otherwise from the OS keyring through `Bun.secrets`.

```ts
import * as Credentials from "effect-lib/credentials"

const OpenRouterKey = Credentials.secret("OPENROUTER_API_KEY", { label: "OpenRouter API key" })
const AdminEmail = Credentials.secret("ADMIN_EMAIL", { optional: true, sensitive: false, schema: Email })
const credentials = Credentials.make([OpenRouterKey, AdminEmail])

const key = yield* OpenRouterKey.resolve // Value<"OPENROUTER_API_KEY">: fails with reason "missing" when unset
const email = yield* AdminEmail.resolve // Option<Value<"ADMIN_EMAIL">>

const cli = Command.make("mybot").pipe(Command.withSubcommands([...credentials.commands, run]))

// At the entry point, with the platform layer:
program.pipe(Effect.provide(credentials.layer(Credentials.bunKeyring())))
```

The keyring is a `Keyring` service with no default: the app provides it, with `credentials.layer` or `Credentials.layer`. `make` takes the app's secrets once, so its commands cover the same names.

The types come from the declaration: the name becomes a brand, so a client taking `Value<"OPENROUTER_API_KEY">` rejects any other secret; `optional: true` makes `resolve` an `Option`; `schema` (a `Schema.Codec<A, string>`, default the text itself) decodes the trimmed text. A `Value` is a `Redacted`, so it never shows in logs.

Every app stores under one keyring service, `effect-lib/credentials`, with the variable name as the entry name: apps that declare the same name share the value, so logging in once is enough.

`credentials.commands` adds `auth login | logout | status`, plus `login` as a shortcut for `auth login`.

- `auth login` stores each secret the environment has, keeps what the keyring already has, and prompts for the rest (hidden input unless `sensitive: false`; empty skips an optional one). `--from-env` never prompts, for `cpass run -- mybot login`, and is implied without a terminal. `--force` prompts again, to rotate a key.
- `auth logout` removes them from the keyring, for every app that uses them.
- `auth status` prints where each comes from (`env`, `keyring` or missing) with a masked preview.

The same steps are Effects on `credentials`: `login(options)`, `logout`, `status`.

The keyring stays the source of truth; nothing is cached. A long-running process keeps its keyring connection, which goes stale when the keyring daemon restarts, so each read or write falls back to `Bun.secrets` in a fresh process (`process.execPath` with `BUN_BE_BUN=1`, so compiled binaries work too), and both are retried 3 times from 200ms while the daemon comes back. Failures are a `CredentialsError` whose `reason` is `missing`, `invalid` or `keyring`, so they stay distinct from the app's own `ConfigError`.

Tests swap the keyring and the environment:

```ts
effect.pipe(
  Effect.provide(Credentials.layer(Credentials.memoryKeyring({ OPENROUTER_API_KEY: "test" }))),
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({}))
)
```

`CREDENTIALS_SMOKE=1 bun test credentials` also round-trips through the real keyring, under its own service.

## json-store

A JSON file decoded and encoded with an Effect `Schema`.

```ts
import * as JsonStore from "effect-lib/json-store"

const settings = JsonStore.make("/home/me/.mybot/settings.json", Schema.Struct({ interval: Schema.Number }))

const current = yield* settings.load // Option<{ interval: number }>, none when the file is missing
yield* settings.save({ interval: 180 })
```

`save` writes pretty-printed JSON to a temporary file and renames it into place, creating the directory if needed (file `0o600`, directories `0o700`; override with `{ mode, directoryMode }`). Both need `FileSystem`, which `BunServices.layer` or `NodeServices.layer` provide. Failures are a `JsonStoreError` whose `reason` is `read`, `decode` or `write`.

## systemd

Run a long-lived command as a systemd user service, managed from an Effect CLI.

```ts
import { serviceCommand } from "effect-lib/systemd"

const service = serviceCommand({
  name: "mybot", // mybot.service
  description: "My bot",
  script: import.meta.filename, // runs `bun <script> <args>`
  args: ["run"],
  // Optional: environment, restart (on-failure), restartSec (30), wantedBy (default.target),
  // unitDir ($XDG_CONFIG_HOME/systemd/user), extra: { unit, service, install }
})

Command.make("mybot").pipe(Command.withSubcommands([service]))
```

This adds `mybot service install | reinstall | uninstall | status`. Pass `{ name: "daemon" }` as the second argument to rename the command.

Services are bun scripts, and the config has no way to name the runtime. `install` and `reinstall` write the first `bun` on `PATH` that is not inside a versioned install (`stableBun`): a mise shim or `latest` symlink, or `/usr/bin/bun`, never `…/bun/1.4.2/bin/bun`, which an upgrade deletes. So upgrading bun never breaks a unit. They fail when every `bun` on `PATH` is versioned.

The service runs with the systemd user manager's environment, not your shell's (`systemctl --user show-environment`). Its `PATH` always has `/usr/local/bin` and `/usr/bin`; on a desktop session it may hold more, but not before login or on a headless machine. Leave `environment` out unless the service needs it:

- It spawns programs by name from outside those directories (mise shims, `~/.cargo/bin`): pass a `PATH` with just the directories it needs, not a snapshot of your shell's.
- It reads settings from variables, like `PORT` or `LOG_LEVEL`. Keep secrets out of the unit, which is a plain file; point `extra: { service: { EnvironmentFile: "/abs/path/.env" } }` at a `0o600` file instead.

The same steps are exported as Effects (`install`, `reinstall`, `uninstall`, `status`, `isInstalled`). They need `FileSystem` and `ChildProcessSpawner`, which `BunServices.layer` or `NodeServices.layer` provide. `unitFile(config, bun)` renders the unit without touching the system. Arguments and values are quoted and escaped for systemd (whitespace, quotes, `%` and `$`).

## Adding a block

Put it in `src/<name>/index.ts` with a test in `test/<name>.test.ts`, add `"./<name>": "./src/<name>/index.ts"` to `exports`, and a row and section here. Blocks depend only on `effect` and `node:` built-ins; a block that needs more takes it as an optional peer dependency.

## Releasing

Consumers pin a tag, so a new version is a new specifier and bun fetches it rather than reusing a cached `main`.

```sh
bun run typecheck && bun run lint && bun test
# bump "version" in package.json, then:
git commit -am "<tag>" && git tag <tag> && git push origin main <tag>
```
