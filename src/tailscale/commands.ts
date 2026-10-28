import { Console, Effect } from "effect"
import { Command, Flag } from "effect/cli"
import { terminalQrCode } from "./qr.ts"
import { publicUrl, serve, serveStatus, status, unserve, type Ports } from "./tailscale.ts"

export interface TailscaleCommandConfig<E, R, RHealth> {
  // The app's name, like memo, in the messages.
  readonly name: string
  // The app's ports, usually read from its config store.
  readonly ports: Effect.Effect<Ports, E, R>
  // One line on whether the local server is up, printed by install and status.
  readonly health?: (serverPort: number) => Effect.Effect<string, never, RHealth>
}

const qrFlag = Flag.Boolean("qr").pipe(Flag.withDefault(false), Flag.withDescription("Also print the URL as a QR code"))

const printUrl = Effect.fnUntraced(function* printUrl(tailscalePort: number, qr: boolean) {
  const url = yield* publicUrl(tailscalePort)
  yield* Console.log(`URL: ${url}`)
  if (qr) {
    yield* Console.log(yield* terminalQrCode(url))
  }
})

const printOutput = (title: string, output: string) => Console.log(`${title}:\n${output.trim() || "  (none)"}`)

// A `tailscale` command with install, status, url and uninstall subcommands, publishing the app's local server on the tailnet.
export const tailscaleCommand = <E, R, RHealth = never>(config: TailscaleCommandConfig<E, R, RHealth>, options: { readonly name?: string } = {}) => {
  const printHealth = (serverPort: number) => {
    if (config.health === undefined) {
      return Effect.void
    }
    return config.health(serverPort).pipe(Effect.flatMap(Console.log))
  }
  return Command.make(options.name ?? "tailscale").pipe(
    Command.withDescription(`Publish ${config.name} on the tailnet with Tailscale Serve`),
    Command.withSubcommands([
      Command.make("install", { qr: qrFlag }, ({ qr }) =>
        Effect.gen(function* () {
          const ports = yield* config.ports
          yield* serve(ports)
          yield* Console.log(`Serving ${config.name} (server port ${ports.serverPort}) on the tailnet at https port ${ports.tailscalePort}`)
          yield* printHealth(ports.serverPort)
          yield* printUrl(ports.tailscalePort, qr)
        })
      ).pipe(Command.withDescription(`Serve ${config.name} on the tailnet and print its URL`)),
      Command.make("status", {}, () =>
        Effect.gen(function* () {
          const ports = yield* config.ports
          yield* printOutput("Tailscale status", yield* status)
          yield* printOutput("Tailscale serve configuration", yield* serveStatus)
          yield* printHealth(ports.serverPort)
          yield* printUrl(ports.tailscalePort, false)
        })
      ).pipe(Command.withDescription(`Show Tailscale status, ${config.name}'s health and its URL`)),
      Command.make("url", { qr: qrFlag }, ({ qr }) => config.ports.pipe(Effect.flatMap((ports) => printUrl(ports.tailscalePort, qr)))).pipe(
        Command.withDescription(`Print ${config.name}'s URL on the tailnet`)
      ),
      Command.make("uninstall", {}, () =>
        Effect.gen(function* () {
          const ports = yield* config.ports
          yield* unserve(ports.tailscalePort)
          yield* Console.log(`Stopped serving ${config.name} on the tailnet at https port ${ports.tailscalePort}`)
        })
      ).pipe(Command.withDescription(`Stop serving ${config.name} on the tailnet`)),
    ])
  )
}
