import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServer, HttpServerResponse } from "effect/http"
import * as Portless from "../src/portless/index.ts"

const startServer = (body: string) => {
  const ready = Promise.withResolvers<string>()
  const stop = Promise.withResolvers<void>()
  const running = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const local = yield* Portless.LocalServer
    expect(local.address).toEqual(server.address)
    yield* server.serve(Effect.succeed(HttpServerResponse.text(body)))
    ready.resolve(local.url)
    yield* Effect.promise(() => stop.promise)
  })).pipe(Effect.provide(Portless.layer())))
  running.catch(ready.reject)
  return { ready: ready.promise, stop: () => stop.resolve(), running }
}

test.skipIf(process.env["LIVE"] !== "1")("live: starts and connects to two independent servers in under 20 ms", async () => {
  const started = performance.now()
  const first = startServer("first")
  const second = startServer("second")
  try {
    const [firstUrl, secondUrl] = await Promise.all([first.ready, second.ready])
    const responses = await Promise.all([fetch(firstUrl), fetch(secondUrl)])
    const bodies = await Promise.all(responses.map((response) => response.text()))
    const elapsedMs = performance.now() - started
    console.log(`Two HTTP servers and requests: ${elapsedMs.toFixed(2)} ms`)
    expect(new URL(firstUrl).port).not.toBe(new URL(secondUrl).port)
    expect(bodies).toEqual(["first", "second"])
    expect(elapsedMs).toBeLessThan(20)
  } finally {
    first.stop()
    second.stop()
    await Promise.all([first.running, second.running])
  }
})

test("independent scoped servers use distinct loopback ports and serve requests", async () => {
  const first = startServer("first")
  const second = startServer("second")
  let firstUrl = ""
  let secondUrl = ""
  try {
    ;[firstUrl, secondUrl] = await Promise.all([first.ready, second.ready])
    const firstAddress = new URL(firstUrl)
    const secondAddress = new URL(secondUrl)
    expect(firstAddress.hostname).toBe("127.0.0.1")
    expect(secondAddress.hostname).toBe("127.0.0.1")
    expect(Number(firstAddress.port)).toBeGreaterThan(0)
    expect(Number(secondAddress.port)).toBeGreaterThan(0)
    expect(firstAddress.port).not.toBe(secondAddress.port)
    const responses = await Promise.all([fetch(firstUrl), fetch(secondUrl)])
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(["first", "second"])

    first.stop()
    await first.running
    expect(await fetch(firstUrl).then(() => false, () => true)).toBe(true)
    expect(await (await fetch(secondUrl)).text()).toBe("second")
  } finally {
    first.stop()
    second.stop()
    await Promise.all([first.running, second.running])
  }
  expect(await fetch(secondUrl).then(() => false, () => true)).toBe(true)
})
