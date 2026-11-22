// Validation of IPC arguments. Everything arriving from the renderer is
// `unknown`; these narrow it or throw a ValidationError, which the registrars
// turn into an `[Error, null]` result rather than an exception in the renderer.
import type { ControlAction } from '../../common/api';
import { IsArray, IsRecord } from '../../common/guards';

export class ValidationError extends Error {}

const CONTROL_ACTIONS: readonly ControlAction[] = ['Start', 'Stop', 'Pause', 'Unpause'];

export function TimerID(Value: unknown): number {
  // A number, or a numeric string; not anything Number() happens to coerce
  // (true is 1, [5] is 5).
  if (typeof Value !== 'number' && !(typeof Value === 'string' && /^\s*\d+\s*$/.test(Value))) {
    throw new ValidationError('Invalid timer ID');
  }
  const ID = Number(Value);
  if (!Number.isInteger(ID) || ID <= 0) throw new ValidationError('Invalid timer ID');
  return ID;
}

export function Action(Value: unknown): ControlAction {
  const Match = CONTROL_ACTIONS.find((A) => A.toLowerCase() === String(Value).toLowerCase());
  if (!Match) throw new ValidationError('Invalid timer action');
  return Match;
}

export function PlainObject(Value: unknown, Label = 'payload'): Record<string, unknown> {
  if (Value === undefined || Value === null) return {};
  if (!IsRecord(Value)) throw new ValidationError(`Invalid ${Label}`);
  return Value;
}

/** A timer list (a selection): at least one, each a valid ID. */
export function TimerIDs(Value: unknown): number[] {
  if (!IsArray(Value) || Value.length === 0 || Value.length > 10000) {
    throw new ValidationError('Invalid timer list');
  }
  return [...new Set(Value.map(TimerID))];
}

export function GroupID(Value: unknown): number {
  if (typeof Value !== 'number' && !(typeof Value === 'string' && /^\s*\d+\s*$/.test(Value))) {
    throw new ValidationError('Invalid group ID');
  }
  const ID = Number(Value);
  if (!Number.isInteger(ID) || ID <= 0) throw new ValidationError('Invalid group ID');
  return ID;
}

/** A group, or null for the Default group. */
export function GroupRef(Value: unknown): number | null {
  return Value === null || Value === undefined ? null : GroupID(Value);
}

export function GroupIDList(Value: unknown): number[] {
  if (!IsArray(Value) || Value.length > 10000) throw new ValidationError('Invalid order');
  return Value.map(GroupID);
}

/** Timers in their groups, in order (dragging tiles between groups). */
export function Placements(Value: unknown): Array<{ ID: number; GroupID: number | null }> {
  if (!IsArray(Value) || Value.length > 10000) {
    throw new ValidationError('Invalid arrangement');
  }
  return Value.map((Entry) => {
    const Item = PlainObject(Entry, 'arrangement');
    return { ID: TimerID(Item.ID), GroupID: GroupRef(Item.GroupID) };
  });
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
