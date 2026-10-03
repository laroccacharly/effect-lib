import { expect, test } from "bun:test"
import { unitFile, unitPath } from "../src/systemd/index.ts"

const config = { name: "bot", description: "Bot", command: ["/opt/bun", "/repo/src/cli.ts", "run"] } as const

test("renders defaults", () => {
  expect(unitFile(config)).toBe(`[Unit]
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
  const unit = unitFile({
    ...config,
    environment: { PATH: "/a:/b" },
    restart: "always",
    restartSec: 5,
    wantedBy: "graphical-session.target",
    extra: { unit: { After: "network-online.target" } },
  })
  expect(unit).toContain('Environment="PATH=/a:/b"\n')
  expect(unit).toContain("Restart=always\nRestartSec=5\n")
  expect(unit).toContain("WantedBy=graphical-session.target\n")
  expect(unit).toContain("Description=Bot\nAfter=network-online.target\n")
})

test("escapes arguments systemd would split or expand", () => {
  const unit = unitFile({ ...config, command: ["/my dir/bin", "100%", "$HOME", 'say "hi"'], environment: { NOTE: 'a "b" 50%' } })
  expect(unit).toContain('ExecStart="/my dir/bin" 100%% $$HOME "say \\"hi\\""\n')
  expect(unit).toContain('Environment="NOTE=a \\"b\\" 50%%"\n')
})

test("puts the unit in the user unit directory", () => {
  expect(unitPath({ ...config, unitDir: "/units" })).toBe("/units/bot.service")
})
