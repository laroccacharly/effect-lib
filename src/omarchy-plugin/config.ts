import { join, resolve } from "node:path"
import { Effect, FileSystem, Schema } from "effect"
import { configHome } from "../shared/xdg.ts"
import { OmarchyPluginError } from "./error.ts"

export interface PluginConfig {
  // The checkout holding manifest.json, linked into the plugins dir.
  readonly root: string
  // Defaults to $XDG_CONFIG_HOME/omarchy/plugins.
  readonly pluginsDir?: string
}

export interface Plugin {
  readonly id: string
  readonly root: string
  readonly pluginsDir: string
  // pluginsDir/id, the symlink omarchy-shell discovers the checkout through.
  readonly link: string
}

const Manifest = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))

export const pluginsDir = (config: PluginConfig) => config.pluginsDir ?? join(configHome(), "omarchy", "plugins")

// The id comes from manifest.json, so it is read on every call instead of copied into the config.
export const loadPlugin: (config: PluginConfig) => Effect.Effect<Plugin, OmarchyPluginError, FileSystem.FileSystem> = Effect.fn("loadPlugin")(function* loadPlugin(
  config: PluginConfig
) {
  const fs = yield* FileSystem.FileSystem
  // Absolute, since the symlink's target is read relative to the plugins dir.
  const root = resolve(config.root)
  const path = join(root, "manifest.json")
  const { id } = yield* fs.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeEffect(Manifest)),
    Effect.mapError((cause) => new OmarchyPluginError({ message: `could not read the plugin id from ${path}: ${cause.message}` }))
  )
  const dir = pluginsDir(config)
  return { id, root, pluginsDir: dir, link: join(dir, id) }
})
