// What a query that fails the check is required to be, so tsc reports the message.
export interface SqlTypeError<M extends string> {
  readonly "SQL error": M
}

export type AnySqlTypeError = SqlTypeError<string>

export type Simplify<T> = { [K in keyof T]: T[K] } & {}
