import { Effect } from "effect"
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
