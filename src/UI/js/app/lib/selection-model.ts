// The timer selection, as data (ShowTrak Server's selection rules, for timer
// IDs). Kept pure so the rules are tested without a DOM
// (test/renderer-selection-model.test.js); selection.ts applies it to the page.

export class SelectionModel {
  private readonly IDs = new Set<number>();

  /** The selected IDs, in the order they were selected. */
  List(): number[] {
    return [...this.IDs];
  }

  get Size(): number {
    return this.IDs.size;
  }

  Has(ID: number): boolean {
    return this.IDs.has(ID);
  }

  /** Returns whether anything changed. */
  Add(IDs: Iterable<number>): boolean {
    const Before = this.IDs.size;
    for (const ID of IDs) if (Number.isInteger(ID) && ID > 0) this.IDs.add(ID);
    return this.IDs.size !== Before;
  }

  Remove(IDs: Iterable<number>): boolean {
    let Changed = false;
    for (const ID of IDs) Changed = this.IDs.delete(ID) || Changed;
    return Changed;
  }

  Toggle(ID: number): boolean {
    if (this.IDs.has(ID)) this.IDs.delete(ID);
    else this.Add([ID]);
    return true;
  }

  /** Replace the selection with IDs. */
  Set(IDs: Iterable<number>): boolean {
    const Next = new Set([...IDs].filter((ID) => Number.isInteger(ID) && ID > 0));
    const Same = Next.size === this.IDs.size && [...Next].every((ID) => this.IDs.has(ID));
    if (Same) return false;
    this.IDs.clear();
    for (const ID of Next) this.IDs.add(ID);
    return true;
  }

  Clear(): boolean {
    if (!this.IDs.size) return false;
    this.IDs.clear();
    return true;
  }

  /**
   * A group rail click or keybind, as in Server: when every timer in the group
   * is already selected it deselects them, otherwise it selects them all.
   */
  ToggleGroup(IDs: readonly number[]): boolean {
    if (!IDs.length) return false;
    if (IDs.every((ID) => this.IDs.has(ID))) return this.Remove(IDs);
    return this.Add(IDs);
  }

  /** Forget timers that no longer exist. */
  Prune(Existing: ReadonlySet<number>): boolean {
    return this.Remove([...this.IDs].filter((ID) => !Existing.has(ID)));
  }
}

/** "3 Timers Selected" for the bottom bar; '' with nothing selected. */
export function DescribeSelection(Count: number): string {
  if (Count <= 0) return '';
  return `${Count} Timer${Count === 1 ? '' : 's'} Selected`;
}
