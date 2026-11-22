// The database type of a list of migrations: CREATE TABLE and ALTER TABLE ... ADD COLUMN, in order.

import type { AnySqlTypeError, Simplify, SqlTypeError } from "./errors.ts"
import type { Parens, Single, SplitTop, Tokenize, Tokens } from "./tokens.ts"

// Optional means an INSERT may leave the column out.
// What SQLite stores and returns.
export type SqlValue = string | number | bigint | Uint8Array | null

export interface Column<T = SqlValue, Nullable extends boolean = boolean, Optional extends boolean = boolean> {
  readonly type: T
  readonly nullable: Nullable
  readonly optional: Optional
}
export type TableShape = Record<string, Column>
export type DatabaseShape = Record<string, TableShape>

// SQLite's type affinity rules, by declared type name.
type Affinity<T extends string> =
  Uppercase<T> extends `${string}INT${string}` ? number
  : Uppercase<T> extends `${string}CHAR${string}` | `${string}CLOB${string}` | `${string}TEXT${string}` ? string
  : Uppercase<T> extends `${string}BLOB${string}` ? Uint8Array
  : number

type Has<Constraints extends Tokens, K extends string> = K extends Constraints[number] ? true : false
// Only INTEGER PRIMARY KEY aliases the rowid, which SQLite fills in; any other key may even hold NULL.
type IsRowid<Type extends string, C extends Tokens> = Uppercase<Type> extends "INTEGER" ? Has<C, "PRIMARY"> : false
type IsNullable<Type extends string, C extends Tokens> = Has<C, "NOT"> extends true ? false : IsRowid<Type, C> extends true ? false : true
type IsOptional<Type extends string, C extends Tokens> =
  Has<C, "DEFAULT"> extends true ? true : IsRowid<Type, C> extends true ? true : IsNullable<Type, C>

type ColumnDef<D extends Tokens> =
  D extends readonly [infer Name extends string, infer Type extends string, ...infer Constraints extends Tokens]
    ? Type extends "NOT" | "NULL" | "PRIMARY" | "DEFAULT" | "UNIQUE" ? SqlTypeError<`column ${Name} needs a type`>
    : [Name, Column<Affinity<Type>, IsNullable<Type, Constraints>, IsOptional<Type, Constraints>>]
    : SqlTypeError<`column ${D[0] & string} needs a type`>

type Columns<Defs extends Array<Tokens>, Acc extends TableShape = {}> =
  Defs extends [infer D extends Tokens, ...infer Rest extends Array<Tokens>]
    ? D extends readonly [TableConstraint, ...Tokens] ? Columns<Rest, Acc>
    : ColumnDef<D> extends [infer N extends string, infer C extends Column] ? Columns<Rest, Acc & { [K in N]: C }> : ColumnDef<D>
    : Simplify<Acc>

// Table constraints add no column.
type TableConstraint = "PRIMARY" | "UNIQUE" | "CHECK" | "FOREIGN" | "CONSTRAINT"

type WithoutIfNotExists<T extends Tokens> = T extends readonly ["IF", "NOT", "EXISTS", ...infer Rest extends Tokens] ? Rest : T

// IF NOT EXISTS on a table that exists does nothing, so its shape stays.
type CreateTable<DB extends DatabaseShape, T extends Tokens> =
  WithoutIfNotExists<T> extends readonly [infer Name extends string, ...infer Body extends Tokens]
    ? Name extends keyof DB ? T extends WithoutIfNotExists<T> ? SqlTypeError<`table ${Name} already exists`> : DB
    : Columns<SplitTop<Parens<Body>[0], ",">> extends infer C ? C extends AnySqlTypeError ? C : Simplify<DB & { [K in Name]: C }> : never
    : SqlTypeError<"expected a table name">

type AddColumn<DB extends DatabaseShape, Table extends string, D extends Tokens> =
  Table extends keyof DB
    ? ColumnDef<D> extends [infer N extends string, infer C extends Column]
      ? Simplify<Omit<DB, Table> & { [K in Table]: Simplify<DB[Table] & { [Col in N]: C }> }>
      : ColumnDef<D>
    : SqlTypeError<`no such table: ${Table}`>

type Apply<DB extends DatabaseShape, T extends Tokens> =
  T extends readonly ["CREATE", "TABLE", ...infer Rest extends Tokens] ? CreateTable<DB, Rest>
  : T extends readonly ["ALTER", "TABLE", infer Table extends string, "ADD", ...infer Rest extends Tokens]
    ? AddColumn<DB, Table, Rest extends readonly ["COLUMN", ...infer D extends Tokens] ? D : Rest>
  : T extends readonly ["CREATE", "INDEX" | "UNIQUE", ...Tokens] ? DB
  : SqlTypeError<"a migration is CREATE TABLE, ALTER TABLE ... ADD COLUMN or CREATE INDEX">

export type Schema<Migrations extends ReadonlyArray<string>, DB extends DatabaseShape = {}> =
  Migrations extends readonly [infer M extends string, ...infer Rest extends ReadonlyArray<string>]
    ? (Single<Tokenize<M>> extends infer T extends Tokens ? Apply<DB, T> : Single<Tokenize<M>>) extends infer Next ? Next extends DatabaseShape ? Schema<Rest, Next> : Next : never
    : DB
