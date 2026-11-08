// Install, remove and inspect a checkout as an omarchy-shell plugin. Each logs its steps and returns what it changed.

import { Effect, type FileSystem, Option } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { loadPlugin, type Plugin, type PluginConfig } from "./config.ts"
import { OmarchyPluginError } from "./error.ts"
import { ensureLink, isRemovable, type LinkState, readLinkState, removeLink, removeStaleLink, staleIds } from "./link.ts"
import { statusLines } from "./status.ts"
import * as Shell from "./shell.ts"

type Services = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

export type Section = "left" | "center" | "right"

export interface StaleLinkRemoval {
  readonly id: string
  readonly path: string
  // The old id was enabled in the shell, so it was disabled first.
  readonly disabled: boolean
}

export interface InstallResult {
  readonly plugin: Plugin
  readonly removedStale: ReadonlyArray<StaleLinkRemoval>
  readonly linked: boolean
  readonly enabled: boolean
}

export interface UninstallResult {
  readonly plugin: Plugin
  readonly disabled: boolean
  readonly unlinked: boolean
}

export interface PluginStatus {
  readonly plugin: Plugin
  readonly link: LinkState
  readonly stale: ReadonlyArray<string>
  readonly shell: { readonly running: false } | { readonly running: true; readonly plugin: Option.Option<Shell.ShellPlugin> }
}

const removeStale = Effect.fnUntraced(function* removeStale(plugin: Plugin, id: string) {
  const disabled = yield* Shell.isEnabled(id)
  if (disabled) {
    yield* Shell.disable(id)
    yield* Effect.logInfo(`Disabled old id ${id}`)
  }
  const path = yield* removeStaleLink(plugin, id)
  yield* Effect.logInfo(`Removed stale link ${path}`)
  return { id, path, disabled } satisfies StaleLinkRemoval
})

const removeStaleLinks = Effect.fnUntraced(function* removeStaleLinks(plugin: Plugin) {
  const ids = yield* staleIds(plugin)
  return yield* Effect.forEach(ids, (id) => removeStale(plugin, id))
})

const waitForDiscovery = Effect.fnUntraced(function* waitForDiscovery(plugin: Plugin) {
  if (!(yield* Shell.rescanUntil(Shell.isDiscovered(plugin.id)))) {
    return yield* new OmarchyPluginError({ message: `the shell did not pick up ${plugin.id}; check the shell log` })
  }
})

// True when the link had to be created.
const linkCheckout = Effect.fnUntraced(function* linkCheckout(plugin: Plugin) {
  const linked = yield* ensureLink(plugin)
  if (linked) {
    yield* Effect.logInfo(`Linked ${plugin.link} -> ${plugin.root}`)
  }
  return linked
})

const enabledMessage = (plugin: Plugin, section: Option.Option<Section>) =>
  Option.match(section, { onNone: () => `Enabled ${plugin.id}`, onSome: (name) => `Enabled ${plugin.id} in the ${name} section` })

// True when it had to be enabled.
const ensureEnabled = Effect.fnUntraced(function* ensureEnabled(plugin: Plugin, section: Option.Option<Section>) {
  if (yield* Shell.isEnabled(plugin.id)) {
    yield* Effect.logInfo(`${plugin.id} is already enabled`)
    return false
  }
  yield* Shell.enable(plugin.id, section)
  yield* Effect.logInfo(enabledMessage(plugin, section))
  return true
})

// Validates the manifest with `omarchy plugin validate`.
export const validate: (config: PluginConfig) => Effect.Effect<void, OmarchyPluginError, Services> = Effect.fn("validate")(function* validate(config: PluginConfig) {
  yield* Shell.validate(config.root)
  yield* Effect.logInfo(`${config.root} is valid`)
})

// Links the checkout and enables it, in `section` of the bar when given. Safe to run repeatedly.
export const install: (config: PluginConfig, section?: Option.Option<Section>) => Effect.Effect<InstallResult, OmarchyPluginError, Services> = Effect.fn("install")(
  function* install(config: PluginConfig, section: Option.Option<Section> = Option.none()) {
    yield* Shell.requireShell
    yield* Shell.validate(config.root)
    const plugin = yield* loadPlugin(config)
    const removedStale = yield* removeStaleLinks(plugin)
    const linked = yield* linkCheckout(plugin)
    if (linked || removedStale.length > 0 || !(yield* Shell.isDiscovered(plugin.id))) {
      yield* waitForDiscovery(plugin)
    }
    const enabled = yield* ensureEnabled(plugin, section)
    return { plugin, removedStale, linked, enabled }
  }
)

const uninstalledMessage = (plugin: Plugin, changed: boolean) => {
  if (!changed) {
    return `${plugin.id} is not installed`
  }
  return "Uninstalled"
}

// Disables the plugin and removes the link, checking first that the link is this checkout's.
export const uninstall: (config: PluginConfig) => Effect.Effect<UninstallResult, OmarchyPluginError, Services> = Effect.fn("uninstall")(function* uninstall(config: PluginConfig) {
  yield* Shell.requireShell
  const plugin = yield* loadPlugin(config)
  const unlinked = yield* isRemovable(plugin)
  const disabled = yield* Shell.isEnabled(plugin.id)
  if (disabled) {
    yield* Shell.disable(plugin.id)
    yield* Effect.logInfo(`Disabled ${plugin.id}`)
  }
  if (unlinked) {
    yield* removeLink(plugin)
    yield* Effect.logInfo(`Removed ${plugin.link}`)
    yield* Shell.rescanUntil(Effect.map(Shell.isDiscovered(plugin.id), (discovered) => !discovered))
  }
  yield* Effect.logInfo(uninstalledMessage(plugin, disabled || unlinked))
  return { plugin, disabled, unlinked }
})

// Like install, then restarts the shell: its watcher does not follow symlinks and IPC handlers are frozen at
// first registration, so a restart is the only reliable way to load code changes.
export const reinstall: (config: PluginConfig) => Effect.Effect<InstallResult, OmarchyPluginError, Services> = Effect.fn("reinstall")(function* reinstall(config: PluginConfig) {
  yield* Shell.requireShell
  yield* Shell.validate(config.root)
  const plugin = yield* loadPlugin(config)
  const removedStale = yield* removeStaleLinks(plugin)
  const linked = yield* linkCheckout(plugin)
  const wasEnabled = yield* Shell.isEnabled(plugin.id)
  if (!wasEnabled) {
    yield* waitForDiscovery(plugin)
    yield* Shell.enable(plugin.id, Option.none())
    yield* Effect.logInfo(`Enabled ${plugin.id}`)
  }
  yield* Effect.logInfo("Restarting the shell to load the new code…")
  yield* Shell.restartShell
  return { plugin, removedStale, linked, enabled: !wasEnabled }
})

const readShell = Effect.fnUntraced(function* readShell(plugin: Plugin) {
  if (!(yield* Shell.isShellRunning)) {
    return { running: false } as const
  }
  const plugins = yield* Shell.listPlugins
  return { running: true, plugin: Option.fromUndefinedOr(plugins.get(plugin.id)) } as const
})

// Logs and returns the link, stale links and, when the shell is running, what it knows about the plugin.
export const status: (config: PluginConfig) => Effect.Effect<PluginStatus, OmarchyPluginError, Services> = Effect.fn("status")(function* status(config: PluginConfig) {
  const plugin = yield* loadPlugin(config)
  const link = yield* readLinkState(plugin.link, plugin.root)
  const stale = yield* staleIds(plugin)
  const shell = yield* readShell(plugin)
  const result: PluginStatus = { plugin, link, stale, shell }
  yield* Effect.forEach(statusLines(result), (line) => Effect.logInfo(line), { discard: true })
  return result
})
