// The timer grid: one tile per timer, its run controls, the local animation
// loop, drag-to-reorder in EDIT mode, and what happens on a timer's warning or
// completion (sound, notification).
import { Anchor, ElapsedAt, PaintInterval, type AnchoredTimer } from './lib/anchor';
import {
  BuildTileModel,
  DescribeTimerEvent,
  SummariseTimers,
  type TileModel,
} from './lib/timer-tile';
import type { TimerView } from '../../../common/timers';
import { Mode, Services } from './state';
import { Notify } from './lib/toasts';
import { HandleNonFatalError } from './utils';
import { PlaySoundRef } from './sounds';
import { OpenTimerEditor } from './timer-editor';
import { OnModeChange } from './mode';
import { CanCreateTimer } from './lib/timer-editor-model';
import type { ControlAction, TimerEventView } from '../../../common/api';

let Anchored: AnchoredTimer<TimerView>[] = [];
let RenderedOrder = '';
let FrameRequested = false;
let LastPaint = 0;

const Now = () => performance.now();

export function CurrentTimers(): TimerView[] {
  return Anchored.map((A) => A.Timer);
}

function TileHtml(Timer: TimerView): string {
  return `<div class="SHOWTRAK_TIMER" id="TIMER_${Timer.ID}" data-timer-id="${Timer.ID}" draggable="false">
    <div class="timer-tile-head">
      <span class="timer-tile-status" data-role="status"></span>
      <span class="timer-tile-id" title="Timer ID (for OSC)">#${Timer.ID}</span>
    </div>
    <div class="timer-tile-name" data-role="name"></div>
    <div class="timer-tile-readout">
      <span class="timer-tile-primary" data-role="primary"></span>
      <span class="timer-tile-secondary" data-role="secondary"></span>
    </div>
    <div class="progress timer-tile-progress" data-role="progress">
      <div class="progress-bar bg-white" role="progressbar"></div>
    </div>
    <div class="timer-tile-controls" role="group" aria-label="Timer controls">
      <button type="button" class="timer-tile-btn" data-action="Start" title="Start" aria-label="Start"><i class="bi bi-play-fill"></i></button>
      <button type="button" class="timer-tile-btn" data-action="Unpause" title="Resume" aria-label="Resume"><i class="bi bi-play-fill"></i></button>
      <button type="button" class="timer-tile-btn" data-action="Pause" title="Pause" aria-label="Pause"><i class="bi bi-pause-fill"></i></button>
      <button type="button" class="timer-tile-btn" data-action="Stop" title="Stop and reset" aria-label="Stop and reset"><i class="bi bi-stop-fill"></i></button>
      <span class="timer-tile-spacer"></span>
      <button type="button" class="timer-tile-btn edit-only" data-action="edit" title="Edit timer" aria-label="Edit timer"><i class="bi bi-gear"></i></button>
    </div>
  </div>`;
}

// Apply a model to a tile, touching only what changed.
function PaintTile(El: HTMLElement, Model: TileModel): void {
  const ClassName = ['SHOWTRAK_TIMER', ...Model.Classes].join(' ');
  if (El.className !== ClassName) El.className = ClassName;
  const Set = (Role: string, Text: string) => {
    const Node = El.querySelector<HTMLElement>(`[data-role="${Role}"]`);
    if (Node && Node.textContent !== Text) Node.textContent = Text;
  };
  Set('name', Model.Name);
  Set('status', Model.StatusText);
  Set('primary', Model.Primary);
  Set('secondary', Model.Secondary ? `/ ${Model.Secondary}` : '');
  const Progress = El.querySelector<HTMLElement>('[data-role="progress"]');
  if (Progress) {
    Progress.classList.toggle('invisible', Model.Progress === null);
    const Bar = Progress.firstElementChild as HTMLElement | null;
    // Scaled rather than resized, as Server's tile bars are: no layout per frame.
    const Scale = `scaleX(${(Model.Progress ?? 0) / 100})`;
    if (Bar && Bar.style.transform !== Scale) Bar.style.transform = Scale;
  }
  for (const Button of El.querySelectorAll<HTMLElement>('[data-action]')) {
    const Action = Button.getAttribute('data-action');
    const Visible =
      Action === 'Start'
        ? Model.Controls.Start
        : Action === 'Unpause'
          ? Model.Controls.Resume
          : Action === 'Pause'
            ? Model.Controls.Pause
            : Action === 'Stop'
              ? Model.Controls.Stop
              : true;
    Button.classList.toggle('d-none', !Visible);
  }
}

function Paint(): void {
  const At = Now();
  LastPaint = At;
  for (const Entry of Anchored) {
    const El = document.getElementById(`TIMER_${Entry.Timer.ID}`);
    if (El) PaintTile(El, BuildTileModel(Entry.Timer, ElapsedAt(Entry, At)));
  }
}

function AnyTicking(): boolean {
  return Anchored.some((A) => A.Timer.Status === 'RUNNING' || A.Timer.Status === 'OVERRUN');
}

function Loop(): void {
  FrameRequested = false;
  if (Now() - LastPaint >= PaintInterval(CurrentTimers())) Paint();
  if (AnyTicking()) RequestFrame();
}

function RequestFrame(): void {
  if (FrameRequested) return;
  FrameRequested = true;
  requestAnimationFrame(Loop);
}

function RenderStructure(): void {
  const $Grid = $('#TIMER_GRID');
  const Timers = CurrentTimers();
  $('#EMPTY_STATE').toggleClass('d-none', Timers.length > 0);
  $Grid.toggleClass('d-none', Timers.length === 0);

  const Wanted = new Set(Timers.map((T) => `TIMER_${T.ID}`));
  $Grid.children('.SHOWTRAK_TIMER').each(function () {
    if (!Wanted.has(this.id)) this.remove();
  });
  for (const Timer of Timers) {
    if (!document.getElementById(`TIMER_${Timer.ID}`)) $Grid.append(TileHtml(Timer));
  }
  const Order = Timers.map((T) => T.ID).join(',');
  if (Order !== RenderedOrder) {
    const Grid = $Grid.get(0);
    if (Grid) {
      for (const Timer of Timers) {
        const El = document.getElementById(`TIMER_${Timer.ID}`);
        if (El) Grid.appendChild(El);
      }
    }
    RenderedOrder = Order;
  }
  ApplyEditMode();
}

function UpdateBottomBar(): void {
  const Clients = Services?.WebDashboard.Clients ?? 0;
  const Summary = SummariseTimers(CurrentTimers());
  $('#BOTTOM_BAR_STATUS').text(
    Clients > 0 ? `${Summary} · ${Clients} Dashboard Viewer${Clients === 1 ? '' : 's'}` : Summary
  );
}

export function ApplyTimers(Timers: TimerView[]): void {
  const At = Now();
  Anchored = (Array.isArray(Timers) ? Timers : []).map((T) => Anchor(T, At));
  RenderStructure();
  Paint();
  UpdateBottomBar();
  if (AnyTicking()) RequestFrame();
}

// --- Controls ---------------------------------------------------------------

export async function ControlTimer(ID: number, Action: ControlAction): Promise<void> {
  try {
    const [Err] = await window.API.ControlTimer(ID, Action);
    if (Err) void Notify(Err, 'error');
  } catch (Err) {
    HandleNonFatalError('Timers:Control', Err);
  }
}

export async function ControlAll(Action: ControlAction): Promise<void> {
  const [Err, Count] = await window.API.ControlAllTimers(Action);
  if (Err) {
    void Notify(Err, 'error');
    return;
  }
  const Verb =
    Action === 'Pause'
      ? 'Paused'
      : Action === 'Unpause'
        ? 'Resumed'
        : Action === 'Stop'
          ? 'Stopped'
          : 'Started';
  void Notify(`${Verb} ${Count} timer${Count === 1 ? '' : 's'}.`, 'info', 1800);
}

export async function CreateTimerAndEdit(): Promise<void> {
  if (!CanCreateTimer(Mode, CurrentTimers().length)) {
    void Notify('Switch to Edit mode to add timers.', 'info', 2500);
    return;
  }
  const [Err, Timer] = await window.API.CreateTimer({ Name: 'New Timer' });
  if (Err || !Timer) {
    void Notify(Err || 'Failed to create the timer.', 'error');
    return;
  }
  await OpenTimerEditor(Timer.ID, { IsNew: true });
}

// --- EDIT mode: drag to reorder ---------------------------------------------

let DraggingID: number | null = null;

function ApplyEditMode(): void {
  const Editing = Mode === 'EDIT';
  $('#TIMER_GRID .SHOWTRAK_TIMER').attr('draggable', Editing ? 'true' : 'false');
}

function WireDragAndDrop(): void {
  const $Grid = $('#TIMER_GRID');
  $Grid.on('dragstart', '.SHOWTRAK_TIMER', function (Event) {
    if (Mode !== 'EDIT') return false;
    DraggingID = Number(this.getAttribute('data-timer-id'));
    this.classList.add('dragging');
    const Transfer = (Event.originalEvent as DragEvent | undefined)?.dataTransfer;
    if (Transfer) {
      Transfer.effectAllowed = 'move';
      Transfer.setData('text/plain', String(DraggingID));
    }
    return undefined;
  });
  $Grid.on('dragover', '.SHOWTRAK_TIMER', function (Event) {
    if (DraggingID === null) return;
    Event.preventDefault();
    const Dragged = document.getElementById(`TIMER_${DraggingID}`);
    if (!Dragged || Dragged === this) return;
    const Rect = this.getBoundingClientRect();
    const Native = Event.originalEvent as DragEvent;
    // Before or after the hovered tile, by which half the pointer is over: left
    // and right in a grid of several columns, top and bottom in a single one.
    const SingleColumn = Rect.width > (this.parentElement?.clientWidth ?? 0) * 0.6;
    const After = SingleColumn
      ? Native.clientY > Rect.top + Rect.height / 2
      : Native.clientX > Rect.left + Rect.width / 2;
    this.parentElement?.insertBefore(Dragged, After ? this.nextSibling : this);
  });
  $Grid.on('dragend', '.SHOWTRAK_TIMER', async function () {
    this.classList.remove('dragging');
    if (DraggingID === null) return;
    DraggingID = null;
    const Order = $Grid
      .children('.SHOWTRAK_TIMER')
      .toArray()
      .map((El) => Number(El.getAttribute('data-timer-id')));
    if (Order.join(',') === RenderedOrder) return;
    RenderedOrder = Order.join(',');
    const [Err] = await window.API.ReorderTimers(Order);
    if (Err) void Notify(Err, 'error');
  });
}

// --- Warnings and completions ----------------------------------------------

function HandleTimerEvent(Event: TimerEventView): void {
  if (Event.Sound) void PlaySoundRef(Event.Sound);
  if (Event.Toast) {
    const Timer = CurrentTimers().find((T) => T.ID === Event.TimerID);
    void Notify(
      DescribeTimerEvent(Event, Timer),
      Event.Kind === 'complete' ? 'success' : 'warning',
      6000
    );
  }
}

export function InitTimers(): void {
  $('#TIMER_GRID').on('click', '.timer-tile-btn', function (Event) {
    Event.stopPropagation();
    const ID = Number($(this).closest('.SHOWTRAK_TIMER').attr('data-timer-id'));
    const Action = this.getAttribute('data-action');
    if (!Number.isInteger(ID) || !Action) return;
    if (Action === 'edit') void OpenTimerEditor(ID);
    else void ControlTimer(ID, Action as ControlAction);
    (this as HTMLElement).blur();
  });
  // In EDIT mode a double-click anywhere on a tile opens its editor.
  $('#TIMER_GRID').on('dblclick', '.SHOWTRAK_TIMER', function () {
    if (Mode !== 'EDIT') return;
    void OpenTimerEditor(Number(this.getAttribute('data-timer-id')));
  });
  $('#ADD_TIMER_BUTTON, #EMPTY_CREATE_BUTTON').on('click', () => void CreateTimerAndEdit());
  WireDragAndDrop();
  OnModeChange(() => ApplyEditMode());
  window.API.OnTimers((Timers) => ApplyTimers(Timers));
  window.API.OnTimerEvent((Event) => HandleTimerEvent(Event));
  window.API.OnWebDashboardClientCount(() => UpdateBottomBar());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      Paint();
      if (AnyTicking()) RequestFrame();
    }
  });
}

export function RefreshBottomBar(): void {
  UpdateBottomBar();
}
