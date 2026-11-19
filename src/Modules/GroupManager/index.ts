// GroupManager: the show's groups, as in ShowTrak Server.
//
// Groups live in the `Groups` table of the show database and are held in memory
// once loaded. Every change is announced on the broadcast bus as
// 'GroupsUpdated' with the full list. Which group a timer is in belongs to the
// timer (Timers.GroupID, see TimerManager); deleting a group is coordinated by
// the caller, which first moves its timers to the Default group.
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as AppDb, type Database } from '../DB';
import {
  DEFAULT_GROUP_SLUG,
  NormalizeColour,
  NormalizeColumnSpan,
  NormalizeFullWidth,
  NormalizeGroupTitle,
  NormalizeKeyBind,
  SlugProblem,
  SortGroups,
  UniqueSlug,
  type GroupView,
} from '../../common/groups';

const Logger = CreateLogger('Groups');

export type Result<T> = [string | null, T | null];

interface GroupRow {
  GroupID: number;
  Title: string | null;
  Weight: number | null;
  FullWidth: number | null;
  ColumnSpan: number | null;
  Colour: number | null;
  KeyBind: string | null;
  Slug: string | null;
}

/** Fields a create or update may set; anything absent is left as it is. */
export interface GroupPatch {
  Title?: unknown;
  Slug?: unknown;
  /** 'full', or a number of columns. */
  Width?: unknown;
  Colour?: unknown;
  KeyBind?: unknown;
}

export interface GroupManagerOptions {
  Db?: Database;
  Broadcast?: { emit(Event: string, ...Args: unknown[]): unknown };
}

function FromRow(Row: GroupRow): GroupView {
  return {
    GroupID: Number(Row.GroupID),
    Title: NormalizeGroupTitle(Row.Title) || 'Group',
    Slug: Row.Slug ? String(Row.Slug) : '',
    Weight: Number.isFinite(Number(Row.Weight)) ? Number(Row.Weight) : 0,
    isFullWidth: NormalizeFullWidth(Row.FullWidth),
    ColumnSpan: NormalizeColumnSpan(Row.ColumnSpan),
    Colour: NormalizeColour(Row.Colour),
    KeyBind: NormalizeKeyBind(Row.KeyBind),
  };
}

export function CreateGroupManager(Options: GroupManagerOptions = {}) {
  const Db = Options.Db ?? AppDb;
  const Broadcast = Options.Broadcast ?? BroadcastManager;

  let Groups: GroupView[] = [];
  let Loaded = false;
  let Loading: Promise<void> | null = null;

  const Copy = (G: GroupView): GroupView => ({ ...G });
  const Find = (ID: unknown) => {
    const Num = Number(ID);
    return Number.isInteger(Num) ? Groups.find((G) => G.GroupID === Num) : undefined;
  };

  function Announce(): void {
    Broadcast.emit('GroupsUpdated', Manager.List());
  }

  // A group without a slug (none should exist, but a hand-edited or damaged
  // file could have one) gets one from its title, so it can always be addressed.
  async function BackfillSlugs(): Promise<void> {
    for (const Group of Groups) {
      if (Group.Slug && !SlugProblem(Group.Slug, Others(Group.GroupID))) continue;
      const Slug = UniqueSlug(Group.Title, Others(Group.GroupID));
      const [Err] = await Db.Run(
        'UPDATE `Groups` SET Slug = ? WHERE GroupID = ?',
        [Slug, Group.GroupID],
        {
          MarkDirty: false,
        }
      );
      if (Err) {
        Logger.warn(`Failed to give group ${Group.GroupID} a slug`, Err);
        continue;
      }
      Group.Slug = Slug;
    }
  }

  function Others(ExceptID: number | null): string[] {
    return Groups.filter((G) => G.GroupID !== ExceptID && G.Slug).map((G) => G.Slug);
  }

  async function Load(): Promise<void> {
    if (Loaded) return;
    if (Loading) return Loading;
    Loading = (async () => {
      const [Err, Rows] = await Db.All<GroupRow>('SELECT * FROM `Groups`');
      if (Err) throw Err;
      Groups = SortGroups((Rows || []).map(FromRow));
      await BackfillSlugs();
      Loaded = true;
    })();
    try {
      await Loading;
    } finally {
      Loading = null;
    }
  }

  // Validate a patch against the current groups. Returns the columns to write,
  // or the reason it cannot be applied.
  function Resolve(
    Current: GroupView,
    Patch: GroupPatch
  ): [string | null, Partial<Record<keyof GroupRow, unknown>> | null, GroupView | null] {
    const Next: GroupView = { ...Current };
    const Columns: Partial<Record<keyof GroupRow, unknown>> = {};
    if (Patch.Title !== undefined) {
      const Title = NormalizeGroupTitle(Patch.Title);
      if (!Title) return ['A group name is required', null, null];
      Next.Title = Title;
      Columns.Title = Title;
    }
    if (Patch.Slug !== undefined) {
      const Slug = String(Patch.Slug ?? '').trim();
      if (Slug !== Current.Slug) {
        const Problem = SlugProblem(Slug, Others(Current.GroupID));
        if (Problem) return [Problem, null, null];
        Next.Slug = Slug;
        Columns.Slug = Slug;
      }
    }
    if (Patch.Width !== undefined) {
      const Full = String(Patch.Width).toLowerCase() === 'full';
      if (!Full) {
        const Span = Math.trunc(Number(Patch.Width));
        if (!Number.isFinite(Span) || Span < 1) return ['Invalid group width', null, null];
        Next.ColumnSpan = NormalizeColumnSpan(Span);
        Columns.ColumnSpan = Next.ColumnSpan;
      }
      Next.isFullWidth = Full;
      Columns.FullWidth = Full ? 1 : 0;
    }
    if (Patch.Colour !== undefined) {
      Next.Colour = NormalizeColour(Patch.Colour);
      Columns.Colour = Next.Colour;
    }
    if (Patch.KeyBind !== undefined) {
      const KeyBind = NormalizeKeyBind(Patch.KeyBind);
      if (Patch.KeyBind !== null && Patch.KeyBind !== '' && KeyBind === null) {
        return ['That key cannot be a selection keybind', null, null];
      }
      if (KeyBind && Groups.some((G) => G.GroupID !== Current.GroupID && G.KeyBind === KeyBind)) {
        return ['That keybind is already assigned to another group', null, null];
      }
      Next.KeyBind = KeyBind;
      Columns.KeyBind = KeyBind;
    }
    return [null, Columns, Next];
  }

  const Manager = {
    async Init(): Promise<void> {
      await Load();
      Announce();
    },

    /** The groups in display order, as last loaded (empty before Init). */
    List(): GroupView[] {
      return Groups.map(Copy);
    },

    async GetAll(): Promise<GroupView[]> {
      await Load();
      return Manager.List();
    },

    async Get(ID: unknown): Promise<GroupView | null> {
      await Load();
      const G = Find(ID);
      return G ? Copy(G) : null;
    },

    async Has(ID: unknown): Promise<boolean> {
      await Load();
      return !!Find(ID);
    },

    /** The group with this slug (any case); null for none or the Default group's. */
    async GetBySlug(Slug: unknown): Promise<GroupView | null> {
      await Load();
      const Lower = String(Slug ?? '').toLowerCase();
      if (!Lower || Lower === DEFAULT_GROUP_SLUG.toLowerCase()) return null;
      const G = Groups.find((Group) => Group.Slug.toLowerCase() === Lower);
      return G ? Copy(G) : null;
    },

    async Create(Patch: GroupPatch = {}): Promise<Result<GroupView>> {
      await Load();
      const Title = NormalizeGroupTitle(Patch.Title ?? 'New Group') || 'New Group';
      const Weight = Groups.reduce((Max, G) => Math.max(Max, G.Weight), 0) + 10;
      const Slug =
        Patch.Slug !== undefined && String(Patch.Slug).trim()
          ? String(Patch.Slug).trim()
          : UniqueSlug(Title, Others(null));
      const Problem = SlugProblem(Slug, Others(null));
      if (Problem) return [Problem, null];
      const Draft: GroupView = {
        GroupID: 0,
        Title,
        Slug,
        Weight,
        isFullWidth: true,
        ColumnSpan: 1,
        Colour: null,
        KeyBind: null,
      };
      const [PatchErr, , Next] = Resolve(Draft, { ...Patch, Title, Slug: undefined });
      if (PatchErr || !Next) return [PatchErr, null];
      const [Err, Res] = await Db.Run(
        'INSERT INTO `Groups` (Title, Weight, FullWidth, ColumnSpan, Colour, KeyBind, Slug) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          Next.Title,
          Next.Weight,
          Next.isFullWidth ? 1 : 0,
          Next.ColumnSpan,
          Next.Colour,
          Next.KeyBind,
          Next.Slug,
        ]
      );
      if (Err || !Res) return [Err?.message || 'Failed to create the group', null];
      Next.GroupID = Res.lastID;
      Groups = SortGroups([...Groups, Next]);
      Logger.log(`Group ${Next.GroupID} created (${Next.Title})`);
      Announce();
      return [null, Copy(Next)];
    },

    async Update(ID: unknown, Patch: GroupPatch): Promise<Result<GroupView>> {
      await Load();
      const Current = Find(ID);
      if (!Current) return ['Group not found', null];
      const [Problem, Columns, Next] = Resolve(Current, Patch || {});
      if (Problem || !Columns || !Next) return [Problem, null];
      const Keys = Object.keys(Columns);
      if (Keys.length) {
        const [Err] = await Db.Run(
          `UPDATE \`Groups\` SET ${Keys.map((K) => `${K} = ?`).join(', ')} WHERE GroupID = ?`,
          [...Keys.map((K) => Columns[K as keyof GroupRow]), Current.GroupID]
        );
        if (Err) return [Err.message || 'Failed to save the group', null];
        Object.assign(Current, Next);
        Announce();
      }
      return [null, Copy(Current)];
    },

    /** Delete a group. Its timers must already have been moved out (TimerManager.ClearGroup). */
    async Delete(ID: unknown): Promise<Result<true>> {
      await Load();
      const Current = Find(ID);
      if (!Current) return ['Group not found', null];
      const [Err] = await Db.Run('DELETE FROM `Groups` WHERE GroupID = ?', [Current.GroupID]);
      if (Err) return [Err.message, null];
      Groups = Groups.filter((G) => G !== Current);
      Logger.log(`Group ${Current.GroupID} deleted`);
      Announce();
      return [null, true];
    },

    /** Put the groups in this order (IDs not listed keep their place after). */
    async Reorder(IDs: unknown): Promise<Result<true>> {
      await Load();
      if (!Array.isArray(IDs)) return ['Invalid order', null];
      const Wanted = [...new Set(IDs.map(Number))].filter((ID) => Find(ID));
      const Order = [
        ...Wanted,
        ...Groups.map((G) => G.GroupID).filter((ID) => !Wanted.includes(ID)),
      ];
      for (let Index = 0; Index < Order.length; Index++) {
        const G = Find(Order[Index])!;
        const Weight = (Index + 1) * 10;
        if (G.Weight === Weight) continue;
        const [Err] = await Db.Run('UPDATE `Groups` SET Weight = ? WHERE GroupID = ?', [
          Weight,
          G.GroupID,
        ]);
        if (Err) return [Err.message, null];
        G.Weight = Weight;
      }
      Groups = SortGroups(Groups);
      Announce();
      return [null, true];
    },

    /** Drop what is held in memory and load the groups again (a show swap). */
    async Reload(): Promise<void> {
      if (Loading) await Loading.catch(() => {});
      Loaded = false;
      Groups = [];
      await Load();
      Announce();
    },
  };

  return Manager;
}

export type GroupManager = ReturnType<typeof CreateGroupManager>;

export const Manager: GroupManager = CreateGroupManager();
