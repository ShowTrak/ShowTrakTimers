// Groups: the pure rules about them, shared by the main process, the desktop
// renderer and the Web Dashboard. Modelled on ShowTrak Server's groups: a
// title, a slug for OSC, a colour that tints the group's box, a width on the
// group column grid, and an optional number key that toggles the group's
// selection. Timers in no group are in the Default group, which always exists,
// sits last, and cannot be edited, renamed or deleted.
//
// No Node, Electron or DOM dependencies (see ./timers.ts). GroupView, the shape
// every surface receives, is declared in @showtrak/protocol/timers.
import type { GroupView } from '@showtrak/protocol/timers';

// The Default group: what a timer with no GroupID belongs to. It is addressed
// over OSC as /ShowTrak/Group/Default/..., so no real group may take that slug.
export const DEFAULT_GROUP_TITLE = 'Default';
export const DEFAULT_GROUP_SLUG = 'Default';
export const RESERVED_GROUP_SLUGS: readonly string[] = [DEFAULT_GROUP_SLUG.toLowerCase()];

export const MAX_GROUP_TITLE_LENGTH = 32;
export const MAX_SLUG_LENGTH = 64;
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ShowTrak Server's shared palette (SCRIPT_COLOURS), in the same order, so a
// colour index means the same colour in both apps.
export const GROUP_COLOURS: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: '#e74c3c', label: 'Red' },
  { hex: '#e67e22', label: 'Orange' },
  { hex: '#f1c40f', label: 'Yellow' },
  { hex: '#2ecc71', label: 'Green' },
  { hex: '#3498db', label: 'Blue' },
  { hex: '#9b59b6', label: 'Purple' },
  { hex: '#bdc3c7', label: 'Light grey' },
  { hex: '#7f8c8d', label: 'Dark grey' },
];

// Selection keybinds: the number row and the numpad, as KeyboardEvent.code.
export const GROUP_KEYBINDS: readonly string[] = [
  ...Array.from({ length: 10 }, (_, N) => `Digit${N}`),
  ...Array.from({ length: 10 }, (_, N) => `Numpad${N}`),
];

// The group grid's column count (UI_GROUP_COLUMN_COUNT), as in Server.
export const DEFAULT_GROUP_COLUMN_COUNT = 2;
export const MIN_GROUP_COLUMN_COUNT = 2;
export const MAX_GROUP_COLUMN_COUNT = 6;
export const MAX_GROUP_COLUMN_SPAN = MAX_GROUP_COLUMN_COUNT;

// --- Normalisation ------------------------------------------------------------

/** A title cut to length on one line; empty when nothing usable is left. */
export function NormalizeGroupTitle(Value: unknown): string {
  return String(Value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_GROUP_TITLE_LENGTH);
}

// Groups default to full width, as in Server.
export function NormalizeFullWidth(Value: unknown): boolean {
  if (Value === null || Value === undefined) return true;
  if (typeof Value === 'boolean') return Value;
  return Value === 1 || Value === '1' || Value === 'true';
}

export function NormalizeColumnSpan(Value: unknown): number {
  const Span = Math.trunc(Number(Value));
  if (!Number.isFinite(Span) || Span < 1) return 1;
  return Math.min(MAX_GROUP_COLUMN_SPAN, Span);
}

/** A palette index, or null for none (anything outside the palette is none). */
export function NormalizeColour(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const N = Number(Value);
  return Number.isInteger(N) && N >= 0 && N < GROUP_COLOURS.length ? N : null;
}

export function NormalizeKeyBind(Value: unknown): string | null {
  if (Value === null || Value === undefined) return null;
  const KeyBind = String(Value).trim();
  return GROUP_KEYBINDS.includes(KeyBind) ? KeyBind : null;
}

// --- Slugs ----------------------------------------------------------------------

/**
 * Turn a label into a slug: letters, digits, "_" and "-", case kept, anything
 * else collapsed to a single "-". Empty when nothing usable remains.
 */
export function Slugify(Input: unknown): string {
  let S = typeof Input === 'string' ? Input : Input == null ? '' : String(Input);
  S = S.trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (S.length > MAX_SLUG_LENGTH) S = S.slice(0, MAX_SLUG_LENGTH).replace(/[-_]+$/g, '');
  return S;
}

export function IsValidSlug(Value: unknown): boolean {
  return typeof Value === 'string' && SLUG_PATTERN.test(Value);
}

export function IsReservedSlug(Value: unknown): boolean {
  return RESERVED_GROUP_SLUGS.includes(String(Value ?? '').toLowerCase());
}

/**
 * A free slug for Base: Base itself, or Base-2, Base-3 ... (compared without
 * case, and never a reserved slug). `Taken` holds the slugs already in use.
 */
export function UniqueSlug(Base: unknown, Taken: Iterable<string>): string {
  const Root = Slugify(Base) || 'Group';
  const Lower = new Set([...Taken].map((S) => S.toLowerCase()));
  for (const S of RESERVED_GROUP_SLUGS) Lower.add(S);
  if (!Lower.has(Root.toLowerCase())) return Root;
  for (let N = 2; N < 100000; N++) {
    const Suffix = `-${N}`;
    const Candidate = `${Root.slice(0, MAX_SLUG_LENGTH - Suffix.length)}${Suffix}`;
    if (!Lower.has(Candidate.toLowerCase())) return Candidate;
  }
  return `${Root.slice(0, 40)}-${Date.now()}`;
}

/**
 * Why a slug an operator typed cannot be used, or null when it can. `Taken`
 * holds every other group's slug.
 */
export function SlugProblem(Value: unknown, Taken: Iterable<string>): string | null {
  const Slug = String(Value ?? '').trim();
  if (!Slug) return 'A slug is required';
  if (!IsValidSlug(Slug)) {
    return 'A slug may only use letters, numbers, "-" and "_" (up to 64 characters)';
  }
  if (IsReservedSlug(Slug)) return `"${Slug}" is reserved for the Default group`;
  const Lower = Slug.toLowerCase();
  for (const Other of Taken) {
    if (Other.toLowerCase() === Lower) return 'Another group already uses that slug';
  }
  return null;
}

// --- Layout -------------------------------------------------------------------

/** The column count from a settings value, clamped to a grid that works. */
export function ParseGroupColumnCount(Value: unknown): number {
  const Count = parseInt(String(Value ?? ''), 10);
  if (!Number.isFinite(Count)) return DEFAULT_GROUP_COLUMN_COUNT;
  return Math.min(MAX_GROUP_COLUMN_COUNT, Math.max(MIN_GROUP_COLUMN_COUNT, Count));
}

/**
 * How many grid columns a group spans: every column at full width, otherwise
 * its ColumnSpan clamped to the columns there are (the stored span is kept, so
 * raising the count again restores it).
 */
export function GetGroupSpan(
  Group: Pick<GroupView, 'isFullWidth' | 'ColumnSpan'> | null | undefined,
  ColumnCount: number
): number {
  if (!Group || Group.isFullWidth !== false) return ColumnCount;
  return Math.min(NormalizeColumnSpan(Group.ColumnSpan), ColumnCount);
}

/** The group editor's Width value: 'full', or the stored span. */
export function GetGroupWidthValue(
  Group: Pick<GroupView, 'isFullWidth' | 'ColumnSpan'> | null | undefined
): string {
  if (!Group || Group.isFullWidth !== false) return 'full';
  return String(NormalizeColumnSpan(Group.ColumnSpan));
}

/**
 * The Width select's options: Full Width, then one per column. A stored span
 * wider than the grid (the count was lowered later) stays listed, labelled with
 * the width it is drawn at.
 */
export function BuildGroupWidthOptions(
  Group: Pick<GroupView, 'isFullWidth' | 'ColumnSpan'> | null | undefined,
  ColumnCount: number
): Array<{ Value: string; Label: string }> {
  const Options = [{ Value: 'full', Label: 'Full Width' }];
  for (let Span = 1; Span <= ColumnCount; Span++) {
    Options.push({ Value: String(Span), Label: `${Span} Column${Span === 1 ? '' : 's'}` });
  }
  const Current = GetGroupWidthValue(Group);
  if (Current !== 'full' && Number(Current) > ColumnCount) {
    Options.push({ Value: Current, Label: `${Current} Columns (shown as ${ColumnCount})` });
  }
  return Options;
}

/** The hex a group's box is tinted with, or null for none. */
export function GroupTintHex(Group: Pick<GroupView, 'Colour'> | null | undefined): string | null {
  const Index = Group ? Group.Colour : null;
  if (typeof Index !== 'number' || !Number.isInteger(Index)) return null;
  return GROUP_COLOURS[Index]?.hex ?? null;
}

/** "KB 1" / "NP 1" for a keybind, as the group list badges it; '' for none. */
export function FormatKeyBindLabel(KeyBind: string | null | undefined): string {
  const Match = String(KeyBind || '').match(/^(Digit|Numpad)([0-9])$/);
  if (!Match) return '';
  return `${Match[1] === 'Numpad' ? 'NP' : 'KB'} ${Match[2]}`;
}

/** "1 (Keyboard)" / "1 (Numpad)" for the keybind select. */
export function DescribeKeyBind(KeyBind: string): string {
  const Match = KeyBind.match(/^(Digit|Numpad)([0-9])$/);
  if (!Match) return KeyBind;
  return `${Match[2]} (${Match[1] === 'Numpad' ? 'Numpad' : 'Keyboard'})`;
}

/** A group's display title ('Default' for the Default group). */
export function GroupTitle(Group: Pick<GroupView, 'Title'> | null | undefined): string {
  return Group ? Group.Title || 'Group' : DEFAULT_GROUP_TITLE;
}

/** Shorten a title for the vertical group rail. */
export function TruncateGroupLabel(Value: string, MaxLen = 16): string {
  const Text = Value == null ? '' : String(Value).trim();
  if (Text.length <= MaxLen) return Text;
  return `${Text.substring(0, Math.max(1, MaxLen - 3)).trimEnd()}...`;
}

/** Groups in display order (by weight, then ID). */
export function SortGroups<T extends Pick<GroupView, 'GroupID' | 'Weight'>>(
  Groups: readonly T[]
): T[] {
  return [...Groups].sort((A, B) => A.Weight - B.Weight || A.GroupID - B.GroupID);
}

/**
 * The GroupID a timer is shown under: its own when that group exists, else
 * null (the Default group). A timer whose group was deleted elsewhere (an older
 * show file, a failed write) never disappears from view.
 */
export function EffectiveGroupID(
  GroupID: number | null | undefined,
  KnownGroupIDs: ReadonlySet<number>
): number | null {
  return typeof GroupID === 'number' && KnownGroupIDs.has(GroupID) ? GroupID : null;
}
