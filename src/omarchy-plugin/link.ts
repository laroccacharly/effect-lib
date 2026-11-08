// The symlink from the plugins dir to the checkout, which is how omarchy-shell finds the plugin.

import { join, resolve } from "node:path"
import { Effect, FileSystem } from "effect"
import type { Plugin } from "./config.ts"
import { OmarchyPluginError } from "./error.ts"

export type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotALink" }
  | { readonly _tag: "Ours"; readonly target: string }
  // A link to another checkout, or to nothing when `dangling`.
  | { readonly _tag: "Elsewhere"; readonly target: string; readonly dangling: boolean }

const isLink = (fs: FileSystem.FileSystem, path: string) =>
  fs.lstat(path).pipe(
    Effect.map((info) => info.type === "SymbolicLink"),
    Effect.option
  )

export const readLinkState = Effect.fnUntraced(function* readLinkState(path: string, root: string) {
  const fs = yield* FileSystem.FileSystem
  const link = yield* isLink(fs, path)
  if (link._tag === "None") {
    return { _tag: "Missing" } satisfies LinkState
  }
  if (!link.value) {
    return { _tag: "NotALink" } satisfies LinkState
  }
  const target = resolve(path, "..", yield* fs.readLink(path).pipe(Effect.orElseSucceed(() => "")))
  const real = yield* fs.realPath(target).pipe(Effect.option)
  if (real._tag === "None") {
    return { _tag: "Elsewhere", target, dangling: true } satisfies LinkState
  }
  const ours = yield* fs.realPath(root).pipe(Effect.map((rootReal) => rootReal === real.value), Effect.orElseSucceed(() => false))
  if (!ours) {
    return { _tag: "Elsewhere", target, dangling: false } satisfies LinkState
  }
  return { _tag: "Ours", target } satisfies LinkState
})

const removeFailure = (path: string) => (cause: { message: string }) => new OmarchyPluginError({ message: `could not remove ${path}: ${cause.message}` })

// Ids under the plugins dir that link to this checkout under another name, e.g. from before the manifest id changed.
export const staleIds = Effect.fnUntraced(function* staleIds(plugin: Plugin) {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(plugin.pluginsDir).pipe(Effect.orElseSucceed(() => []))
  const others = names.filter((name) => name !== plugin.id)
  const states = yield* Effect.forEach(others, (name) => readLinkState(join(plugin.pluginsDir, name), plugin.root))
  return others.filter((_, index) => states[index]?._tag === "Ours")
})

export const removeStaleLink = Effect.fnUntraced(function* removeStaleLink(plugin: Plugin, id: string) {
  const fs = yield* FileSystem.FileSystem
  const path = join(plugin.pluginsDir, id)
  yield* fs.remove(path).pipe(Effect.mapError(removeFailure(path)))
  return path
})

// True when the link had to be created; fails rather than replace something that is not ours.
export const ensureLink = Effect.fnUntraced(function* ensureLink(plugin: Plugin) {
  const fs = yield* FileSystem.FileSystem
  const state = yield* readLinkState(plugin.link, plugin.root)
  if (state._tag === "Ours") {
    return false
  }
  if (state._tag !== "Missing") {
    return yield* new OmarchyPluginError({ message: `${plugin.link} already exists and is not a link to ${plugin.root}. Move it away first.` })
  }
  yield* fs.makeDirectory(plugin.pluginsDir, { recursive: true }).pipe(
    Effect.andThen(fs.symlink(plugin.root, plugin.link)),
    Effect.mapError((cause) => new OmarchyPluginError({ message: `could not link ${plugin.link}: ${cause.message}` }))
  )
  return true
})

// True when there is a link to remove: ours, or one pointing at nothing. Fails on anything else, which is left alone.
export const isRemovable = Effect.fnUntraced(function* isRemovable(plugin: Plugin) {
  const state = yield* readLinkState(plugin.link, plugin.root)
  if (state._tag === "Missing") {
    return false
  }
  if (state._tag === "NotALink" || (state._tag === "Elsewhere" && !state.dangling)) {
    return yield* new OmarchyPluginError({ message: `${plugin.link} is not a link to ${plugin.root}; leaving it alone` })
  }
  return true
})

export const removeLink = Effect.fnUntraced(function* removeLink(plugin: Plugin) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(plugin.link).pipe(Effect.mapError(removeFailure(plugin.link)))
})
