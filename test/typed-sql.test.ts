import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { type Column, make, migrate, type RowOf, type Schema } from "../src/typed-sql/index.ts"

const migrations = [
  `CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT,
    done INTEGER NOT NULL DEFAULT 0
  )`,
  `ALTER TABLE notes ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX notes_done ON notes (done)`,
] as const
type DB = Schema<typeof migrations>
const sql = make<DB>()

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <_ extends true>() => {}

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, SqliteClient.layer({ filename: ":memory:" }))))

const insertNote = sql(`INSERT INTO notes (title, body) VALUES (:title, :body) RETURNING id, title, body`)
const selectOpen = sql(`SELECT id, title AS name FROM notes WHERE done = :done AND id>=:from ORDER BY id LIMIT :limit`)
const finishNote = sql(`UPDATE notes SET done = 1, body = COALESCE(:body, body) WHERE id = :id RETURNING *`)
const deleteNote = sql(`DELETE FROM notes WHERE id = :id`)
const countNotes = sql(`SELECT COUNT(*) AS total FROM notes`)

test("the schema comes from the migrations", () => {
  assertType<
    Equal<
      DB,
      {
        notes: {
          id: Column<number, false, true>
          title: Column<string, false, false>
          body: Column<string, true, true>
          done: Column<number, false, true>
          created_at: Column<number, false, true>
        }
      }
    >
  >()
})

test("table constraints, keys and repeated IF NOT EXISTS shape the schema as SQLite does", () => {
  type Keys = Schema<
    [
      "CREATE TABLE a (code TEXT PRIMARY KEY NOT NULL, slug TEXT PRIMARY KEY, email TEXT, UNIQUE (email), CHECK (email NOT NULL))",
      "CREATE TABLE IF NOT EXISTS a (other INTEGER)",
    ]
  >
  assertType<
    Equal<Keys, { a: { code: Column<string, false, false>; slug: Column<string, true, true>; email: Column<string, true, true> } }>
  >()
})

test("rows and parameters are typed from the query", () => {
  assertType<Equal<RowOf<typeof selectOpen>, { id: number; name: string }>>()
  assertType<Equal<Parameters<typeof selectOpen>, [params: { done: number; from: number; limit: number }]>>()
  assertType<Equal<Parameters<typeof insertNote>, [params: { title: string; body: string | null }]>>()
  assertType<Equal<Parameters<typeof finishNote>, [params: { body: string | null; id: number }]>>()
  assertType<Equal<RowOf<typeof finishNote>, { id: number; title: string; body: string | null; done: number; created_at: number }>>()
  assertType<Equal<RowOf<typeof deleteNote>, never>>()
  assertType<Equal<Parameters<typeof countNotes>, []>>()
})

test("mistakes in a query fail to compile", () => {
  // @ts-expect-error no such column: titel
  sql(`SELECT titel FROM notes`)
  // @ts-expect-error no such column: titel
  sql(`SELECT id FROM notes WHERE titel = :title`)
  // @ts-expect-error no such table: users
  sql(`SELECT id FROM users`)
  // @ts-expect-error missing required column: title
  sql(`INSERT INTO notes (body) VALUES (:body)`)
  // @ts-expect-error fewer values than columns
  sql(`INSERT INTO notes (title, body) VALUES (:title)`)
  // @ts-expect-error cannot infer the type of :n
  sql(`SELECT id FROM notes WHERE length(title) > :n`)
  // @ts-expect-error no such column: missing
  sql(`SELECT id FROM notes WHERE id = missing`)
  // @ts-expect-error no such column: missing
  sql(`SELECT id FROM notes ORDER BY missing`)
  // @ts-expect-error cannot infer the type of :body
  sql(`INSERT INTO notes (title, body) VALUES (:title, upper(:body))`)
  // @ts-expect-error UNION is not supported
  sql(`SELECT id FROM notes UNION SELECT title FROM notes`)
  // @ts-expect-error JOIN is not supported
  sql(`SELECT id FROM notes JOIN tags WHERE id = :id`)
  // @ts-expect-error duplicate result column: value
  sql(`SELECT id AS value, title AS value FROM notes`)
  // @ts-expect-error one statement per string
  sql(`DELETE FROM notes; DELETE FROM notes`)
  const which = Math.random() > 0.5 ? "SELECT id FROM notes WHERE id = :id" : "SELECT id FROM notes WHERE title = :title"
  // @ts-expect-error a query is one literal string, not a union
  sql(which)
  // @ts-expect-error id is a number
  void deleteNote({ id: "1" })
})

test("migrations apply once and statements run with their parameters", async () => {
  const result = await run(
    Effect.gen(function* () {
      yield* migrate(migrations)
      yield* migrate(migrations)
      const [first] = yield* insertNote({ title: "milk", body: null })
      yield* insertNote({ title: "eggs", body: "a dozen" })
      const finished = yield* finishNote({ id: first?.id ?? 0, body: "oat" })
      yield* deleteNote({ id: 2 })
      const [quoted] = yield* sql(`INSERT INTO notes (title, body) VALUES ('time:zone', :body) RETURNING id, title;`)({ body: null })
      yield* deleteNote({ id: quoted?.id ?? 0 })
      return { quoted: quoted?.title, first, finished, open: yield* selectOpen({ done: 1, from: 0, limit: 10 }), count: yield* countNotes() }
    })
  )
  expect(result).toEqual({
    quoted: "time:zone",
    first: { id: 1, title: "milk", body: null },
    finished: [{ id: 1, title: "milk", body: "oat", done: 1, created_at: 0 }],
    open: [{ id: 1, name: "milk" }],
    count: [{ total: 1 }],
  })
})

test("an applied migration that was edited is refused", async () => {
  const exit = await run(
    Effect.gen(function* () {
      yield* migrate([`CREATE TABLE a (id INTEGER PRIMARY KEY)`])
      return yield* migrate([`CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT)`]).pipe(Effect.flip)
    })
  )
  expect(exit.reason).toBe("edited")
})
