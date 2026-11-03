import { Effect, Option, Schema } from "effect"

const DnsAnswer = Schema.Struct({ Answer: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.Finite, data: Schema.String }))) })

// The runtime's fetch, taken before `effect-lib/cloudflare-dns/global` replaces it.
const baseFetch = globalThis.fetch

const isAddressOrLocal = (hostname: string) => hostname === "localhost" || /^[\d.]+$/u.test(hostname) || hostname.startsWith("[")

/**
 * An IPv4 address for `hostname` from Cloudflare's DNS over HTTPS, reached by IP, skipping the machine's resolver: a VPN
 * may point that at a server still caching "not found" from before a new domain existed. None when Cloudflare has no
 * answer within 2 seconds.
 */
export const resolve = (hostname: string): Effect.Effect<Option.Option<string>> =>
  Effect.tryPromise(async (signal) => {
    const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`
    const response = await baseFetch(url, { headers: { accept: "application/dns-json" }, signal })
    if (!response.ok) {
      throw new Error(`1.1.1.1 answered ${response.status}`)
    }
    return await response.text()
  }).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(DnsAnswer))),
    Effect.map(({ Answer }) => Option.fromNullishOr(Answer?.find((record) => record.type === 1)?.data)),
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => Option.none<string>())
  )

type Input = string | URL | Request

const urlOf = (input: Input) => {
  if (input instanceof Request) {
    return new URL(input.url)
  }
  return new URL(input)
}

// The request's headers, then the init's, as fetch merges them.
const headersOf = (input: Input, init?: BunFetchRequestInit) => {
  const headers = new Headers()
  if (input instanceof Request) {
    input.headers.forEach((value, name) => headers.set(name, value))
  }
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
  return headers
}

// The same request at `url`: a Request keeps its method, body and signal.
const retarget = (input: Input, url: URL) => {
  if (input instanceof Request) {
    return new Request(url, input)
  }
  return url
}

/**
 * Bun's fetch, with the host resolved by `resolve`: it connects to that address and keeps the hostname for TLS and the
 * Host header. Local hosts, addresses, and hosts Cloudflare has no answer for go through the machine's resolver.
 */
export const fetch: typeof globalThis.fetch = Object.assign(
  async (input: Input, init?: BunFetchRequestInit) => {
    const url = urlOf(input)
    if (isAddressOrLocal(url.hostname)) {
      return await baseFetch(input, init)
    }
    const address = await Effect.runPromise(resolve(url.hostname))
    if (Option.isNone(address)) {
      return await baseFetch(input, init)
    }
    const { hostname, host } = url
    url.hostname = address.value
    const headers = headersOf(input, init)
    headers.set("host", host)
    // Bun's own options, like proxy or unix, pass through; the certificate is checked against the hostname, not the address.
    return await baseFetch(retarget(input, url), { ...init, headers, tls: { ...init?.tls, serverName: hostname } })
  },
  { preconnect: baseFetch.preconnect }
)
