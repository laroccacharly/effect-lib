import type { Schema } from "effect"
import { commands } from "./commands.ts"
import { make as makeStore, type JsonStoreOptions } from "./store.ts"

export { get, list, set, unset } from "./commands.ts"
export { JsonStoreError, type JsonStore, type JsonStoreOptions } from "./store.ts"

// A JSON file at `path` holding a value of `schema`, plus `config get | set | unset | list` commands for it.
export const make = <A, I>(path: string, schema: Schema.Codec<A, I>, options: JsonStoreOptions = {}) => {
  const store = makeStore(path, schema, options)
  return {
    ...store,
    // `<name> get | set | unset | list`, `config` by default; add it to the root command's subcommands.
    commands: (name?: string) => commands(store, schema, name),
  }
}
