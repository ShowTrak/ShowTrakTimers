// IPC: groups (list, edit, order, delete), and putting timers into them.
import { RPC } from '../rpc';
import { Manager as GroupManager } from '../../Modules/GroupManager';
import { Manager as TimerManager } from '../../Modules/TimerManager';
import {
  Guard,
  GroupID,
  GroupIDList,
  GroupRef,
  PlainObject,
  Placements,
  TimerIDs,
} from './validate';

/** Why a group reference cannot be used, or null when it can (null is the Default group). */
export async function GroupRefProblem(ID: number | null): Promise<string | null> {
  if (ID === null) return null;
  return (await GroupManager.Has(ID)) ? null : 'Group not found';
}

export function register(): void {
  RPC.handle('Groups:List', async () => GroupManager.GetAll());

  RPC.handle('Group:Create', (_E, Patch) =>
    Guard(() => GroupManager.Create(PlainObject(Patch, 'group')))
  );

  RPC.handle('Group:Update', (_E, ID, Patch) =>
    Guard(() => GroupManager.Update(GroupID(ID), PlainObject(Patch, 'group')))
  );

  // Its timers move to the Default group first, so none is left pointing at a
  // group that no longer exists.
  RPC.handle('Group:Delete', (_E, ID) =>
    Guard(async () => {
      const Target = GroupID(ID);
      if (!(await GroupManager.Has(Target))) return ['Group not found', null];
      const [MoveErr] = await TimerManager.ClearGroup(Target);
      if (MoveErr) return [MoveErr, null];
      return GroupManager.Delete(Target);
    })
  );

  RPC.handle('Groups:Reorder', (_E, IDs) => Guard(() => GroupManager.Reorder(GroupIDList(IDs))));

  RPC.handle('Timers:MoveToGroup', (_E, IDs, Group) =>
    Guard(async () => {
      const Target = GroupRef(Group);
      const Problem = await GroupRefProblem(Target);
      if (Problem) return [Problem, null];
      return TimerManager.MoveToGroup(TimerIDs(IDs), Target);
    })
  );

  RPC.handle('Timers:Arrange', (_E, Layout) =>
    Guard(async () => {
      const Entries = Placements(Layout);
      for (const Group of new Set(Entries.map((E) => E.GroupID))) {
        const Problem = await GroupRefProblem(Group);
        if (Problem) return [Problem, null];
      }
      return TimerManager.Arrange(Entries);
    })
  );
}
