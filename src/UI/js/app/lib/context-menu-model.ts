// What the right-click menu offers, as data: rows with an action ID rather than
// a callback, so the rules are tested without a DOM
// (test/renderer-context-menu-model.test.js). context-menu.ts draws the rows
// and runs the actions. The row shapes are ShowTrak Server's.
import type { TimerView } from '../../../../common/timers';
import {
  DEFAULT_GROUP_TITLE,
  EffectiveGroupID,
  GroupTintHex,
  type GroupView,
} from '../../../../common/groups';
import type { AppMode } from '../../../../common/api';
import { SHORTCUT_KEYS } from './shortcuts';

export type ContextMenuActionID =
  | 'SELECTION_START'
  | 'SELECTION_PAUSE'
  | 'SELECTION_RESUME'
  | 'SELECTION_STOP'
  | 'SELECTION_EDIT'
  | 'SELECTION_DELETE'
  | 'SELECTION_MOVE'
  | 'SELECT_ALL'
  | 'CLEAR_SELECTION'
  | 'ALL_START'
  | 'ALL_PAUSE'
  | 'ALL_RESUME'
  | 'ALL_STOP'
  | 'NEW_TIMER'
  | 'NEW_GROUP'
  | 'EDIT_GROUP'
  | 'MANAGE_GROUPS';

export interface ContextMenuRow {
  Type: 'Action' | 'Header' | 'Info' | 'Divider';
  Title?: string;
  Shortcut?: string;
  Icon?: string;
  IconColour?: string;
  Class?: string;
  Action?: ContextMenuActionID;
  /** For SELECTION_MOVE: the group to move to (null: the Default group). For EDIT_GROUP: the group. */
  GroupID?: number | null;
  /** Shown, but nothing to do (no selected timer it applies to). */
  Disabled?: boolean;
  /** Runs on the selected timers, so it may clear the selection afterwards. */
  ActsOnSelection?: boolean;
}

export interface ContextMenuInput {
  /** The selected timers, in display order. */
  Selected: readonly TimerView[];
  TimerCount: number;
  Mode: AppMode;
  Groups: readonly Pick<GroupView, 'GroupID' | 'Title' | 'Colour'>[];
  /** The group whose rail was right-clicked, if it was one (null: the Default group). */
  RailGroupID?: number | null;
}

const CanStart = (T: TimerView) => T.Status === 'STANDBY' || T.Status === 'COMPLETE';
const IsTicking = (T: TimerView) => T.Status === 'RUNNING' || T.Status === 'OVERRUN';

/** Whether a selection action has anything to do for these timers. */
export function SelectionActionApplies(
  Action: 'Start' | 'Pause' | 'Unpause' | 'Stop',
  Timers: readonly TimerView[]
): boolean {
  switch (Action) {
    case 'Start':
      return Timers.some(CanStart);
    case 'Pause':
      return Timers.some(IsTicking);
    case 'Unpause':
      return Timers.some((T) => T.Status === 'PAUSED');
    case 'Stop':
      return Timers.some((T) => T.Status !== 'STANDBY');
  }
  return false;
}

export function BuildContextMenuRows(Input: ContextMenuInput): ContextMenuRow[] {
  const { Selected, Mode, Groups } = Input;
  const Editing = Mode === 'EDIT';
  const Rows: ContextMenuRow[] = [];
  const Divider = () => {
    if (Rows.length && Rows[Rows.length - 1]!.Type !== 'Divider') Rows.push({ Type: 'Divider' });
  };

  if (Selected.length) {
    Rows.push({
      Type: 'Header',
      Title: Selected.length === 1 ? Selected[0]!.Name : `${Selected.length} Timers Selected`,
    });
    const Transport: Array<
      [ContextMenuActionID, 'Start' | 'Pause' | 'Unpause' | 'Stop', string, string, string]
    > = [
      ['SELECTION_START', 'Start', 'Start', 'bi-play-fill', SHORTCUT_KEYS.Start],
      ['SELECTION_PAUSE', 'Pause', 'Pause', 'bi-pause-fill', SHORTCUT_KEYS.Pause],
      ['SELECTION_RESUME', 'Unpause', 'Resume', 'bi-play-fill', SHORTCUT_KEYS.Resume],
      ['SELECTION_STOP', 'Stop', 'Stop', 'bi-stop-fill', SHORTCUT_KEYS.Stop],
    ];
    for (const [Action, Control, Title, Icon, Shortcut] of Transport) {
      Rows.push({
        Type: 'Action',
        Action,
        Title,
        Icon,
        Shortcut,
        Disabled: !SelectionActionApplies(Control, Selected),
        ActsOnSelection: true,
      });
    }

    if (Editing) {
      Divider();
      if (Selected.length === 1) {
        Rows.push({
          Type: 'Action',
          Action: 'SELECTION_EDIT',
          Title: 'Edit Timer',
          Icon: 'bi-gear-fill',
        });
      }
      Rows.push({ Type: 'Header', Title: 'Move to Group' });
      const Known = new Set(Groups.map((G) => G.GroupID));
      const Current = new Set(Selected.map((T) => EffectiveGroupID(T.GroupID, Known)));
      const Targets: Array<{ GroupID: number | null; Title: string; Colour: number | null }> = [
        ...Groups.map((G) => ({ GroupID: G.GroupID, Title: G.Title, Colour: G.Colour })),
        { GroupID: null, Title: DEFAULT_GROUP_TITLE, Colour: null },
      ];
      for (const Target of Targets) {
        Rows.push({
          Type: 'Action',
          Action: 'SELECTION_MOVE',
          GroupID: Target.GroupID,
          Title: Target.Title,
          Icon: 'bi-folder-fill',
          IconColour: GroupTintHex(Target) ?? undefined,
          // Already all there: nothing to move.
          Disabled: Current.size === 1 && Current.has(Target.GroupID),
          ActsOnSelection: true,
        });
      }
      Divider();
      Rows.push({
        Type: 'Action',
        Action: 'SELECTION_DELETE',
        Title: Selected.length === 1 ? 'Delete Timer' : `Delete ${Selected.length} Timers`,
        Icon: 'bi-trash-fill',
        Class: 'text-danger',
        ActsOnSelection: true,
      });
    }
  } else {
    Rows.push({ Type: 'Info', Title: 'No Timers Selected' });
    Divider();
    Rows.push({ Type: 'Header', Title: 'All Timers' });
    const None = Input.TimerCount === 0;
    Rows.push({
      Type: 'Action',
      Action: 'ALL_START',
      Title: 'Start All Timers',
      Icon: 'bi-play-fill',
      Disabled: None,
    });
    Rows.push({
      Type: 'Action',
      Action: 'ALL_PAUSE',
      Title: 'Pause All Timers',
      Icon: 'bi-pause-fill',
      Shortcut: SHORTCUT_KEYS.PauseAll,
      Disabled: None,
    });
    Rows.push({
      Type: 'Action',
      Action: 'ALL_RESUME',
      Title: 'Resume All Timers',
      Icon: 'bi-play-fill',
      Shortcut: SHORTCUT_KEYS.ResumeAll,
      Disabled: None,
    });
    Rows.push({
      Type: 'Action',
      Action: 'ALL_STOP',
      Title: 'Stop All Timers',
      Icon: 'bi-stop-fill',
      Disabled: None,
    });
    if (Editing) {
      Divider();
      // Off a rail; a rail offers its own "New Timer in" below.
      if (Input.RailGroupID === undefined) {
        Rows.push({
          Type: 'Action',
          Action: 'NEW_TIMER',
          Title: 'New Timer',
          Icon: 'bi-plus-lg',
          Shortcut: SHORTCUT_KEYS.NewTimer,
        });
      }
      Rows.push({
        Type: 'Action',
        Action: 'NEW_GROUP',
        Title: 'New Group',
        Icon: 'bi-folder-plus',
      });
    }
  }

  // A group's rail: a new timer goes straight into that group, and a real
  // group can be edited from here.
  if (Editing && Input.RailGroupID !== undefined) {
    const RailGroupID = Input.RailGroupID;
    const Title =
      RailGroupID === null
        ? DEFAULT_GROUP_TITLE
        : (Groups.find((G) => G.GroupID === RailGroupID)?.Title ?? 'Group');
    Divider();
    Rows.push({
      Type: 'Action',
      Action: 'NEW_TIMER',
      GroupID: RailGroupID,
      Title: `New Timer in ${Title}`,
      Icon: 'bi-plus-lg',
    });
    if (typeof RailGroupID === 'number') {
      Rows.push({
        Type: 'Action',
        Action: 'EDIT_GROUP',
        GroupID: RailGroupID,
        Title: 'Edit Group',
        Icon: 'bi-pencil-fill',
      });
    }
  }
  if (Editing) {
    Divider();
    Rows.push({
      Type: 'Action',
      Action: 'MANAGE_GROUPS',
      Title: 'Manage Groups',
      Icon: 'bi-folder-fill',
      Shortcut: SHORTCUT_KEYS.Groups,
    });
  }

  Divider();
  if (Input.TimerCount > 0) {
    Rows.push({
      Type: 'Action',
      Action: 'SELECT_ALL',
      Title: 'Select All',
      Icon: 'bi-check2-all',
      Shortcut: SHORTCUT_KEYS.SelectAll,
    });
  }
  if (Selected.length) {
    Rows.push({
      Type: 'Action',
      Action: 'CLEAR_SELECTION',
      Title: 'Clear Selection',
      Icon: 'bi-x-lg',
      Shortcut: SHORTCUT_KEYS.ClearSelection,
    });
  }
  while (Rows.length && Rows[Rows.length - 1]!.Type === 'Divider') Rows.pop();
  return Rows;
}
