import { type Brand, Config, ConfigProvider, Effect, Option, Redacted, Schema } from "effect"
import { CredentialsError, Keyring } from "./keyring.ts"

// A secret's value, branded with its name so a client can ask for exactly the key it needs.
export type Value<Name extends string, A = string> = Redacted.Redacted<A> & Brand.Brand<Name>

export interface SecretOptions<A, Optional extends boolean> {
  // Shown by login prompts and in errors; defaults to the name.
  readonly label?: string
  // An optional secret's config is an Option; a required one fails when it is missing.
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
  readonly lookup: Effect.Effect<Option.Option<Found>, CredentialsError | Config.ConfigError, Keyring>
  // Validates the text against the schema, then stores it in the keyring.
  readonly save: (text: string) => Effect.Effect<void, CredentialsError, Keyring>
  // False when nothing was stored.
  readonly remove: Effect.Effect<boolean, CredentialsError, Keyring>
  // The schema's message when the text does not decode.
  readonly validate: (text: string) => Effect.Effect<void, string>
}

export interface Secret<Name extends string, A = string, Optional extends boolean = false> extends SecretEntry {
  readonly name: Name
  readonly optional: Optional
  // Read through the current ConfigProvider: the environment, then the keyring once `layer` is provided.
  readonly config: Config.Config<Optional extends true ? Option.Option<Value<Name, A>> : Value<Name, A>>
}

// A secret read from the environment variable `name`, otherwise from the keyring entry `name`.
// Apps that declare the same name share the stored value.
export const secret = <const Name extends string, A = string, const Optional extends boolean = false>(
  name: Name,
  options: SecretOptions<A, Optional> = {}
): Secret<Name, A, Optional> => {
  const label = options.label ?? name
  const optional = (options.optional ?? false) as Optional
  const codec = Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString), Schema.decodeTo((options.schema ?? Schema.String) as Schema.Codec<A, string>))
  const decode = Schema.decodeUnknownEffect(codec)

  const present = Config.option(Config.schema(codec, name)).pipe(Config.map(Option.map((value) => Redacted.make(value, { label: name }) as Value<Name, A>)))
  const required = present.pipe(
    Config.flatMap(
      Option.match({
        onNone: () => Config.fail(new ConfigProvider.SourceError({ message: `${label} is not set: export ${name} or store it with the login command` })),
        onSome: (value) => Config.succeed(value),
      })
    )
  )
  const config = (optional ? present : required) as Secret<Name, A, Optional>["config"]

  // Config sees the environment and the keyring merged; a keyring entry equal to the value means it came from there.
  const lookup = Effect.gen(function* () {
    const text = Option.filter(
      Option.map(yield* Config.option(Config.String(name)), (value) => value.trim()),
      (value) => value !== ""
    )
    if (Option.isNone(text)) {
      return Option.none<Found>()
    }
    const stored = yield* (yield* Keyring).get(name)
    const source: Source = Option.exists(stored, (value) => value.trim() === text.value) ? "keyring" : "env"
    return Option.some<Found>({ source, text: Redacted.make(text.value, { label: name }) })
  })

  const validate = (text: string) =>
    decode(text).pipe(
      Effect.asVoid,
      Effect.mapError((error) => error.message)
    )

  const save = (text: string) =>
    Effect.gen(function* () {
      yield* decode(text).pipe(Effect.mapError((error) => new CredentialsError({ name, reason: "invalid", message: `${label} (${name}) is invalid: ${error.message}` })))
      yield* (yield* Keyring).set(name, text.trim())
    })

  const remove = Effect.gen(function* () {
    return yield* (yield* Keyring).remove(name)
  })

  return { name, label, optional, sensitive: options.sensitive ?? true, lookup, config, save, remove, validate }
}
