import { Effect, Option, Schema } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { runToEnd } from "../shared/process.ts"

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

// Runs tailscale and returns its stdout; fails on a non-zero exit.
const tailscale: (args: readonly string[]) => Effect.Effect<string, TailscaleError, Spawner> = Effect.fn("tailscale")(function* tailscale(args: readonly string[]) {
  const { stdout, stderr, code } = yield* runToEnd(ChildProcess.make("tailscale", args)).pipe(
    Effect.mapError((cause) => new TailscaleError({ message: `could not run ${commandLine(args)}: ${String(cause)}` }))
  )
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

// The HTTPS ports with a mapping, web or TCP.
const takenPorts = (serveStatus: ServeStatus): ReadonlySet<number> =>
  new Set([...Object.keys(serveStatus.TCP ?? {}), ...Object.keys(serveStatus.Web ?? {}).map((hostPort) => hostPort.split(":").at(-1) ?? "")].map(Number))

// Where serveOnFreePort starts looking, above the ports apps pick by hand: 443, 8443 and the ones right after it.
export const firstAutomaticPort = 8460

// The HTTPS port already proxying to the server, so serving it again keeps its URL.
const portServing = (serveStatus: ServeStatus, serverPort: number): Option.Option<number> => {
  const web = Object.entries(serveStatus.Web ?? {}).find(([, config]) => config.Handlers?.["/"]?.Proxy === serverTarget(serverPort))
  return Option.map(Option.fromUndefinedOr(web), ([hostPort]) => Number(hostPort.split(":").at(-1)))
}

// The first HTTPS port from firstAutomaticPort up without a mapping.
const firstFreePort = (serveStatus: ServeStatus): Option.Option<number> => {
  const taken = takenPorts(serveStatus)
  for (let port = firstAutomaticPort; port <= 65_535; port++) {
    if (!taken.has(port)) {
      return Option.some(port)
    }
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

const readServeStatus = Effect.suspend(() => decodeOutput(ServeStatusJson, ["serve", "status", "--json"]))

const servedTarget = (tailscalePort: number) => readServeStatus.pipe(Effect.map((serveStatus) => targetOn(serveStatus, tailscalePort)))

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

// Publishes the local server on the first free HTTPS port from firstAutomaticPort up, unless a port already serves it, and returns that port.
// For servers started on demand, whose URL is printed at startup: the port, and so the URL, can change from one start to the next.
export const serveOnFreePort: (serverPort: number) => Effect.Effect<number, TailscaleError, Spawner> = Effect.fn("serveOnFreePort")(function* serveOnFreePort(serverPort: number) {
  const serveStatus = yield* readServeStatus
  // Left as it is, since serving it again would drop a Funnel set on it.
  const existing = portServing(serveStatus, serverPort)
  if (Option.isSome(existing)) {
    return existing.value
  }
  const tailscalePort = firstFreePort(serveStatus)
  if (Option.isNone(tailscalePort)) {
    return yield* new TailscaleError({ message: `no free https port from ${firstAutomaticPort} up` })
  }
  yield* tailscale(["serve", "--bg", `--https=${tailscalePort.value}`, serverTarget(serverPort)])
  return tailscalePort.value
})

// Stops publishing the HTTPS port only while it still proxies to the server, so a port another app took since is left alone; true when it did.
export const unserveIfOurs: (ports: Ports) => Effect.Effect<boolean, TailscaleError, Spawner> = Effect.fn("unserveIfOurs")(function* unserveIfOurs(ports: Ports) {
  const target = yield* servedTarget(ports.tailscalePort)
  if (Option.getOrUndefined(target) !== serverTarget(ports.serverPort)) {
    return false
  }
  // Only the root handler it checked: without a path, `off` also removes other apps mounted on the port.
  yield* tailscale(["serve", `--https=${ports.tailscalePort}`, "--set-path=/", "off"])
  return true
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
