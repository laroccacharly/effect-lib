import { Console, Effect } from "effect"
import { Command } from "effect/cli"
import { install, isInstalled, reinstall, status, uninstall } from "./service.ts"
import { unitName, type ServiceConfig } from "./unit.ts"

const installAndReport = (config: ServiceConfig) =>
  install(config).pipe(Effect.andThen(Console.log(`Installed and started ${unitName(config)}; follow it with \`journalctl --user -u ${config.name} -f\``)))

const reinstallAndReport = (config: ServiceConfig) => reinstall(config).pipe(Effect.andThen(Console.log(`Rewrote and restarted ${unitName(config)}`)))

const uninstallAndReport = Effect.fnUntraced(function* uninstallAndReport(config: ServiceConfig) {
  if (yield* uninstall(config)) {
    return yield* Console.log(`Stopped and removed ${unitName(config)}`)
  }
  yield* Console.log(`${unitName(config)} is not installed`)
})

const statusIfInstalled = Effect.fnUntraced(function* statusIfInstalled(config: ServiceConfig) {
  if (!(yield* isInstalled(config))) {
    return yield* Console.log(`${unitName(config)} is not installed`)
  }
  yield* status(config)
})

// A `service` command with install, reinstall, uninstall and status subcommands.
export const serviceCommand = (config: ServiceConfig, options: { readonly name?: string } = {}) => {
  const unit = unitName(config)
  return Command.make(options.name ?? "service").pipe(
    Command.withDescription(`Manage ${unit} as a systemd user service`),
    Command.withSubcommands([
      Command.make("install", {}, () => installAndReport(config)).pipe(Command.withDescription(`Install ${unit}, enable it at login and start it`)),
      Command.make("reinstall", {}, () => reinstallAndReport(config)).pipe(Command.withDescription(`Rewrite ${unit} with the current settings and restart it`)),
      Command.make("uninstall", {}, () => uninstallAndReport(config)).pipe(Command.withDescription(`Stop, disable and remove ${unit}`)),
      Command.make("status", {}, () => statusIfInstalled(config)).pipe(Command.withDescription(`Show whether ${unit} is running, with its latest log lines`)),
    ])
  )
}
