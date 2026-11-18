// Validation of IPC arguments. Everything arriving from the renderer is
// `unknown`; these narrow it or throw a ValidationError, which the registrars
// turn into an `[Error, null]` result rather than an exception in the renderer.
import type { ControlAction } from '../../common/api';

export class ValidationError extends Error {}

const CONTROL_ACTIONS: readonly ControlAction[] = ['Start', 'Stop', 'Pause', 'Unpause'];

export function TimerID(Value: unknown): number {
  const ID = Number(Value);
  if (!Number.isInteger(ID) || ID <= 0) throw new ValidationError('Invalid timer ID');
  return ID;
}

export function Action(Value: unknown): ControlAction {
  const Match = CONTROL_ACTIONS.find((A) => A.toLowerCase() === String(Value).toLowerCase());
  if (!Match) throw new ValidationError('Invalid timer action');
  return Match;
}

export function Direction(Value: unknown): 'UP' | 'DOWN' {
  const Upper = String(Value).toUpperCase();
  if (Upper !== 'UP' && Upper !== 'DOWN') throw new ValidationError('Invalid direction');
  return Upper;
}

export function PlainObject(Value: unknown, Label = 'payload'): Record<string, unknown> {
  if (Value === undefined || Value === null) return {};
  if (typeof Value !== 'object' || Array.isArray(Value)) {
    throw new ValidationError(`Invalid ${Label}`);
  }
  return Value as Record<string, unknown>;
}

export function IDList(Value: unknown): number[] {
  if (!Array.isArray(Value) || Value.length > 10000) throw new ValidationError('Invalid order');
  return Value.map(TimerID);
}

export function SettingKey(Value: unknown): string {
  if (typeof Value !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(Value)) {
    throw new ValidationError('Invalid Setting Key');
  }
  return Value;
}

export function SettingValue(Value: unknown): boolean | number | string {
  if (typeof Value === 'boolean' || typeof Value === 'number' || typeof Value === 'string') {
    if (typeof Value === 'string' && Value.length > 1000)
      throw new ValidationError('Value too long');
    return Value;
  }
  throw new ValidationError('Invalid setting value');
}

export function SoundID(Value: unknown): string {
  if (typeof Value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(Value)) {
    throw new ValidationError('Invalid sound');
  }
  return Value;
}

// Run a handler body, mapping a ValidationError (or any throw) to a result tuple.
export async function Guard<T>(
  Fn: () => Promise<[string | null, T | null]> | [string | null, T | null]
) {
  try {
    return await Fn();
  } catch (Err) {
    return [Err instanceof Error ? Err.message : String(Err), null] as [string, null];
  }
}
