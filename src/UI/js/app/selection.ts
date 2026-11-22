// The timer selection on the page (ShowTrak Server's selection, for timers): a
// click on a tile toggles it, a click on a group's rail (or its number key)
// toggles the whole group, Ctrl/Cmd+A selects everything, Ctrl/Cmd+D or Escape
// clears. Selected tiles carry the SELECTED class. The rules are in
// lib/selection-model.ts; this applies them to the page and the bottom bar.
import { SelectionModel, DescribeSelection } from './lib/selection-model';
import { TimerIDsInGroup } from './lib/group-layout';
import { Groups } from './state';
import type { TimerView } from '@showtrak/protocol/timers';

const Model = new SelectionModel();
const Listeners = new Set<() => void>();
let KnownTimers: () => readonly TimerView[] = () => [];

/** Where the selection reads the current timers from (timers.ts, at boot). */
export function SetTimerSource(Source: () => readonly TimerView[]): void {
  KnownTimers = Source;
}

export function OnSelectionChange(Listener: () => void): void {
  Listeners.add(Listener);
}

export function SelectedIDs(): number[] {
  // In display order, not the order they were picked.
  const Order = KnownTimers().map((T) => T.ID);
  return Order.filter((ID) => Model.Has(ID));
}

export function SelectedTimers(): TimerView[] {
  return KnownTimers().filter((T) => Model.Has(T.ID));
}

export function IsSelected(ID: number): boolean {
  return Model.Has(ID);
}

export function SelectionCount(): number {
  return Model.Size;
}

// Mark the tiles and tell whoever is listening (the bottom bar).
export function PaintSelection(): void {
  for (const El of Array.from(
    document.querySelectorAll<HTMLElement>('.SHOWTRAK_TIMER[data-timer-id]')
  )) {
    El.classList.toggle('SELECTED', Model.Has(Number(El.getAttribute('data-timer-id'))));
  }
  document.body.classList.toggle('has-selection', Model.Size > 0);
  for (const Listener of Listeners) Listener();
}

function Changed(Did: boolean): void {
  if (Did) PaintSelection();
}

export function ToggleSelection(ID: number): void {
  Changed(Model.Toggle(ID));
}

export function SelectOnly(ID: number): void {
  Changed(Model.Set([ID]));
}

export function SelectMany(IDs: readonly number[]): void {
  Changed(Model.Set(IDs));
}

export function SelectAll(): void {
  Changed(Model.Add(KnownTimers().map((T) => T.ID)));
}

export function ClearSelection(): void {
  Changed(Model.Clear());
}

/** Toggle every timer in a group (null: the Default group). */
export function ToggleGroupSelection(GroupID: number | null): void {
  Changed(Model.ToggleGroup(TimerIDsInGroup(Groups, KnownTimers(), GroupID)));
}

/** After the timers change: forget any that have gone, and re-mark the new tiles. */
export function ReconcileSelection(): void {
  Model.Prune(new Set(KnownTimers().map((T) => T.ID)));
  PaintSelection();
}

export function SelectionStatusText(): string {
  return DescribeSelection(Model.Size);
}
