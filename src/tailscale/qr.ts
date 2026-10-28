import { Effect } from "effect"
import QRCode from "qrcode"
import { TailscaleError } from "./tailscale.ts"

// `text` as a QR code drawn with block characters, to scan the URL from a phone.
export const terminalQrCode = (text: string): Effect.Effect<string, TailscaleError> =>
  Effect.tryPromise({
    try: () => QRCode.toString(text, { type: "terminal", small: true }),
    catch: (cause) => new TailscaleError({ message: `could not draw a QR code for ${text}: ${String(cause)}` }),
  })
