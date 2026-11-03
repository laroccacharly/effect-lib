// Replaces globalThis.fetch with the Cloudflare-resolving one, for a whole process and the bun processes it spawns:
// `BUN_OPTIONS=--preload=effect-lib/cloudflare-dns/global bun test …`.
import { fetch } from "./index.ts"

globalThis.fetch = fetch
