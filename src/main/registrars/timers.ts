// IPC: timers (list, edit, order, run control).
import { RPC } from '../rpc';
import { Manager as TimerManager } from '../../Modules/TimerManager';
import { Action, Guard, GroupRef, PlainObject, TimerID, TimerIDs } from './validate';
import { GroupRefProblem } from './groups';

// A patch's GroupID, when it has one, must name a group that exists.
async function CheckedPatch(Patch: unknown): Promise<[string | null, Record<string, unknown>]> {
  const Value = PlainObject(Patch, 'timer');
  if (Value.GroupID !== undefined) {
    const Problem = await GroupRefProblem(GroupRef(Value.GroupID));
    if (Problem) return [Problem, Value];
  }
  return [null, Value];
}

export function register(): void {
  RPC.handle('Timers:List', async () => TimerManager.GetAll());

  RPC.handle('Timer:Get', (_E, ID) =>
    Guard(async () => {
      const Timer = await TimerManager.Get(TimerID(ID));
      return Timer ? [null, Timer] : ['Timer not found', null];
    })
  );

  RPC.handle('Timer:Create', (_E, Patch) =>
    Guard(async () => {
      const [Problem, Value] = await CheckedPatch(Patch);
      return Problem ? [Problem, null] : TimerManager.Create(Value);
    })
  );

  RPC.handle('Timer:Update', (_E, ID, Patch) =>
    Guard(async () => {
      const Target = TimerID(ID);
      const [Problem, Value] = await CheckedPatch(Patch);
      return Problem ? [Problem, null] : TimerManager.Update(Target, Value);
    })
  );

  RPC.handle('Timers:DeleteMany', (_E, IDs) =>
    Guard(async () => {
      let Count = 0;
      for (const ID of TimerIDs(IDs)) {
        const [Err] = await TimerManager.Delete(ID);
        if (Err && Err !== 'Timer not found') return [Err, null];
        if (!Err) Count++;
      }
      return [null, Count];
    })
  );

  RPC.handle('Timer:Delete', (_E, ID) => Guard(() => TimerManager.Delete(TimerID(ID))));

  RPC.handle('Timer:Control', (_E, ID, Act) =>
    Guard(() => TimerManager.Control(TimerID(ID), Action(Act)))
  );

  RPC.handle('Timer:JumpTo', (_E, ID, Ms) =>
    Guard(() => TimerManager.JumpTo(TimerID(ID), Number(Ms)))
  );

  RPC.handle('Timers:ControlAll', (_E, Act) =>
    Guard(async () => [null, await TimerManager.ControlAll(Action(Act))])
  );

  // A selection: Start begins only the timers that are not already going.
  RPC.handle('Timers:ControlMany', (_E, IDs, Act) =>
    Guard(async () => [null, await TimerManager.ControlMany(TimerIDs(IDs), Action(Act))])
  );
}
