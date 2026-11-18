// IPC: timers (list, edit, order, run control).
import { RPC } from '../rpc';
import { Manager as TimerManager } from '../../Modules/TimerManager';
import { Action, Direction, Guard, IDList, PlainObject, TimerID } from './validate';

export function register(): void {
  RPC.handle('Timers:List', async () => TimerManager.GetAll());

  RPC.handle('Timer:Get', (_E, ID) =>
    Guard(async () => {
      const Timer = await TimerManager.Get(TimerID(ID));
      return Timer ? [null, Timer] : ['Timer not found', null];
    })
  );

  RPC.handle('Timer:Create', (_E, Patch) =>
    Guard(() => TimerManager.Create(PlainObject(Patch, 'timer')))
  );

  RPC.handle('Timer:Update', (_E, ID, Patch) =>
    Guard(() => TimerManager.Update(TimerID(ID), PlainObject(Patch, 'timer')))
  );

  RPC.handle('Timer:Delete', (_E, ID) => Guard(() => TimerManager.Delete(TimerID(ID))));

  RPC.handle('Timer:Move', (_E, ID, Dir) =>
    Guard(() => TimerManager.Move(TimerID(ID), Direction(Dir)))
  );

  RPC.handle('Timers:Reorder', (_E, IDs) => Guard(() => TimerManager.Reorder(IDList(IDs))));

  RPC.handle('Timer:Control', (_E, ID, Act) =>
    Guard(() => TimerManager.Control(TimerID(ID), Action(Act)))
  );

  RPC.handle('Timer:JumpTo', (_E, ID, Ms) =>
    Guard(() => TimerManager.JumpTo(TimerID(ID), Number(Ms)))
  );

  RPC.handle('Timers:ControlAll', (_E, Act) =>
    Guard(async () => [null, await TimerManager.ControlAll(Action(Act))])
  );
}
