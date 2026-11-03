import { Effect, Option, Ref, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
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

const DnsAnswer = Schema.Struct({ Answer: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.Finite, data: Schema.String }))) })

const isLocal = (hostname: string) => hostname === "localhost" || /^[\d.]+$/u.test(hostname) || hostname.startsWith("[")

// An IPv4 address for `hostname` from Cloudflare's DNS over HTTPS, reached by IP. It skips the machine's resolver, which
// a VPN may point at a server that cached "not found" from before the Worker's domain existed. None when it has no answer
// within 2 seconds, leaving the machine's resolver time within the 10 second wait.
const resolveWithCloudflare = (hostname: string) =>
  HttpClient.get("https://1.1.1.1/dns-query", { urlParams: { name: hostname, type: "A" }, headers: { accept: "application/dns-json" } }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DnsAnswer)),
    Effect.map(({ Answer }) => Option.fromNullishOr(Answer?.find((record) => record.type === 1)?.data)),
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => Option.none<string>())
  )

// GET `healthUrl` at the address Cloudflare's DNS gives, keeping the hostname for TLS and the Host header;
// through the machine's resolver when the host is local or Cloudflare has no answer.
const getHealth = Effect.fnUntraced(function* getHealth(healthUrl: string) {
  const url = new URL(healthUrl)
  if (isLocal(url.hostname)) {
    return yield* HttpClient.get(healthUrl)
  }
  const address = yield* resolveWithCloudflare(url.hostname)
  if (Option.isNone(address)) {
    return yield* HttpClient.get(healthUrl)
  }
  const hostname = url.hostname
  url.hostname = address.value
  const request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("host", hostname))
  // `tls.serverName` is Bun's: the certificate is checked against the hostname, not the address.
  return yield* HttpClient.execute(request).pipe(Effect.provideService(FetchHttpClient.RequestInit, { tls: { serverName: hostname } } as RequestInit))
})

// Never fails: an unreachable Worker or a body without a version is an answer too.
const askVersion = (healthUrl: string) =>
  getHealth(healthUrl).pipe(
    Effect.flatMap((response) =>
      HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
        Effect.map(({ version }): Answer => ({ _tag: "Version", version })),
        Effect.orElseSucceed((): Answer => ({ _tag: "NoVersion" }))
      )
    ),
    Effect.orElseSucceed((): Answer => ({ _tag: "Unreachable" }))
  )

/** Polls `<url>/health` until it answers JSON whose `version` is `version`, failing after 10 seconds; returns `<url>/health`. */
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
  return healthUrl
})
