# TODO: breaking changes

These style-guide changes would break consumers, so they are not done yet. Ship them together in one release
(bump the minor version, e.g. 0.38.0), then update each consumer with
`bun remove effect-lib && bun add github:laroccacharly/effect-lib#v<version>` and the change listed below.

Consumers found in `~/Work` when this was written are listed per change; grep again before releasing.

## 1. The library stops providing its own services

Rule: functions require services in `R`; only entry points provide layers.

- `cloudflare-dns`: `layer()` provides `FetchHttpClient.layer` itself. Make it
  `Layer<HttpClient, never, HttpClient>`, wrapping whatever HttpClient the app provides.
  - Consumers (`lake`, `proxy`: `src/cli/index.ts`, `test/live/worker.live.ts`):
    `CloudflareDns.layer().pipe(Layer.provide(FetchHttpClient.layer))`.
- `deploy`: `waitForHealth` provides `CloudflareDns.layer()` itself. Make it require `HttpClient`; `Deploy.run` (an
  entry point) provides `CloudflareDns.layer()` with `FetchHttpClient.layer`.
  - Consumers of `Deploy.run`: no change. Anyone calling `Deploy.make` directly provides the HttpClient (none found
    outside this repo's tests).
- `logger`: `withLogger` provides `BunServices.layer`. Make it require `FileSystem`; `runMain` keeps providing it.
  - Consumers of `withLogger` provide `BunServices.layer` (none found).
- `portless`: `layer()` provides `BunHttpServer.layer`. Building the server is the layer's purpose, so either keep it
  and say so in its comment, or require `HttpServer` and leave the port to the app. Decide before releasing.

## 2. Side effects through services

- `deploy`: `commitVersion` runs `Bun.spawnSync`, outside any service. Use `ChildProcessSpawner`, like
  `runInTerminal`. `commitVersion` and `workerVersion` then require `ChildProcessSpawner`.
  - Consumers of `workerVersion` in a Worker's props (`food`, `lake`, `proxy`, `pulse`: `src/worker/index.ts`)
    provide `BunServices.layer` where alchemy evaluates the props.
  - Consumers of `commitVersion` in tests (`food/e2e/access.e2e.ts`, `lake` and `proxy` `test/live/worker.live.ts`):
    `Deploy.commitVersion(dir).pipe(Effect.provide(BunServices.layer))`.
- Environment variables are read with `process.env` inside library code: `settingsPath`, `unitPath`, `logger`'s `path`,
  and `stableBun`'s default search path all go through `src/shared/xdg.ts` or `process.env.PATH`. Read them with
  `Config` instead, so each of these becomes an `Effect` (and tests set them with a `ConfigProvider` rather than
  `process.env`).
  - `pibot/src/systemd.ts`: `const servicePath = unitPath(...)` becomes `yield* unitPath(...)` inside an Effect.
  - `ccf/src/backup/schedule.ts` passes `options.path` to `stableBun`, so only its error type may change.
- `portless`: `socketServer` uses `node:fs` sync calls. Use `FileSystem`, so the layer requires `FileSystem`.
  - `passkey-auth/src/control/server.ts`: provide `BunServices.layer` with `socketServer(socket)`.

## 3. Unused public exports

No consumer imports these. Some are used by this repo's tests, so test them through the public API instead, or
keep them on purpose:

- `credentials`: `vaultKeyring`, `inProcess`, `freshProcess`, `fromBackends`
- `stt`: `formatOf`
- `deploy`: `WorkerCloudflareApiToken`
