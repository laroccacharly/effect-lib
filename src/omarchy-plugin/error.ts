import { Schema } from "effect"
import { CliError } from "effect/cli"

export class OmarchyPluginError extends Schema.TaggedError<OmarchyPluginError>()("OmarchyPluginError", {
  message: Schema.String,
}) {
  // So a CLI built on pluginCommand prints the message instead of the whole error.
  get [CliError.userMessage]() {
    return this.message
  }
}
