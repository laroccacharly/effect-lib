import { Config, Effect, Option } from "effect"
import { DeployError } from "./process.ts"

/**
 * The commit checked out in `directory`, `-dirty` with uncommitted changes, e.g. `04a40f3`: what `deploy` and `plan` give
 * alchemy as DEPLOY_VERSION, and what the Worker's /health must answer after `deploy`. Apps compare against it where
 * DEPLOY_VERSION is unset, such as under `alchemy dev` or in live tests.
 */
export const commitVersion = (directory: string = process.cwd()): Effect.Effect<string, DeployError> =>
  Effect.suspend(() => {
    const described = Bun.spawnSync(["git", "describe", "--always", "--dirty"], { cwd: directory })
    if (described.exitCode !== 0) {
      return Effect.fail(new DeployError({ message: `git describe failed in ${directory}: ${described.stderr.toString().trim()}` }))
    }
    return Effect.succeed(described.stdout.toString().trim())
  })

/**
 * The version a Worker answers on /health, for its props' `env`: DEPLOY_VERSION, which `deploy` sets and the Worker reads
 * again when it runs; where it is unset, as under `alchemy dev`, the commit checked out in `directory`. Dies outside a
 * git checkout.
 */
export const workerVersion = Effect.fnUntraced(function* workerVersion(directory: string) {
  const deployed = yield* Config.option(Config.String("DEPLOY_VERSION"))
  return yield* Option.match(deployed, { onNone: () => Effect.orDie(commitVersion(directory)), onSome: Effect.succeed })
})
