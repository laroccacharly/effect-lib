import { join } from "node:path"
import { Effect, type FileSystem, Option, type Schema } from "effect"
import type { JsonStore, JsonStoreError } from "../json-store/store.ts"
import { configHome } from "../shared/xdg.ts"
import { definedVariables } from "./process.ts"

/** Deploy settings: each key is the environment variable alchemy gets, like `PUBLIC_URL`, and each value is a string. */
export type Settings = Partial<Readonly<Record<string, string>>>

/** A `Schema.Struct` of optional strings, saved as they are passed to alchemy. */
export type SettingsSchema<S extends Settings> = Schema.Codec<S, S>

/** ~/.config/<app>/deploy.json, or under $XDG_CONFIG_HOME. */
export const settingsPath = (app: string) => join(configHome(), app, "deploy.json")

const definedEntries = (settings: Settings): Readonly<Record<string, string>> => Object.fromEntries(definedVariables(settings))

/** The saved settings as environment variables, none when the file does not exist yet. */
export const settingsEnvironment = <S extends Settings>(store: JsonStore<S>): Effect.Effect<Readonly<Record<string, string>>, JsonStoreError, FileSystem.FileSystem> =>
  store.load.pipe(Effect.map(Option.match({ onNone: () => ({}), onSome: definedEntries })))
