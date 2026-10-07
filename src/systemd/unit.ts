import { homedir } from "node:os"
import { join } from "node:path"

export type Restart = "no" | "always" | "on-success" | "on-failure" | "on-abnormal" | "on-abort" | "on-watchdog"

export interface ServiceConfig {
  // The unit is `<name>.service`.
  readonly name: string
  readonly description: string
  // The service runs `bun <script> <args>`; the script is an absolute path, e.g. import.meta.filename.
  // There is no way to name the runtime: install picks a bun that survives upgrades (see stableBun).
  readonly script: string
  readonly args?: readonly string[]
  // Added to the user manager's environment, not your shell's; only for what the service needs, e.g. a minimal PATH.
  // Keep secrets out: the unit is a plain file, so use extra.service.EnvironmentFile with a 0o600 file instead.
  readonly environment?: Readonly<Record<string, string>>
  // Defaults to on-failure, after 30 seconds.
  readonly restart?: Restart
  readonly restartSec?: number
  // Defaults to default.target, so the service starts at login.
  readonly wantedBy?: string
  // Defaults to $XDG_CONFIG_HOME/systemd/user.
  readonly unitDir?: string
  // Extra directives appended to each section, e.g. { unit: { After: "network-online.target" } }.
  readonly extra?: {
    readonly unit?: Readonly<Record<string, string>>
    readonly service?: Readonly<Record<string, string>>
    readonly install?: Readonly<Record<string, string>>
  }
}

export const unitName = (config: ServiceConfig): string => `${config.name}.service`

export const unitPath = (config: ServiceConfig): string =>
  join(config.unitDir ?? join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "systemd", "user"), unitName(config))

// systemd expands %-specifiers in most values.
const escapeSpecifiers = (value: string) => value.replaceAll("%", "%%")

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

// ExecStart splits on whitespace and also expands $VARIABLES.
const execArgument = (argument: string) => {
  const escaped = escapeSpecifiers(argument).replaceAll("$", "$$$$")
  return escaped === "" || /[\s"'\\;]/u.test(escaped) ? quote(escaped) : escaped
}

const section = (title: string, directives: ReadonlyArray<readonly [string, string]>, extra: Readonly<Record<string, string>> = {}) =>
  [`[${title}]`, ...[...directives, ...Object.entries(extra)].map(([key, value]) => `${key}=${value}`)].join("\n")

// `bun` is the runtime's absolute path, as stableBun resolves it.
export const unitFile = (config: ServiceConfig, bun: string): string =>
  `${[
    section("Unit", [["Description", escapeSpecifiers(config.description)]], config.extra?.unit),
    section(
      "Service",
      [
        ["ExecStart", [bun, config.script, ...(config.args ?? [])].map(execArgument).join(" ")],
        ...Object.entries(config.environment ?? {}).map(([key, value]): [string, string] => ["Environment", quote(escapeSpecifiers(`${key}=${value}`))]),
        ["Restart", config.restart ?? "on-failure"],
        ["RestartSec", String(config.restartSec ?? 30)],
      ],
      config.extra?.service
    ),
    section("Install", [["WantedBy", config.wantedBy ?? "default.target"]], config.extra?.install),
  ].join("\n\n")}\n`
