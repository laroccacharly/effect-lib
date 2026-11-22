// `sql(query)` checks a query against the database type and returns a statement typed from it.

import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import type { Analysis, Analyze, Check } from "./analyze.ts"
import { compile } from "./compile.ts"
import type { DatabaseShape, SqlValue } from "./schema.ts"

type Rows<A> = A extends Analysis<infer Row> ? ReadonlyArray<Row> : never
type Args<A> = A extends Analysis<infer _Row, infer P> ? (keyof P extends never ? [] : [params: P]) : never

export type Statement<A> = (...args: Args<A>) => Effect.Effect<Rows<A>, SqlError.SqlError, SqlClient.SqlClient>

// The row a statement returns.
export type RowOf<S> = S extends (...args: never) => Effect.Effect<ReadonlyArray<infer Row>, infer _E, infer _R> ? Row : never

export type TypedSql<DB extends DatabaseShape> = <const Q extends string>(query: Check<DB, Q> & Q) => Statement<Analyze<DB, Q>>

const run = (query: string, params: Readonly<Record<string, SqlValue>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const compiled = compile(query, params)
    return yield* sql.unsafe<object>(compiled.text, compiled.values)
  })

// Rows are typed from the query, not decoded: the migrations that `migrate` applies are what keeps them true.
export const make = <DB extends DatabaseShape>(): TypedSql<DB> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the types above are computed from the query text, which the runtime cannot check.
  ((query: string) => (params: Readonly<Record<string, SqlValue>> = {}) => run(query, params)) as never
