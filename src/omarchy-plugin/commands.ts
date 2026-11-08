import { Command, Flag } from "effect/cli"
import type { PluginConfig } from "./config.ts"
import { install, reinstall, type Section, status, uninstall, validate } from "./plugin.ts"

const SECTIONS: ReadonlyArray<Section> = ["left", "center", "right"]

const section = Flag.Literals("section", SECTIONS).pipe(Flag.optional, Flag.withDescription("Where in the bar to put the widget"))

// A `plugin` command with install, reinstall, uninstall, status and validate subcommands.
// No app uses it yet; keep it for plugins that need nothing besides the link, like ones without a systemd service.
export const pluginCommand = (config: PluginConfig, options: { readonly name?: string } = {}) =>
  Command.make(options.name ?? "plugin").pipe(
    Command.withDescription("Manage this checkout as an omarchy-shell plugin"),
    Command.withSubcommands([
      Command.make("install", { section }, ({ section }) => install(config, section)).pipe(
        Command.withDescription("Link this checkout into the plugins dir and enable the widget. Safe to run repeatedly.")
      ),
      Command.make("reinstall", {}, () => reinstall(config)).pipe(Command.withDescription("Relink, enable and restart the shell so code changes load")),
      Command.make("uninstall", {}, () => uninstall(config)).pipe(Command.withDescription("Disable the widget and remove the link")),
      Command.make("status", {}, () => status(config)).pipe(Command.withDescription("Show the link, the shell and whether the widget is enabled")),
      Command.make("validate", {}, () => validate(config)).pipe(Command.withDescription("Check manifest.json with `omarchy plugin validate`")),
    ])
  )
