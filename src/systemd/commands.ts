import { Command } from "effect/cli"
import { install, reinstall, status, uninstall } from "./service.ts"
import { unitName, type ServiceConfig } from "./unit.ts"

// A `service` command with install, reinstall, uninstall and status subcommands.
export const serviceCommand = (config: ServiceConfig, options: { readonly name?: string } = {}) => {
  const unit = unitName(config)
  return Command.make(options.name ?? "service").pipe(
    Command.withDescription(`Manage ${unit} as a systemd user service`),
    Command.withSubcommands([
      Command.make("install", {}, () => install(config)).pipe(Command.withDescription(`Install ${unit}, enable it at login and start it`)),
      Command.make("reinstall", {}, () => reinstall(config)).pipe(Command.withDescription(`Rewrite ${unit} with the current settings and restart it`)),
      Command.make("uninstall", {}, () => uninstall(config)).pipe(Command.withDescription(`Stop, disable and remove ${unit}`)),
      Command.make("status", {}, () => status(config)).pipe(Command.withDescription(`Show whether ${unit} is running, with its latest log lines`)),
    ])
  )
}
