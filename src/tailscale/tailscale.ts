import { Effect, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class TailscaleError extends Schema.TaggedError<TailscaleError>()("TailscaleError", {
  message: Schema.String,
}) {}

// An HTTPS port Tailscale Serve publishes on; add it to an app's config schema as `tailscalePort`, with the app's own default.
export const TailscalePort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))

// The two ports of an app on the tailnet: the local server's, and the HTTPS one Tailscale Serve publishes it on.
export interface Ports {
  readonly serverPort: number
  readonly tailscalePort: number
}

const StatusJson = Schema.fromJsonString(Schema.Struct({ Self: Schema.Struct({ DNSName: Schema.String }) }))

const Handler = Schema.Struct({ Proxy: Schema.optionalKey(Schema.String) })

// The slice of `tailscale serve status --json` that tells which HTTPS ports are taken and what they serve.
const ServeStatusJson = Schema.fromJsonString(
  Schema.Struct({
    TCP: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    Web: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ Handlers: Schema.optionalKey(Schema.Record(Schema.String, Handler)) }))),
  })
)

type ServeStatus = typeof ServeStatusJson.Type

type Spawner = ChildProcessSpawner.ChildProcessSpawner

const commandLine = (args: readonly string[]) => `tailscale ${args.join(" ")}`

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

// Runs tailscale and returns its stdout, kept apart from stderr so warnings never corrupt JSON output; fails on a non-zero exit.
const tailscale: (args: readonly string[]) => Effect.Effect<string, TailscaleError, Spawner> = Effect.fn("tailscale")(function* tailscale(args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [stdout, stderr, code] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("tailscale", args))
      return yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 3 })
    })
  ).pipe(Effect.mapError((cause) => new TailscaleError({ message: `could not run ${commandLine(args)}: ${String(cause)}` })))
  if (code !== 0) {
    return yield* new TailscaleError({ message: `${commandLine(args)} exited with ${code}: ${(stderr || stdout).trim()}` })
  }
  return stdout
})

const decodeOutput = <A>(schema: Schema.Decoder<A>, args: readonly string[]) =>
  tailscale(args).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) => new TailscaleError({ message: `could not read ${commandLine(args)}: ${error.message}` }))
  )

const serverTarget = (serverPort: number) => `http://127.0.0.1:${serverPort}`

// What the HTTPS port serves at `/`, like http://127.0.0.1:3000; none when the port is free.
const targetOn = (serveStatus: ServeStatus, tailscalePort: number): Option.Option<string> => {
  const web = Object.entries(serveStatus.Web ?? {}).find(([hostPort]) => hostPort.endsWith(`:${tailscalePort}`))
  if (web !== undefined) {
    return Option.some(web[1].Handlers?.["/"]?.Proxy ?? "something other than a proxy")
  }
  if (Object.hasOwn(serveStatus.TCP ?? {}, `${tailscalePort}`)) {
    return Option.some("a TCP forward")
  }
  return Option.none()
}

// The public HTTPS URL for a tailnet DNS name, without the port when it is 443.
export const urlFromDnsName = (dnsName: string, tailscalePort: number): string => {
  const host = dnsName.replace(/\.$/u, "")
  if (tailscalePort === 443) {
    return `https://${host}`
  }
  return `https://${host}:${tailscalePort}`
}

const servedTarget = (tailscalePort: number) => decodeOutput(ServeStatusJson, ["serve", "status", "--json"]).pipe(Effect.map((serveStatus) => targetOn(serveStatus, tailscalePort)))

// Fails when the HTTPS port already serves something other than this server, so two apps never clobber each other.
const ensurePortFree: (ports: Ports) => Effect.Effect<void, TailscaleError, Spawner> = Effect.fn("ensurePortFree")(function* ensurePortFree(ports: Ports) {
  const target = yield* servedTarget(ports.tailscalePort)
  if (Option.isSome(target) && target.value !== serverTarget(ports.serverPort)) {
    return yield* new TailscaleError({
      message: `https port ${ports.tailscalePort} already serves ${target.value}; pick another one with \`config set tailscalePort <port>\``,
    })
  }
})

// Publishes the local server on the tailnet; Tailscale keeps the mapping across reboots, and rerunning it is a no-op.
export const serve: (ports: Ports) => Effect.Effect<void, TailscaleError, Spawner> = Effect.fn("serve")(function* serve(ports: Ports) {
  yield* ensurePortFree(ports)
  yield* tailscale(["serve", "--bg", `--https=${ports.tailscalePort}`, serverTarget(ports.serverPort)])
})

// Stops publishing the HTTPS port, leaving the others alone; a no-op when nothing is served on it, since `serve ... off` would fail.
export const unserve: (tailscalePort: number) => Effect.Effect<void, TailscaleError, Spawner> = Effect.fn("unserve")(function* unserve(tailscalePort: number) {
  if (Option.isNone(yield* servedTarget(tailscalePort))) {
    return
  }
  yield* tailscale(["serve", `--https=${tailscalePort}`, "off"])
})

// The output of `tailscale status`, which fails when tailscale is stopped or logged out.
export const status: Effect.Effect<string, TailscaleError, Spawner> = Effect.suspend(() => tailscale(["status"]))

// The output of `tailscale serve status`, every HTTPS port this machine publishes.
export const serveStatus: Effect.Effect<string, TailscaleError, Spawner> = Effect.suspend(() => tailscale(["serve", "status"]))

// The URL the tailnet reaches the HTTPS port at, like https://pi.tailnet.ts.net:8443.
export const publicUrl: (tailscalePort: number) => Effect.Effect<string, TailscaleError, Spawner> = Effect.fn("publicUrl")(function* publicUrl(tailscalePort: number) {
  const parsed = yield* decodeOutput(StatusJson, ["status", "--json"])
  return urlFromDnsName(parsed.Self.DNSName, tailscalePort)
})
