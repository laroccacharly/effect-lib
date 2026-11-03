import { isIP } from "node:net"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { makeResolver } from "./resolver.ts"

// Cloudflare's DNS over HTTPS, reached by address, so finding it needs no resolver.
export const RESOLVER = "https://1.1.1.1/dns-query"

export interface CloudflareDnsOptions {
  // Defaults to RESOLVER; tests point it at a local server.
  readonly resolver?: string
}

type Resolve = (hostname: string) => Effect.Effect<Option.Option<string>>

// Addresses and localhost are the machine's to reach.
const isAddressOrLocalhost = (hostname: string) =>
  isIP(hostname.replace(/^\[(.*)\]$/u, "$1")) !== 0 || hostname === "localhost" || hostname.endsWith(".localhost")

// The request sent to `address`, still naming its host in the Host header. A string url keeps its url params.
const atAddress = (request: HttpClientRequest.HttpClientRequest, url: URL, address: string) => {
  const atAddressUrl = new URL(url)
  atAddressUrl.hostname = address
  return request.pipe(HttpClientRequest.setUrl(atAddressUrl.href), HttpClientRequest.setHeader("host", url.host))
}

// Bun's fetch checks the certificate against `tls.serverName`, the hostname, rather than the address it connects to.
const checkingCertificateFor = (hostname: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (current) => {
    const base: BunFetchRequestInit = Option.getOrElse(current, () => ({}))
    const init: BunFetchRequestInit = { ...base, tls: { ...base.tls, serverName: hostname } }
    return Effect.provideService(effect, FetchHttpClient.RequestInit, init)
  })

// Sends `request` to the address `resolve` gives its host; through the machine's resolver when it gives none.
const executeAtResolvedAddress = (client: HttpClient.HttpClient, resolve: Resolve) =>
  Effect.fnUntraced(function* executeAtResolvedAddress(request: HttpClientRequest.HttpClientRequest) {
    const url = URL.parse(request.url)
    if (url === null || isAddressOrLocalhost(url.hostname)) {
      return yield* client.execute(request)
    }
    const address = yield* resolve(url.hostname)
    if (Option.isNone(address)) {
      return yield* client.execute(request)
    }
    return yield* client.execute(atAddress(request, url, address.value)).pipe(checkingCertificateFor(url.hostname))
  })

const resolvingWith = (client: HttpClient.HttpClient, resolve: Resolve): HttpClient.HttpClient => {
  const execute = executeAtResolvedAddress(client, resolve)
  return HttpClient.makeWith((request: Effect.Effect<HttpClientRequest.HttpClientRequest>) => Effect.flatMap(request, execute), Effect.succeed)
}

/**
 * Bun's fetch HttpClient, resolving hosts through Cloudflare's DNS over HTTPS instead of the machine's resolver, which a
 * VPN may point at a server still caching "not found" from before a new domain existed. Answers are cached for their TTL.
 */
export const layer = (options: CloudflareDnsOptions = {}): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return resolvingWith(client, yield* makeResolver(client, options.resolver ?? RESOLVER))
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
