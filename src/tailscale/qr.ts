import { Effect } from "effect"
import { maxQrBytes, qrMatrix } from "./qr-matrix.ts"
import { TailscaleError } from "./tailscale.ts"

const quietZone = 2

// Each character stacks two module rows: upper and lower half blocks, black on a white background.
const halfBlock = (upper: boolean, lower: boolean): string => " ▄▀█"[Number(upper) * 2 + Number(lower)]!

const render = (modules: ReadonlyArray<ReadonlyArray<boolean>>): string => {
  const size = modules.length + 2 * quietZone
  const isDark = (x: number, y: number) => modules[y - quietZone]?.[x - quietZone] === true
  const rows = Array.from({ length: Math.ceil(size / 2) }, (_, row) =>
    Array.from({ length: size }, (_, x) => halfBlock(isDark(x, 2 * row), isDark(x, 2 * row + 1))).join(""),
  )
  return rows.map((row) => `\x1b[47;30m${row}\x1b[0m`).join("\n")
}

// `text` as a QR code drawn with block characters, to scan the URL from a phone.
export const terminalQrCode = (text: string): Effect.Effect<string, TailscaleError> => {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > maxQrBytes) return Effect.fail(new TailscaleError({ message: `could not draw a QR code for ${text}: longer than ${maxQrBytes} bytes` }))
  return Effect.succeed(render(qrMatrix(bytes)))
}
