import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { stableBun, unitFile, unitPath } from "../src/systemd/index.ts"

const config = { name: "bot", description: "Bot", script: "/repo/src/cli.ts", args: ["run"] } as const

test("renders defaults", () => {
  expect(unitFile(config, "/opt/bun")).toBe(`[Unit]
Description=Bot

[Service]
ExecStart=/opt/bun /repo/src/cli.ts run
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`)
})

test("applies overrides and extra directives", () => {
  const unit = unitFile(
    {
      ...config,
    environment: { PATH: "/a:/b" },
    restart: "always",
    restartSec: 5,
    wantedBy: "graphical-session.target",
      extra: { unit: { After: "network-online.target" } },
    },
    "/opt/bun"
  )
  expect(unit).toContain('Environment="PATH=/a:/b"\n')
  expect(unit).toContain("Restart=always\nRestartSec=5\n")
  expect(unit).toContain("WantedBy=graphical-session.target\n")
  expect(unit).toContain("Description=Bot\nAfter=network-online.target\n")
})

test("escapes arguments systemd would split or expand", () => {
  const unit = unitFile({ ...config, args: ["100%", "$HOME", 'say "hi"'], environment: { NOTE: 'a "b" 50%' } }, "/my dir/bun")
  expect(unit).toContain('ExecStart="/my dir/bun" /repo/src/cli.ts 100%% $$HOME "say \\"hi\\""\n')
  expect(unit).toContain('Environment="NOTE=a \\"b\\" 50%%"\n')
})

test("puts the unit in the user unit directory", () => {
  expect(unitPath({ ...config, unitDir: "/units" })).toBe("/units/bot.service")
})

// A fake bun at each path under a temp root, so stableBun searches a PATH we control.
const root = mkdtempSync(join(tmpdir(), "stable-bun-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const fakeBun = (...directories: string[]) => {
  for (const directory of directories) {
    const path = join(root, directory, "bun")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "")
    chmodSync(path, 0o755)
  }
  return (...onPath: string[]) => onPath.map((directory) => join(root, directory)).join(":")
}
const resolve = (searchPath: string) => Effect.runPromise(stableBun(searchPath).pipe(Effect.provide(BunServices.layer)))

test("stableBun skips versioned installs for the first bun that survives an upgrade", async () => {
  const path = fakeBun("mise/installs/bun/1.4.2/bin", "mise/installs/bun/1/bin", "mise/shims")
  expect(await resolve(path("missing", "mise/installs/bun/1.4.2/bin", "mise/installs/bun/1/bin", "mise/shims"))).toBe(join(root, "mise/shims/bun"))
})

test("stableBun fails when every bun on PATH is a versioned install", async () => {
  const path = fakeBun("Cellar/bun/1.4.2/bin")
  const error = await Effect.runPromise(stableBun(path("Cellar/bun/1.4.2/bin")).pipe(Effect.flip, Effect.provide(BunServices.layer)))
  expect(error.message).toContain("no bun on PATH")
})
