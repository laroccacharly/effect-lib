import { afterAll, beforeEach, expect, spyOn, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/cli"
import { publicUrl, serve, tailscaleCommand, terminalQrCode, unserve, urlFromDnsName } from "../src/tailscale/index.ts"
import { qrMatrix } from "../src/tailscale/qr-matrix.ts"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) => Effect.runPromise(Effect.provide(effect, BunServices.layer))

test("the URL leaves out port 443 and the DNS name's trailing dot", () => {
  expect(urlFromDnsName("box.tail.ts.net.", 443)).toBe("https://box.tail.ts.net")
  expect(urlFromDnsName("box.tail.ts.net.", 8443)).toBe("https://box.tail.ts.net:8443")
})

test("a QR code refuses text longer than it can hold", async () => {
  const error = await Effect.runPromise(Effect.flip(terminalQrCode(`https://${"a".repeat(100)}`)))
  expect(error.message).toContain("longer than 106 bytes")
})

// The matrix as a PBM image, 4 pixels a module with a 4 module margin, for zbarimg.
const pbm = (modules: ReadonlyArray<ReadonlyArray<boolean>>) => {
  const side = (modules.length + 8) * 4
  const pixel = (x: number, y: number) => Number(modules[Math.floor(y / 4) - 4]?.[Math.floor(x / 4) - 4] === true)
  const rows = Array.from({ length: side }, (_, y) => Array.from({ length: side }, (_, x) => pixel(x, y)).join(" "))
  return `P1\n${side} ${side}\n${rows.join("\n")}\n`
}

test.skipIf(Bun.which("zbarimg") === null)("QR codes decode back to their text, from a single letter to the longest that fits", () => {
  const texts = ["a", "https://box.tail.ts.net", "https://gmk.tail2b871c.ts.net:8447", "héllo ✓", "x".repeat(43), "y".repeat(78), "z".repeat(106)]
  for (const text of texts) {
    const image = join(root, "qr.pbm")
    writeFileSync(image, pbm(qrMatrix(new TextEncoder().encode(text))))
    const decoded = Bun.spawnSync(["zbarimg", "--quiet", "--raw", image]).stdout.toString().trimEnd()
    expect(decoded).toBe(text)
  }
})

// A fake tailscale first on PATH: it logs each call, keeps the serve mappings in a JSON file and answers like the real CLI.
const root = mkdtempSync(join(tmpdir(), "tailscale-"))
const calls = join(root, "calls")
const serveState = join(root, "serve.json")
const realPath = process.env["PATH"]
afterAll(() => {
  process.env["PATH"] = realPath
  rmSync(root, { recursive: true, force: true })
})
writeFileSync(
  join(root, "tailscale"),
  `#!/bin/sh
echo "$*" >> ${calls}
echo "Warning: client version differs from tailscaled" >&2
case "$*" in
  "status --json") echo '{"Self":{"DNSName":"box.tail.ts.net."}}' ;;
  "status") echo "100.1.2.3 box" ;;
  "serve status --json") cat ${serveState} 2>/dev/null || echo '{}' ;;
  "serve status") echo "https://box.tail.ts.net:8443" ;;
  "serve --bg --https="*) port=\${3#--https=}; echo "{\\"TCP\\":{\\"$port\\":{\\"HTTPS\\":true}},\\"Web\\":{\\"box.tail.ts.net:$port\\":{\\"Handlers\\":{\\"/\\":{\\"Proxy\\":\\"$4\\"}}}}}" > ${serveState} ;;
  *" off") if [ -f ${root}/deny ]; then echo "Access denied" >&2; exit 1; fi; rm ${serveState} ;;
  *) exit 2 ;;
esac
`
)
chmodSync(join(root, "tailscale"), 0o755)

const live = process.env["LIVE"] === "1"
if (!live) {
  process.env["PATH"] = `${root}${delimiter}${realPath}`
}

beforeEach(() => {
  rmSync(calls, { force: true })
  rmSync(serveState, { force: true })
})

const calledWith = () => {
  if (!existsSync(calls)) {
    return []
  }
  return readFileSync(calls, "utf8").trim().split("\n")
}

const captureLogs = async (action: () => Promise<void>) => {
  const lines: string[] = []
  const log = spyOn(console, "log").mockImplementation((line: string) => lines.push(line))
  try {
    await action()
  } finally {
    log.mockRestore()
  }
  return lines.join("\n")
}

const command = tailscaleCommand({ name: "memo", ports: Effect.succeed({ serverPort: 3000, tailscalePort: 8443 }), health: (serverPort) => Effect.succeed(`memo server: OK on ${serverPort}`) })
const runCli = (args: ReadonlyArray<string>) => captureLogs(() => run(Command.runWith(command, { version: "0.0.0" })(args)))

test.skipIf(live)("install serves the server port on the tailscale port and prints health and URL", async () => {
  const output = await runCli(["install"])
  expect(calledWith()).toContain("serve --bg --https=8443 http://127.0.0.1:3000")
  expect(output).toContain("memo server: OK on 3000")
  expect(output).toContain("URL: https://box.tail.ts.net:8443")
})

test.skipIf(live)("install again is a no-op, and url --qr draws the URL", async () => {
  await runCli(["install"])
  await runCli(["install"])
  const output = await runCli(["url", "--qr"])
  expect(output).toStartWith("URL: https://box.tail.ts.net:8443\n")
  expect(output).toContain("▄")
})

test.skipIf(live)("install refuses a tailscale port that already serves another app", async () => {
  await run(serve({ serverPort: 7300, tailscalePort: 8443 }))
  const error = await run(Effect.flip(serve({ serverPort: 3000, tailscalePort: 8443 })))
  expect(error.message).toContain("https port 8443 already serves http://127.0.0.1:7300")
  expect(calledWith().filter((call) => call.startsWith("serve --bg"))).toEqual(["serve --bg --https=8443 http://127.0.0.1:7300"])
})

test.skipIf(live)("uninstall turns off only its port and succeeds when nothing is served", async () => {
  await runCli(["install"])
  await runCli(["uninstall"])
  const output = await runCli(["uninstall"])
  expect(calledWith().filter((call) => call.endsWith(" off"))).toEqual(["serve --https=8443 off"])
  expect(output).toBe("Stopped serving memo on the tailnet at https port 8443")
})

test.skipIf(live)("uninstall reports a failure to turn the port off", async () => {
  await runCli(["install"])
  writeFileSync(join(root, "deny"), "")
  try {
    const error = await run(Effect.flip(unserve(8443)))
    expect(error.message).toStartWith("tailscale serve --https=8443 off exited with 1: ")
    expect(error.message).toEndWith("Access denied")
  } finally {
    rmSync(join(root, "deny"))
  }
})

test.skipIf(live)("status prints tailscale status, the serve configuration, health and URL", async () => {
  const output = await runCli(["status"])
  expect(output).toBe(
    "Tailscale status:\n100.1.2.3 box\nTailscale serve configuration:\nhttps://box.tail.ts.net:8443\nmemo server: OK on 3000\nURL: https://box.tail.ts.net:8443"
  )
})

// On the real tailnet, on an HTTPS port no app uses; needs tailscale up with this user as operator.
test.skipIf(!live)("live: serves a port on the tailnet, then turns it off", async () => {
  const ports = { serverPort: 39_999, tailscalePort: 18_443 }
  await run(serve(ports))
  try {
    const url = await run(publicUrl(ports.tailscalePort))
    expect(url).toMatch(/^https:\/\/[^/]+\.ts\.net:18443$/u)
    const error = await run(Effect.flip(serve({ ...ports, serverPort: 39_998 })))
    expect(error.message).toContain("already serves http://127.0.0.1:39999")
  } finally {
    await run(unserve(ports.tailscalePort))
  }
})
