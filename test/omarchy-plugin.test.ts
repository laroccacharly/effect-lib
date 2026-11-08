import { afterAll, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, relative } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Logger, Option } from "effect"
import * as OmarchyPlugin from "../src/omarchy-plugin/index.ts"

// Fake `omarchy` and `omarchy-shell` on PATH: the shell discovers whatever the plugins dir links to,
// and an id is enabled while $STATE/<id> exists.
const OMARCHY_SHELL = `#!/bin/sh
case "$2" in
  ping) echo ok ;;
  listPlugins)
    sep=""; printf '['
    for path in "$PLUGINS"/*; do
      [ -e "$path" ] || continue
      id=$(basename "$path"); enabled=false; [ -e "$STATE/$id" ] && enabled=true
      printf '%s{"id":"%s","enabled":%s}' "$sep" "$id" "$enabled"; sep=","
    done
    echo ']' ;;
esac
`

const OMARCHY = `#!/bin/sh
echo "$*" >> "$STATE/calls"
case "$1 $2" in
  "plugin enable") touch "$STATE/$3" ;;
  "plugin disable") rm -f "$STATE/$3" ;;
esac
`

const temp = mkdtempSync(join(tmpdir(), "omarchy-plugin-"))
const bin = join(temp, "bin")
const state = join(temp, "state")
const pluginsDir = join(temp, "plugins")
const checkout = join(temp, "checkout")
const config = { root: checkout, pluginsDir }
const link = join(pluginsDir, "widget")

mkdirSync(bin)
mkdirSync(checkout)
writeFileSync(join(checkout, "manifest.json"), JSON.stringify({ id: "widget", name: "Widget" }))
for (const [name, script] of [["omarchy", OMARCHY], ["omarchy-shell", OMARCHY_SHELL]] as const) {
  writeFileSync(join(bin, name), script)
  chmodSync(join(bin, name), 0o755)
}
process.env["PATH"] = `${bin}${delimiter}${process.env["PATH"]}`
process.env["PLUGINS"] = pluginsDir
process.env["STATE"] = state

beforeEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true })
  rmSync(state, { recursive: true, force: true })
  mkdirSync(state)
})
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) => Effect.runPromise(effect.pipe(Effect.provide([BunServices.layer, Logger.layer([])])))
const calls = () => readFileSync(join(state, "calls"), "utf8").trim().split("\n")

test("install links and enables the checkout, then does nothing the second time", async () => {
  const first = await run(OmarchyPlugin.install(config, Option.some("right")))
  expect(first).toMatchObject({ linked: true, enabled: true, removedStale: [] })
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(calls()).toContain("plugin enable widget --section right")

  const second = await run(OmarchyPlugin.install(config))
  expect(second).toMatchObject({ linked: false, enabled: false })
})

test("install replaces a link left under an old id", async () => {
  mkdirSync(pluginsDir)
  symlinkSync(checkout, join(pluginsDir, "old-widget"))
  writeFileSync(join(state, "old-widget"), "")

  const result = await run(OmarchyPlugin.install(config))
  expect(result.removedStale).toEqual([{ id: "old-widget", path: join(pluginsDir, "old-widget"), disabled: true }])
  expect(existsSync(join(pluginsDir, "old-widget"))).toBe(false)
  expect(calls()).toContain("plugin disable old-widget")
})

test("install refuses to replace something that is not its link", async () => {
  mkdirSync(link, { recursive: true })
  const error = await run(Effect.flip(OmarchyPlugin.install(config)))
  expect(error.message).toContain("already exists and is not a link")
})

test("uninstall disables and unlinks, then reports nothing to do", async () => {
  await run(OmarchyPlugin.install(config))
  expect(await run(OmarchyPlugin.uninstall(config))).toMatchObject({ disabled: true, unlinked: true })
  expect(existsSync(link)).toBe(false)
  expect(await run(OmarchyPlugin.uninstall(config))).toMatchObject({ disabled: false, unlinked: false })
})

test("uninstall leaves another checkout's plugin enabled", async () => {
  mkdirSync(pluginsDir)
  symlinkSync(temp, link)
  writeFileSync(join(state, "widget"), "")
  const error = await run(Effect.flip(OmarchyPlugin.uninstall(config)))
  expect(error.message).toContain("is not a link to")
  expect(existsSync(join(state, "widget"))).toBe(true)
})

test("install links a relative root by its absolute path", async () => {
  const result = await run(OmarchyPlugin.install({ root: relative(process.cwd(), checkout), pluginsDir }))
  expect(result.plugin.root).toBe(checkout)
  expect(realpathSync(link)).toBe(realpathSync(checkout))
})

test("status shows the link and the shell's view of the plugin", async () => {
  expect(await run(OmarchyPlugin.status(config))).toMatchObject({ link: { _tag: "Missing" }, stale: [], shell: { running: true, plugin: Option.none() } })
  await run(OmarchyPlugin.install(config))
  expect(await run(OmarchyPlugin.status(config))).toMatchObject({ link: { _tag: "Ours" }, shell: { running: true, plugin: Option.some({ id: "widget", enabled: true }) } })
})
