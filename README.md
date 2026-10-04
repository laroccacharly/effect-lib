# effect-lib

Small [Effect](https://effect.website) building blocks in one package, one subpath export each. `effect` (4.0.0) is a peer dependency.

```sh
bun add github:laroccacharly/effect-lib#v0.1.0
```

| Import | What it is |
| --- | --- |
| `effect-lib/json-store` | A JSON file decoded and encoded with an Effect `Schema`, written atomically |
| `effect-lib/systemd` | Install, reinstall, uninstall and inspect a systemd user service from an Effect CLI |

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
  command: [process.execPath, import.meta.filename, "run"],
  // Optional: environment, restart (on-failure), restartSec (30), wantedBy (default.target),
  // unitDir ($XDG_CONFIG_HOME/systemd/user), extra: { unit, service, install }
})

Command.make("mybot").pipe(Command.withSubcommands([service]))
```

This adds `mybot service install | reinstall | uninstall | status`. Pass `{ name: "daemon" }` as the second argument to rename the command.

The service runs with the systemd user manager's environment, not your shell's (`systemctl --user show-environment`). Its `PATH` always has `/usr/local/bin` and `/usr/bin`; on a desktop session it may hold more, but not before login or on a headless machine. Leave `environment` out unless the service needs it:

- It spawns programs by name from outside those directories (mise shims, `~/.cargo/bin`): pass a `PATH` with just the directories it needs, not a snapshot of your shell's.
- It reads settings from variables, like `PORT` or `LOG_LEVEL`. Keep secrets out of the unit, which is a plain file; point `extra: { service: { EnvironmentFile: "/abs/path/.env" } }` at a `0o600` file instead.

The same steps are exported as Effects (`install`, `reinstall`, `uninstall`, `status`, `isInstalled`). They need `FileSystem` and `ChildProcessSpawner`, which `BunServices.layer` or `NodeServices.layer` provide. `unitFile(config)` renders the unit without touching the system. Arguments and values are quoted and escaped for systemd (whitespace, quotes, `%` and `$`).

## Adding a block

Put it in `src/<name>/index.ts` with a test in `test/<name>.test.ts`, add `"./<name>": "./src/<name>/index.ts"` to `exports`, and a row and section here. Blocks depend only on `effect` and `node:` built-ins; a block that needs more takes it as an optional peer dependency.

## Releasing

Consumers pin a tag, so a new version is a new specifier and bun fetches it rather than reusing a cached `main`.

```sh
bun run typecheck && bun run lint && bun test
# bump "version" in package.json, then:
git commit -am "v0.2.0" && git tag v0.2.0 && git push origin main v0.2.0
```
