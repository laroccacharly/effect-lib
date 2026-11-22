import type { SqlValue } from "./schema.ts"

// A statement's `:name` parameters as `?`, with their values in order.

// Quoted text comes first in the alternation, so a colon inside a string or a quoted name is left alone.
const PARAMETER = /('(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\])|:([A-Za-z_][A-Za-z0-9_]*)/g

export interface Compiled {
  readonly text: string
  readonly values: ReadonlyArray<SqlValue>
}

export const compile = (query: string, params: Readonly<Record<string, SqlValue>>): Compiled => {
  const values: Array<SqlValue> = []
  const text = query.replace(PARAMETER, (match, _quoted: string, name: string) => {
    if (!match.startsWith(":")) {
      return match
    }
    values.push(params[name] ?? null)
    return "?"
  })
  return { text, values }
}
