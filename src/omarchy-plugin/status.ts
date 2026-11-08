// The lines `status` logs.

import { Option } from "effect"
import type { LinkState } from "./link.ts"
import type { PluginStatus } from "./plugin.ts"
import type { ShellPlugin } from "./shell.ts"

const describeLink = (path: string, link: LinkState) => {
  switch (link._tag) {
    case "Missing":
      return "missing"
    case "NotALink":
      return `${path} (not a symlink)`
    case "Ours":
      return `${path} -> ${link.target}`
    case "Elsewhere":
      return `${path} -> ${link.target} (not this checkout)`
  }
}

const describeShellPlugin = (plugin: Option.Option<ShellPlugin>) =>
  Option.match(plugin, {
    onNone: () => "not discovered",
    onSome: ({ enabled }) => {
      if (enabled) {
        return "enabled"
      }
      return "known, disabled"
    },
  })

const shellLines = (shell: PluginStatus["shell"]) => {
  if (!shell.running) {
    return ["shell:   not running"]
  }
  return ["shell:   running", `plugin:  ${describeShellPlugin(shell.plugin)}`]
}

export const statusLines = ({ plugin, link, stale, shell }: PluginStatus) => [
  `id:      ${plugin.id}`,
  `link:    ${describeLink(plugin.link, link)}`,
  ...stale.map((id) => `stale:   ${plugin.pluginsDir}/${id}`),
  ...shellLines(shell),
]
