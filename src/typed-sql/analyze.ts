// The row and `:name` parameters of a statement, from its text: SELECT, INSERT, UPDATE and DELETE on one table.

import type { AnySqlTypeError, Simplify, SqlTypeError } from "./errors.ts"
import type { Column, DatabaseShape, SqlValue, TableShape } from "./schema.ts"
import type { Concat, Parens, Single, SplitOnce, SplitTop, Tokenize, Tokens } from "./tokens.ts"

export interface Analysis<Row = object, Params = Readonly<Record<string, SqlValue>>> {
  readonly row: Row
  readonly params: Params
}

type TsType<C extends Column> = C["nullable"] extends true ? C["type"] | null : C["type"]
type Table<DB extends DatabaseShape, N extends string> = N extends keyof DB ? DB[N] : SqlTypeError<`no such table: ${N}`>
type Compare = "=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">=" | "LIKE" | "IS"

type Field<Name extends string, T> = { [K in Name]: T }
type Item<C extends TableShape, I extends Tokens> =
  I extends readonly ["*"] ? { [K in keyof C]: TsType<C[K]> }
  : I extends readonly ["COUNT", "(", ...Tokens[number][], ")", "AS", infer A extends string] ? Field<A, number>
  : I extends readonly [infer Col extends string, ...infer Alias extends Tokens]
    ? Col extends keyof C
      ? Alias extends [] ? Field<Col, TsType<C[Col]>>
      : Alias extends readonly ["AS", infer A extends string] ? Field<A, TsType<C[Col]>>
      : SqlTypeError<`unsupported projection after ${Col}`>
    : SqlTypeError<`no such column: ${Col}`>
  : SqlTypeError<"empty projection">

type Project<C extends TableShape, Items extends Array<Tokens>, Acc = {}> =
  Items extends [infer I extends Tokens, ...infer Rest extends Array<Tokens>]
    ? Item<C, I> extends infer F
      ? F extends AnySqlTypeError ? F
      : [keyof F & keyof Acc] extends [never] ? Project<C, Rest, Acc & F>
      : SqlTypeError<`duplicate result column: ${keyof F & keyof Acc & string}`>
      : never
    : Simplify<Acc>

// Each `:name` takes the type of the column it is compared with; COALESCE(:name, col) also takes null.
type InferParams<C extends TableShape, T extends Tokens, Acc = {}> =
  T extends readonly ["COALESCE", "(", `:${infer N}`, ",", infer Col extends keyof C & string, ")", ...infer Rest extends Tokens]
    ? InferParams<C, Rest, Acc & Field<N, C[Col]["type"] | null>>
  : T extends readonly [infer Col extends keyof C & string, Compare, `:${infer N}`, ...infer Rest extends Tokens]
    ? InferParams<C, Rest, Acc & Field<N, TsType<C[Col]>>>
  : T extends readonly [`:${infer N}`, Compare, infer Col extends keyof C & string, ...infer Rest extends Tokens]
    ? InferParams<C, Rest, Acc & Field<N, TsType<C[Col]>>>
  : T extends readonly ["LIMIT" | "OFFSET", `:${infer N}`, ...infer Rest extends Tokens] ? InferParams<C, Rest, Acc & Field<N, number>>
  : T extends readonly [string, ...infer Rest extends Tokens] ? InferParams<C, Rest, Acc>
  : Acc

type Keyword = Uppercase<string>
// What can stand on either side of a comparison: a lowercase name there must be a column, so a typo is an error.
type Operand<C extends TableShape> = keyof C | `:${string}` | `${number}` | `'${string}` | "(" | ")" | Keyword

type CheckColumns<C extends TableShape, T extends Tokens> =
  T extends readonly [infer Left extends string, Compare, infer Right extends string, ...infer Rest extends Tokens]
    ? Left extends Operand<C> ? Right extends Operand<C> ? CheckColumns<C, Rest> : SqlTypeError<`no such column: ${Right}`>
    : SqlTypeError<`no such column: ${Left}`>
  : T extends readonly ["ORDER", "BY", ...infer Rest extends Tokens] ? CheckOrderBy<C, Rest>
  : T extends readonly [string, ...infer Rest extends Tokens] ? CheckColumns<C, Rest>
  : null

type CheckOrderBy<C extends TableShape, T extends Tokens> =
  T extends readonly [infer H extends string, ...infer Rest extends Tokens]
    ? H extends "LIMIT" | "OFFSET" | "RETURNING" ? CheckColumns<C, T>
    : H extends keyof C | "," | Keyword ? CheckOrderBy<C, Rest>
    : SqlTypeError<`no such column: ${H}`>
    : null

type ParamName<T> = T extends `:${infer N}` ? N : never
type Untyped<T extends Tokens, P> = Exclude<ParamName<T[number]>, keyof P>

type Params<C extends TableShape, T extends Tokens, Known = {}> =
  CheckColumns<C, T> extends infer E extends AnySqlTypeError ? E
  : Simplify<Known & InferParams<C, T>> extends infer P
    ? [Untyped<T, P>] extends [never] ? P : SqlTypeError<`cannot infer the type of :${Untyped<T, P> & string}`>
    : never

// [statement before RETURNING, row]; without RETURNING the statement yields no rows.
type Returning<C extends TableShape, T extends Tokens> =
  SplitOnce<T, "RETURNING"> extends [infer Body extends Tokens, infer Ret] ? [Body, Ret extends Tokens ? Project<C, SplitTop<Ret, ",">> : never] : never

// never (no RETURNING) is checked first: it extends every type, errors included.
type Done<Row, P> = [Row] extends [never] ? ([P] extends [AnySqlTypeError] ? P : Analysis<never, P>) : [Row] extends [AnySqlTypeError] ? Row : [P] extends [AnySqlTypeError] ? P : Analysis<Row, P>

// One table, no alias: what follows its name is a clause.
type SelectTail<C extends TableShape, Items extends Tokens, Rest extends Tokens> =
  Rest extends [] | readonly ["WHERE" | "ORDER" | "LIMIT", ...Tokens]
    ? Done<Project<C, SplitTop<Items, ",">>, Params<C, Rest>>
    : SqlTypeError<`expected WHERE, ORDER BY or LIMIT after the table, not ${Rest[0] & string}`>

type Select<DB extends DatabaseShape, T extends Tokens> =
  SplitOnce<T, "FROM"> extends [infer Items extends Tokens, readonly [infer N extends string, ...infer Rest extends Tokens]]
    ? Table<DB, N> extends infer C extends TableShape ? SelectTail<C, Items, Rest> : Table<DB, N>
    : SqlTypeError<"expected FROM <table>">

type InsertParams<C extends TableShape, Cols extends Tokens, Values extends Array<Tokens>, Acc = {}> =
  Cols extends readonly [infer Col extends string, ...infer ColsRest extends Tokens]
    ? Col extends keyof C
      ? Values extends [infer V extends Tokens, ...infer ValuesRest extends Array<Tokens>]
        ? InsertParams<C, ColsRest, ValuesRest, V extends readonly [`:${infer N}`] ? Acc & Field<N, TsType<C[Col]>> : Acc>
        : SqlTypeError<"fewer values than columns">
      : SqlTypeError<`no such column: ${Col}`>
    : Values extends [] ? Simplify<Acc> : SqlTypeError<"more values than columns">

type Required<C extends TableShape, Listed extends Tokens> =
  { [K in keyof C]: C[K]["optional"] extends true ? never : K extends Listed[number] ? never : K }[keyof C]

// A parameter inside an expression, such as upper(:title), has no column to type it.
type InsertChecked<C extends TableShape, Values extends Tokens, Rest extends Tokens, P> =
  [Untyped<Values, P>] extends [never]
    ? Rest extends [] | readonly ["RETURNING", ...Tokens]
      ? Returning<C, Rest> extends [Tokens, infer Row] ? Done<Row, P> : never
      : SqlTypeError<`expected RETURNING after VALUES, not ${Rest[0] & string}`>
    : SqlTypeError<`cannot infer the type of :${Untyped<Values, P> & string}`>

type InsertInto<C extends TableShape, Cols extends Tokens, Values extends Tokens, Rest extends Tokens> =
  [Required<C, Cols>] extends [never]
    ? InsertParams<C, Cols, SplitTop<Values, ",">> extends infer P
      ? [P] extends [AnySqlTypeError] ? P : InsertChecked<C, Values, Rest, P>
      : never
    : SqlTypeError<`missing required column: ${Required<C, Cols> & string}`>

type Insert<C extends TableShape, T extends Tokens> =
  Parens<T> extends [infer Cols extends Tokens, readonly ["VALUES", ...infer AfterValues extends Tokens]]
    ? Parens<AfterValues> extends [infer Values extends Tokens, infer Rest extends Tokens]
      ? InsertInto<C, Concat<SplitTop<Cols, ",">>, Values, Rest>
      : SqlTypeError<"expected VALUES (...)">
    : SqlTypeError<"expected (columns) VALUES (...)">

type Mutation<C extends TableShape, T extends Tokens> =
  Returning<C, T> extends [infer Body extends Tokens, infer Row] ? Done<Row, Params<C, Body>> : never

type OnTable<DB extends DatabaseShape, N extends string, T extends Tokens, Kind extends "insert" | "mutation"> =
  Table<DB, N> extends infer C extends TableShape ? Kind extends "insert" ? Insert<C, T> : Mutation<C, T> : Table<DB, N>

type Unsupported = "SELECT" | "UNION" | "INTERSECT" | "EXCEPT" | "JOIN"

// Subqueries, joins and compound selects would be typed from their first table only, so they are refused.
type Statement<DB extends DatabaseShape, T extends Tokens> =
  T extends readonly [string, ...infer Rest extends Tokens]
    ? [Extract<Rest[number], Unsupported>] extends [never] ? Supported<DB, T> : SqlTypeError<`${Extract<Rest[number], Unsupported>} is not supported`>
    : SqlTypeError<"empty query">

type Supported<DB extends DatabaseShape, T extends Tokens> =
  T extends readonly ["SELECT", ...infer Rest extends Tokens] ? Select<DB, Rest>
  : T extends readonly ["INSERT", "INTO", infer N extends string, ...infer Rest extends Tokens] ? OnTable<DB, N, Rest, "insert">
  : T extends readonly ["UPDATE", infer N extends string, "SET", ...infer Rest extends Tokens] ? OnTable<DB, N, Rest, "mutation">
  : T extends readonly ["DELETE", "FROM", infer N extends string, ...infer Rest extends Tokens] ? OnTable<DB, N, Rest, "mutation">
  : SqlTypeError<"expected SELECT, INSERT, UPDATE or DELETE">

export type Analyze<DB extends DatabaseShape, Q extends string> =
  Single<Tokenize<Q>> extends infer T extends Tokens ? Statement<DB, T> : Single<Tokenize<Q>>

type IsUnion<T, All = T> = T extends T ? ([All] extends [T] ? false : true) : never

// `string` for a valid query, so `Check<DB, Q> & Q` is Q; otherwise the error, which no string matches.
// One literal only: a union of queries would take the parameters of either one.
export type Check<DB extends DatabaseShape, Q extends string> =
  string extends Q ? SqlTypeError<"a query is a literal string">
  : true extends IsUnion<Q> ? SqlTypeError<"a query is one literal string, not a union">
  : Analyze<DB, Q> extends infer A extends AnySqlTypeError ? A : string
