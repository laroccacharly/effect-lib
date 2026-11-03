import { Cache, Duration, Effect, Exit, Option, Schema } from "effect"
import { type HttpClient, HttpClientResponse } from "effect/http"

const A_RECORD = 1

const DnsRecord = Schema.Struct({ type: Schema.Finite, TTL: Schema.Finite, data: Schema.String })
type DnsRecord = typeof DnsRecord.Type

const DnsAnswer = Schema.Struct({ Answer: Schema.optional(Schema.Array(DnsRecord)) })

const firstARecord = ({ Answer = [] }: typeof DnsAnswer.Type) => Option.fromUndefinedOr(Answer.find((record) => record.type === A_RECORD))

// None when the resolver has no A record, or no answer within 2 seconds.
const queryARecord = (http: HttpClient.HttpClient, resolver: string) => (hostname: string) =>
  http.get(resolver, { urlParams: { name: hostname, type: "A" }, headers: { accept: "application/dns-json" } }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DnsAnswer)),
    Effect.map(firstARecord),
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => Option.none<DnsRecord>())
  )

// A record is kept for its own TTL. A miss isn't kept, so a domain created a moment later resolves on the next request.
const recordTimeToLive = (exit: Exit.Exit<Option.Option<DnsRecord>>) => {
  if (Exit.isSuccess(exit) && Option.isSome(exit.value)) {
    return Duration.seconds(exit.value.value.TTL)
  }
  return Duration.zero
}

/** Resolves a hostname to an IPv4 address with the DNS over HTTPS JSON API at `resolver`, through `http`, cached by TTL. */
export const makeResolver = Effect.fnUntraced(function* makeResolver(http: HttpClient.HttpClient, resolver: string) {
  const cache = yield* Cache.makeWith(queryARecord(http, resolver), { capacity: 256, timeToLive: recordTimeToLive })
  return (hostname: string): Effect.Effect<Option.Option<string>> => Cache.get(cache, hostname).pipe(Effect.map(Option.map((record) => record.data)))
})
