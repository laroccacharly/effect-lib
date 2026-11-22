// SQL text split into words by the type checker: keywords upper-cased, quoted names unquoted.

import type { SqlTypeError } from "./errors.ts"

type Ws = " " | "\n" | "\t" | "\r"
type Punct = "(" | ")" | "," | ";"
type OpChar = "=" | "<" | ">" | "!"
type Op = OpChar | "<=" | ">=" | "!=" | "<>" | "=="
type Keyword =
  | "CREATE" | "TABLE" | "INDEX" | "ALTER" | "ADD" | "COLUMN" | "IF" | "NOT" | "EXISTS" | "NULL" | "PRIMARY" | "KEY"
  | "AUTOINCREMENT" | "DEFAULT" | "UNIQUE" | "ON" | "SELECT" | "FROM" | "WHERE" | "ORDER" | "BY" | "LIMIT" | "OFFSET"
  | "AS" | "AND" | "OR" | "IS" | "LIKE" | "ASC" | "DESC" | "INSERT" | "INTO" | "VALUES" | "UPDATE" | "SET" | "DELETE"
  | "RETURNING" | "COALESCE" | "COUNT" | "CHECK" | "FOREIGN" | "CONSTRAINT" | "REFERENCES" | "UNION" | "INTERSECT" | "EXCEPT"
  | "JOIN"

type Unquote<T extends string> = T extends `"${infer N}"` | `\`${infer N}\`` | `[${infer N}]` ? N : T
type Normalize<T extends string> = Uppercase<T> extends Keyword ? Uppercase<T> : Unquote<T>
type Push<A extends Tokens, T extends string> = T extends "" ? A : [...A, Normalize<T>]

export type Tokens = ReadonlyArray<string>

// Operators are their own words even without spaces around them, so `id=:id` is three words.
export type Tokenize<S extends string, Word extends string = "", Acc extends Tokens = []> =
  S extends `${infer C}${infer Rest}`
    ? C extends Ws ? Tokenize<Rest, "", Push<Acc, Word>>
    : C extends Punct ? Tokenize<Rest, "", [...Push<Acc, Word>, C]>
    : C extends OpChar ? Word extends Op ? Tokenize<Rest, `${Word}${C}`, Acc> : Tokenize<Rest, C, Push<Acc, Word>>
    : Word extends Op ? Tokenize<Rest, C, Push<Acc, Word>>
    : Tokenize<Rest, `${Word}${C}`, Acc>
    : Push<Acc, Word>

type Depth = ReadonlyArray<0>
type Leave<D extends Depth> = D extends readonly [0, ...infer Outer extends Depth] ? Outer : []

// `T` split at each `Sep` outside parentheses.
export type SplitTop<T extends Tokens, Sep extends string, D extends Depth = [], Part extends Tokens = [], Acc extends Array<Tokens> = []> =
  T extends readonly [infer H extends string, ...infer Rest extends Tokens]
    ? H extends Sep ? D extends [] ? SplitTop<Rest, Sep, D, [], [...Acc, Part]> : SplitTop<Rest, Sep, D, [...Part, H], Acc>
    : H extends "(" ? SplitTop<Rest, Sep, [...D, 0], [...Part, H], Acc>
    : H extends ")" ? SplitTop<Rest, Sep, Leave<D>, [...Part, H], Acc>
    : SplitTop<Rest, Sep, D, [...Part, H], Acc>
    : [...Acc, Part]

export type Join<Parts extends Array<Tokens>, Sep extends string> =
  Parts extends [infer A extends Tokens, ...infer Rest extends Array<Tokens>] ? Rest extends [] ? A : [...A, Sep, ...Join<Rest, Sep>] : []

export type Concat<Parts extends Array<Tokens>> =
  Parts extends [infer A extends Tokens, ...infer Rest extends Array<Tokens>] ? [...A, ...Concat<Rest>] : []

// [before, after] the first `Sep` outside parentheses, or [T, null] without one.
export type SplitOnce<T extends Tokens, Sep extends string> =
  SplitTop<T, Sep> extends [infer A extends Tokens, ...infer Rest extends Array<Tokens>] ? [A, Rest extends [] ? null : Join<Rest, Sep>] : never

// One statement: without its trailing semicolon, or an error when there are several.
export type Single<T extends Tokens> =
  (T extends readonly [...infer Body extends Tokens, ";"] ? Body : T) extends infer Body extends Tokens
    ? ";" extends Body[number] ? SqlTypeError<"one statement per string"> : Body
    : never

// [inside, after] the parentheses that open `T`.
export type Parens<T extends Tokens, D extends Depth = [], Acc extends Tokens = []> =
  T extends readonly [infer H extends string, ...infer Rest extends Tokens]
    ? H extends "(" ? D extends [] ? Parens<Rest, [0], []> : Parens<Rest, [...D, 0], [...Acc, H]>
    : H extends ")" ? D extends [0] ? [Acc, Rest] : Parens<Rest, Leave<D>, [...Acc, H]>
    : Parens<Rest, D, [...Acc, H]>
    : never
