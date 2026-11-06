import { homedir } from "node:os"
import { join } from "node:path"

// The XDG spec treats an empty variable as unset.
const directoryFromEnv = (name: string, fallback: string) => {
  const value = process.env[name]
  if (value === undefined || value === "") {
    return fallback
  }
  return value
}

// $XDG_CONFIG_HOME, ~/.config when unset.
export const configHome = () => directoryFromEnv("XDG_CONFIG_HOME", join(homedir(), ".config"))

// $XDG_STATE_HOME, ~/.local/state when unset.
export const stateHome = () => directoryFromEnv("XDG_STATE_HOME", join(homedir(), ".local", "state"))
