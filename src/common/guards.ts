// Type guards for values that arrive untyped: what JSON.parse returns, and
// payloads from files, sockets and third-party callbacks. Each narrows
// `unknown` to a type with no `any` in it (Array.isArray narrows to `any[]`, so
// the elements of what it accepts would go unchecked). Used by every surface.

/** An object with named fields: not null, and not an array. */
export function IsRecord(Value: unknown): Value is Record<string, unknown> {
  return typeof Value === 'object' && Value !== null && !Array.isArray(Value);
}

/** Array.isArray, but each element stays `unknown` until it is checked. */
export function IsArray(Value: unknown): Value is readonly unknown[] {
  return Array.isArray(Value);
}
