// Applies the migrations a database lacks, in order, and refuses a database whose applied migrations were edited.

import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

export class MigrationError extends Schema.TaggedError<MigrationError>()("MigrationError", {
  // edited means an applied migration's text changed, ahead means the database has migrations the code lacks.
  reason: Schema.Literals(["edited", "ahead"]),
  message: Schema.String,
}) {}

interface Applied {
  readonly id: number
  readonly sql: string
}

// Only the ends are trimmed: whitespace inside can be part of a string literal.
const normalize = (sql: string) => sql.trim()

const checkApplied = (migrations: ReadonlyArray<string>, applied: ReadonlyArray<Applied>) => {
  if (applied.length > migrations.length) {
    return Effect.fail(new MigrationError({ reason: "ahead", message: `the database has ${applied.length} migrations, the code ${migrations.length}` }))
  }
  const edited = applied.find((row) => normalize(row.sql) !== normalize(migrations[row.id] ?? ""))
  if (edited) {
    return Effect.fail(new MigrationError({ reason: "edited", message: `migration ${edited.id} changed after it was applied; add a new one instead` }))
  }
  return Effect.void
}

export const migrate = (migrations: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, sql TEXT NOT NULL)`
    const applied = yield* sql<Applied>`SELECT id, sql FROM _migrations ORDER BY id`
    yield* checkApplied(migrations, applied)
    const apply = (migration: string, offset: number) =>
      sql.withTransaction(
        Effect.andThen(sql.unsafe(migration), sql`INSERT INTO _migrations (id, sql) VALUES (${applied.length + offset}, ${migration})`)
      )
    yield* Effect.forEach(migrations.slice(applied.length), apply, { discard: true })
  })
