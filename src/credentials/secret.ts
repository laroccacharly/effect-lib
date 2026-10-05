import { type Brand, Config, Effect, Option, Redacted, Schema } from "effect"
import { CredentialsError, Keyring } from "./keyring.ts"

// A secret's value, branded with its name so a client can ask for exactly the key it needs.
export type Value<Name extends string, A = string> = Redacted.Redacted<A> & Brand.Brand<Name>

export interface SecretOptions<A, Optional extends boolean> {
  // Shown by login prompts and in errors; defaults to the name.
  readonly label?: string
  // An optional secret resolves to an Option; a required one fails when it is missing.
  readonly optional?: Optional
  // Decodes the trimmed text; defaults to the text itself.
  readonly schema?: Schema.Codec<A, string>
  // False shows the value while typing it and in status. Defaults to true.
  readonly sensitive?: boolean
}

export type Source = "env" | "keyring"

export interface Found {
  readonly source: Source
  readonly text: Redacted.Redacted<string>
}

// What login, logout and status need, the same for every secret whatever its name and type.
export interface SecretEntry {
  readonly name: string
  readonly label: string
  readonly optional: boolean
  readonly sensitive: boolean
  // The trimmed text and where it comes from: the environment first, then the keyring. None when blank or absent.
  readonly lookup: Effect.Effect<Option.Option<Found>, CredentialsError>
  // Validates the text against the schema, then stores it in the keyring.
  readonly save: (text: string) => Effect.Effect<void, CredentialsError>
  // False when nothing was stored.
  readonly remove: Effect.Effect<boolean, CredentialsError>
  // The schema's message when the text does not decode.
  readonly validate: (text: string) => Effect.Effect<void, string>
}

export interface Secret<Name extends string, A = string, Optional extends boolean = false> extends SecretEntry {
  readonly name: Name
  readonly optional: Optional
  // The environment first, then the keyring.
  readonly resolve: Effect.Effect<Optional extends true ? Option.Option<Value<Name, A>> : Value<Name, A>, CredentialsError>
}

const present = (text: Option.Option<string>) =>
  text.pipe(
    Option.map((value) => value.trim()),
    Option.filter((value) => value !== "")
  )

// A secret read from the environment variable `name`, otherwise from the keyring entry `name`.
// Apps that declare the same name share the stored value.
export const secret = <const Name extends string, A = string, const Optional extends boolean = false>(
  name: Name,
  options: SecretOptions<A, Optional> = {}
): Secret<Name, A, Optional> => {
  const label = options.label ?? name
  const optional = (options.optional ?? false) as Optional
  const schema = (options.schema ?? Schema.String) as Schema.Codec<A, string>
  const decode = Schema.decodeUnknownEffect(schema)

  const fromEnv = Config.option(Config.String(name)).pipe(
    Effect.map(present),
    Effect.orElseSucceed(() => Option.none<string>())
  )

  const lookup = Effect.gen(function* () {
    const env = yield* fromEnv
    if (Option.isSome(env)) {
      return Option.some<Found>({ source: "env", text: Redacted.make(env.value, { label: name }) })
    }
    const keyring = yield* Keyring
    const stored = present(yield* keyring.get(name))
    return Option.map(stored, (text): Found => ({ source: "keyring", text: Redacted.make(text, { label: name }) }))
  })

  const invalid = (source: string) => (error: Schema.SchemaError) =>
    new CredentialsError({ name, reason: "invalid", message: `${label} (${name}) from the ${source} is invalid: ${error.message}` })

  const resolveOption = Effect.gen(function* () {
    const found = yield* lookup
    if (Option.isNone(found)) {
      return Option.none<Value<Name, A>>()
    }
    const value = yield* decode(Redacted.value(found.value.text)).pipe(Effect.mapError(invalid(found.value.source)))
    return Option.some(Redacted.make(value, { label: name }) as Value<Name, A>)
  })

  const resolveRequired = resolveOption.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new CredentialsError({ name, reason: "missing", message: `${label} is not set: export ${name} or store it with the login command` })),
        onSome: Effect.succeed,
      })
    )
  )

  const resolve = (optional ? resolveOption : resolveRequired) as Secret<Name, A, Optional>["resolve"]

  const validate = (text: string) =>
    decode(text.trim()).pipe(
      Effect.asVoid,
      Effect.mapError((error) => error.message)
    )

  const save = (text: string) =>
    Effect.gen(function* () {
      const trimmed = text.trim()
      yield* decode(trimmed).pipe(Effect.mapError(invalid("input")))
      const keyring = yield* Keyring
      yield* keyring.set(name, trimmed)
    })

  const remove = Effect.gen(function* () {
    const keyring = yield* Keyring
    return yield* keyring.remove(name)
  })

  return { name, label, optional, sensitive: options.sensitive ?? true, lookup, resolve, save, remove, validate }
}
