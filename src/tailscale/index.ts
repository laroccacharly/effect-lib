export { tailscaleCommand, type TailscaleCommandConfig } from "./commands.ts"
export { terminalQrCode } from "./qr.ts"
export {
  firstAutomaticPort,
  publicUrl,
  serve,
  serveOnFreePort,
  serveStatus,
  status,
  TailscaleError,
  TailscalePort,
  unserve,
  unserveIfOurs,
  urlFromDnsName,
  type Ports,
} from "./tailscale.ts"
