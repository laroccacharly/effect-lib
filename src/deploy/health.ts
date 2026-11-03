import { Effect, Option, Ref, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { DeployError } from "./process.ts"

const Health = Schema.Struct({ version: Schema.String })

// What /health last said, for the error when it never answers the deployed version.
type Answer = { readonly _tag: "Unreachable" } | { readonly _tag: "NoVersion" } | { readonly _tag: "Version"; readonly version: string }

const describeAnswer = (healthUrl: string, version: string, answer: Option.Option<Answer>) => {
  const last = Option.getOrElse(answer, (): Answer => ({ _tag: "Unreachable" }))
  if (last._tag === "Version") {
    return `${healthUrl} still answers ${last.version}, not ${version}`
  }
  if (last._tag === "NoVersion") {
    return `${healthUrl} answers no version, expected ${version}`
  }
  return `could not reach ${healthUrl}`
}

// Never fails: an unreachable Worker or a body without a version is an answer too.
const askVersion = (healthUrl: string) =>
  HttpClient.get(healthUrl).pipe(
    Effect.flatMap((response) =>
      HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
        Effect.map(({ version }): Answer => ({ _tag: "Version", version })),
        Effect.orElseSucceed((): Answer => ({ _tag: "NoVersion" }))
      )
    ),
    Effect.orElseSucceed((): Answer => ({ _tag: "Unreachable" }))
  )

/** Polls `<url>/health` until it answers JSON whose `version` is `version`, failing after 10 seconds. */
export const waitForHealth = Effect.fnUntraced(function* waitForHealth(url: string, version: string) {
  const healthUrl = new URL("/health", url).href
  const lastAnswer = yield* Ref.make(Option.none<Answer>())
  const isDeployed = (answer: Answer) => answer._tag === "Version" && answer.version === version
  const answered = yield* askVersion(healthUrl).pipe(
    Effect.tap((answer) => Ref.set(lastAnswer, Option.some(answer))),
    Effect.repeat({ until: isDeployed, schedule: Schedule.spaced("250 millis") }),
    Effect.timeoutOption("10 seconds"),
    Effect.provide(FetchHttpClient.layer)
  )
  if (Option.isNone(answered)) {
    return yield* new DeployError({ message: describeAnswer(healthUrl, version, yield* Ref.get(lastAnswer)) })
  }
})
