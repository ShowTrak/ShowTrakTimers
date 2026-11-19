// How timers are laid out in their groups, as data: shared by the desktop grid
// and the Web Dashboard, and tested without a DOM
// (test/renderer-group-layout.test.js).
//
// As in ShowTrak Server: groups in their order, the Default group last. A real
// group is drawn even when empty (so timers can be dropped into it); the
// Default group only when something is in it.
import {
  DEFAULT_GROUP_TITLE,
  EffectiveGroupID,
  SortGroups,
  type GroupView,
} from '../../../../common/groups';

export type GroupLike = Pick<GroupView, 'GroupID' | 'Title' | 'Weight' | 'Colour'> &
  Partial<Pick<GroupView, 'Slug' | 'isFullWidth' | 'ColumnSpan' | 'KeyBind'>>;

export interface GroupSection<T> {
  /** null for the Default group. */
  GroupID: number | null;
  Title: string;
  Group: GroupLike | null;
  Timers: T[];
}

export interface SectionOptions {
  /** Keep real groups that have no timers (the desktop grid does; the dashboard does not). */
  IncludeEmptyGroups?: boolean;
}

/** Split timers (already in display order) into their groups' sections. */
export function BuildGroupSections<T extends { GroupID?: number | null }>(
  Groups: readonly GroupLike[],
  Timers: readonly T[],
  { IncludeEmptyGroups = true }: SectionOptions = {}
): GroupSection<T>[] {
  const Ordered = SortGroups(Groups);
  const Known = new Set(Ordered.map((G) => G.GroupID));
  const ByGroup = new Map<number | null, T[]>();
  for (const Timer of Timers) {
    const ID = EffectiveGroupID(Timer.GroupID ?? null, Known);
    const List = ByGroup.get(ID);
    if (List) List.push(Timer);
    else ByGroup.set(ID, [Timer]);
  }
  const Sections: GroupSection<T>[] = [];
  for (const Group of Ordered) {
    const Members = ByGroup.get(Group.GroupID) ?? [];
    if (!Members.length && !IncludeEmptyGroups) continue;
    Sections.push({ GroupID: Group.GroupID, Title: Group.Title, Group, Timers: Members });
  }
  const Defaults = ByGroup.get(null) ?? [];
  if (Defaults.length) {
    Sections.push({ GroupID: null, Title: DEFAULT_GROUP_TITLE, Group: null, Timers: Defaults });
  }
  return Sections;
}

/** The timer IDs in a group (null: the Default group), in display order. */
export function TimerIDsInGroup<T extends { ID: number; GroupID?: number | null }>(
  Groups: readonly Pick<GroupView, 'GroupID'>[],
  Timers: readonly T[],
  GroupID: number | null
): number[] {
  const Known = new Set(Groups.map((G) => G.GroupID));
  return Timers.filter((T) => EffectiveGroupID(T.GroupID ?? null, Known) === GroupID).map(
    (T) => T.ID
  );
}

/** A key that changes whenever the sections' structure (not the timers' state) does. */
export function SectionsKey<T extends { ID: number }>(
  Sections: readonly GroupSection<T>[]
): string {
  return Sections.map(
    (S) =>
      `${S.GroupID ?? 'd'}:${S.Title}:${S.Group?.Colour ?? ''}:${S.Group?.isFullWidth ?? ''}:${
        S.Group?.ColumnSpan ?? ''
      }:${S.Timers.map((T) => T.ID).join(',')}`
  ).join('|');
}
