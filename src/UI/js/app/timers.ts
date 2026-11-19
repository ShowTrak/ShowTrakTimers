// The timer grid: the groups (laid out on ShowTrak Server's group column grid,
// each with its clickable rail and tinted box), one tile per timer, its run
// controls, the local animation loop, selection by clicking, drag-to-reorder
// (and between groups) in EDIT mode, and what happens on a timer's warning or
// completion (sound, notification).
import { Anchor, ElapsedAt, PaintInterval, type AnchoredTimer } from './lib/anchor';
import {
  BuildTileModel,
  DescribeTimerEvent,
  SummariseTimers,
  type TileModel,
} from './lib/timer-tile';
import type { TimerView } from '../../../common/timers';
import {
  GetGroupSpan,
  GroupTintHex,
  ParseGroupColumnCount,
  TruncateGroupLabel,
} from '../../../common/groups';
import { Groups, Mode, Services, SettingValue, setGroups } from './state';
import { BuildGroupSections, SectionsKey, type GroupSection } from './lib/group-layout';
import {
  IsSelected,
  OnSelectionChange,
  ReconcileSelection,
  SelectionStatusText,
  SetTimerSource,
  ToggleGroupSelection,
  ToggleSelection,
} from './selection';
import { Notify } from './lib/toasts';
import { HandleNonFatalError, Safe } from './utils';
import { PlaySoundRef } from './sounds';
import { OpenTimerEditor } from './timer-editor';
import { OnModeChange } from './mode';
import { CanCreateTimer } from './lib/timer-editor-model';
import type { ControlAction, TimerEventView } from '../../../common/api';

let Anchored: AnchoredTimer<TimerView>[] = [];
let RenderedKey = '';
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
      <button type="button" class="timer-tile-btn edit-only" data-action="edit" title="Edit timer" aria-label="Edit timer"><i class="bi bi-gear-fill"></i></button>
    </div>
  </div>`;
}

// Apply a model to a tile, touching only what changed.
function PaintTile(El: HTMLElement, Model: TileModel): void {
  // The selection ring and the drag state are the page's, not the model's.
  const Extra: string[] = [];
  if (IsSelected(Model.ID)) Extra.push('SELECTED');
  if (Model.ID === DraggingID) Extra.push('dragging');
  const ClassName = ['SHOWTRAK_TIMER', ...Model.Classes, ...Extra].join(' ');
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

// The Default group's rail and drop zone are keyed 'default' rather than by ID.
const DEFAULT_KEY = 'default';

function GroupKey(GroupID: number | null): string {
  return GroupID === null ? DEFAULT_KEY : String(GroupID);
}

function ParseGroupKey(Value: string | undefined | null): number | null {
  const ID = Number(Value);
  return Value && Value !== DEFAULT_KEY && Number.isInteger(ID) && ID > 0 ? ID : null;
}

function ColumnCount(): number {
  return ParseGroupColumnCount(SettingValue('UI_GROUP_COLUMN_COUNT'));
}

function SectionHtml(Section: GroupSection<TimerView>, Columns: number): string {
  const Key = GroupKey(Section.GroupID);
  const Span = Section.Group
    ? GetGroupSpan(
        {
          isFullWidth: Section.Group.isFullWidth !== false,
          ColumnSpan: Section.Group.ColumnSpan ?? 1,
        },
        Columns
      )
    : Columns;
  const Tint = GroupTintHex(Section.Group);
  const TintClass = Tint ? ' group-tinted' : '';
  const TintStyle = Tint ? ` style="--group-tint: ${Safe(Tint)};"` : '';
  const Title = Section.Title;
  return `<div class="d-flex justify-content-start group-column-item" data-group-key="${Key}" style="grid-column: span ${Span};">
    <div class="GROUP_TITLE_CLICKABLE m-3 me-0 mb-0 rounded" role="button" tabindex="-1" data-groupid="${Key}" title="${Safe(Title)}: click to select or deselect its timers" aria-label="${Safe(Title)}">
      <div class="d-flex align-items-center text-center h-100">
        <span class="GROUP_TITLE py-2">${Safe(TruncateGroupLabel(Title))}</span>
      </div>
    </div>
    <div class="bg-ghost rounded m-3 mb-0 w-100 group-drop-zone timer-group-zone${TintClass}"${TintStyle} data-groupid="${Key}"></div>
  </div>`;
}

const EMPTY_GROUP_HTML = `<div class="timer-group-empty">
  <span class="text-muted">Empty Group</span>
  <span class="text-muted text-sm edit-only">Drag timers here, or use Move to Group in the right-click menu.</span>
</div>`;

function RenderStructure(): void {
  const Grid = document.getElementById('TIMER_GRID');
  const Timers = CurrentTimers();
  $('#EMPTY_STATE').toggleClass('d-none', Timers.length > 0 || Groups.length > 0);
  if (!Grid) return;
  Grid.classList.toggle('d-none', Timers.length === 0 && Groups.length === 0);

  const Columns = ColumnCount();
  const Sections = BuildGroupSections(Groups, Timers);
  const Key = `${Columns}|${SectionsKey(Sections)}`;
  if (Key !== RenderedKey) {
    RenderedKey = Key;
    // Tiles are kept and moved, not rebuilt: they hold their painted state.
    const Tiles = new Map<number, HTMLElement>();
    for (const El of Array.from(Grid.querySelectorAll<HTMLElement>('.SHOWTRAK_TIMER'))) {
      Tiles.set(Number(El.getAttribute('data-timer-id')), El);
    }
    Grid.style.gridTemplateColumns = `repeat(${Columns}, minmax(0, 1fr))`;
    Grid.innerHTML = Sections.map((Section) => SectionHtml(Section, Columns)).join('');
    for (const Section of Sections) {
      const Zone = Grid.querySelector<HTMLElement>(
        `.timer-group-zone[data-groupid="${GroupKey(Section.GroupID)}"]`
      );
      if (!Zone) continue;
      if (!Section.Timers.length) Zone.insertAdjacentHTML('beforeend', EMPTY_GROUP_HTML);
      for (const Timer of Section.Timers) {
        let Tile = Tiles.get(Timer.ID);
        if (!Tile) {
          Zone.insertAdjacentHTML('beforeend', TileHtml(Timer));
          Tile = Zone.lastElementChild as HTMLElement;
        } else {
          Zone.appendChild(Tile);
        }
      }
    }
  }
  ApplyEditMode();
  ReconcileSelection();
}

// The group colour strength preference, as Server applies it.
function ApplyGroupColourScale(): void {
  const Raw = Number(SettingValue('UI_GROUP_COLOUR_SATURATION'));
  const Scale = Number.isFinite(Raw) ? Math.min(100, Math.max(0, Raw)) / 100 : 1;
  document.documentElement.style.setProperty('--group-tint-scale', String(Scale));
}

/** Re-lay the groups (the groups or the layout settings changed). */
export function RefreshGroupLayout(): void {
  ApplyGroupColourScale();
  RenderStructure();
  Paint();
}

function UpdateBottomBar(): void {
  const Clients = Services?.WebDashboard.Clients ?? 0;
  const Selection = SelectionStatusText();
  const Parts = [Selection || SummariseTimers(CurrentTimers())];
  if (Clients > 0) Parts.push(`${Clients} Dashboard Viewer${Clients === 1 ? '' : 's'}`);
  $('#BOTTOM_BAR_STATUS').text(Parts.join(' · '));
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

const PAST_TENSE: Readonly<Record<ControlAction, string>> = {
  Start: 'Started',
  Stop: 'Stopped',
  Pause: 'Paused',
  Unpause: 'Resumed',
};

const NOTHING_TO_DO: Readonly<Record<ControlAction, string>> = {
  Start: 'None of the selected timers can be started: they are already running or paused.',
  Stop: 'None of the selected timers is running, paused or complete.',
  Pause: 'None of the selected timers is running.',
  Unpause: 'None of the selected timers is paused.',
};

/**
 * Run an action on a list of timers (the selection). Start only starts the
 * ones that are not already going. Resolves false when there was nothing to
 * act on (so the selection is kept).
 */
export async function ControlTimers(
  IDs: readonly number[],
  Action: ControlAction
): Promise<boolean> {
  if (!IDs.length) {
    void Notify('Select one or more timers first.', 'info', 2000);
    return false;
  }
  try {
    const [Err, Count] = await window.API.ControlTimers([...IDs], Action);
    if (Err) {
      void Notify(Err, 'error');
      return false;
    }
    if (!Count) {
      void Notify(NOTHING_TO_DO[Action], 'info', 2500);
      return false;
    }
    void Notify(`${PAST_TENSE[Action]} ${Count} timer${Count === 1 ? '' : 's'}.`, 'info', 1500);
    return true;
  } catch (Err) {
    HandleNonFatalError('Timers:ControlMany', Err);
    return false;
  }
}

export async function CreateTimerAndEdit(GroupID: number | null = null): Promise<void> {
  if (!CanCreateTimer(Mode, CurrentTimers().length)) {
    void Notify('Switch to Edit mode to add timers.', 'info', 2500);
    return;
  }
  const [Err, Timer] = await window.API.CreateTimer({ Name: 'New Timer', GroupID });
  if (Err || !Timer) {
    void Notify(Err || 'Failed to create the timer.', 'error');
    return;
  }
  await OpenTimerEditor(Timer.ID, { IsNew: true });
}

// --- EDIT mode: drag to reorder, and between groups ---------------------------

let DraggingID: number | null = null;
// The page's arrangement when the drag began: a drop back where it started
// changes nothing, so it must not write anything (or mark the show unsaved).
let LayoutAtDragStart = '';

const LayoutKey = (Layout: Array<{ ID: number; GroupID: number | null }>) =>
  Layout.map((P) => `${P.ID}:${P.GroupID ?? ''}`).join(',');

function ApplyEditMode(): void {
  const Editing = Mode === 'EDIT';
  $('#TIMER_GRID .SHOWTRAK_TIMER').attr('draggable', Editing ? 'true' : 'false');
}

/** The arrangement the page shows now: every tile, zone by zone. */
function ArrangementOnPage(): Array<{ ID: number; GroupID: number | null }> {
  const Layout: Array<{ ID: number; GroupID: number | null }> = [];
  for (const Zone of Array.from(
    document.querySelectorAll<HTMLElement>('#TIMER_GRID .timer-group-zone')
  )) {
    const GroupID = ParseGroupKey(Zone.getAttribute('data-groupid'));
    for (const Tile of Array.from(Zone.querySelectorAll<HTMLElement>('.SHOWTRAK_TIMER'))) {
      Layout.push({ ID: Number(Tile.getAttribute('data-timer-id')), GroupID });
    }
  }
  return Layout;
}

function WireDragAndDrop(): void {
  const $Grid = $('#TIMER_GRID');
  $Grid.on('dragstart', '.SHOWTRAK_TIMER', function (Event) {
    if (Mode !== 'EDIT') return false;
    DraggingID = Number(this.getAttribute('data-timer-id'));
    LayoutAtDragStart = LayoutKey(ArrangementOnPage());
    this.classList.add('dragging');
    const Transfer = (Event.originalEvent as DragEvent | undefined)?.dataTransfer;
    if (Transfer) {
      Transfer.effectAllowed = 'move';
      Transfer.setData('text/plain', String(DraggingID));
    }
    return undefined;
  });
  // Over a tile: before or after it, by which half the pointer is over (left
  // and right in a zone of several columns, top and bottom in a single one).
  $Grid.on('dragover', '.SHOWTRAK_TIMER', function (Event) {
    if (DraggingID === null) return;
    Event.preventDefault();
    Event.stopPropagation();
    const Dragged = document.getElementById(`TIMER_${DraggingID}`);
    if (!Dragged || Dragged === this) return;
    const Rect = this.getBoundingClientRect();
    const Native = Event.originalEvent as DragEvent;
    const SingleColumn = Rect.width > (this.parentElement?.clientWidth ?? 0) * 0.6;
    const After = SingleColumn
      ? Native.clientY > Rect.top + Rect.height / 2
      : Native.clientX > Rect.left + Rect.width / 2;
    this.parentElement?.insertBefore(Dragged, After ? this.nextSibling : this);
    $Grid.find('.dnd-over').removeClass('dnd-over');
  });
  // Over a zone's empty space (or an empty group): to the end of that group.
  $Grid.on('dragover', '.timer-group-zone', function (Event) {
    if (DraggingID === null) return;
    Event.preventDefault();
    const Dragged = document.getElementById(`TIMER_${DraggingID}`);
    if (!Dragged) return;
    if (Dragged.parentElement !== this) this.appendChild(Dragged);
    $Grid.find('.dnd-over').not(this).removeClass('dnd-over');
    this.classList.add('dnd-over');
  });
  $Grid.on('drop', '.timer-group-zone', (Event) => Event.preventDefault());
  $Grid.on('dragend', '.SHOWTRAK_TIMER', async function () {
    this.classList.remove('dragging');
    $Grid.find('.dnd-over').removeClass('dnd-over');
    if (DraggingID === null) return;
    DraggingID = null;
    const Layout = ArrangementOnPage();
    if (LayoutKey(Layout) === LayoutAtDragStart) return;
    // Redrawn from the push that follows; an empty group a tile left gets its
    // placeholder back then.
    RenderedKey = '';
    const [Err] = await window.API.ArrangeTimers(Layout);
    if (Err) {
      void Notify(Err, 'error');
      RenderStructure();
    }
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
  SetTimerSource(CurrentTimers);
  OnSelectionChange(() => UpdateBottomBar());
  $('#TIMER_GRID').on('click', '.timer-tile-btn', function (Event) {
    Event.stopPropagation();
    const ID = Number($(this).closest('.SHOWTRAK_TIMER').attr('data-timer-id'));
    const Action = this.getAttribute('data-action');
    if (!Number.isInteger(ID) || !Action) return;
    if (Action === 'edit') void OpenTimerEditor(ID);
    else void ControlTimer(ID, Action as ControlAction);
    (this as HTMLElement).blur();
  });
  // A click on a tile toggles its selection, as on ShowTrak Server's tiles.
  $('#TIMER_GRID').on('click', '.SHOWTRAK_TIMER', function () {
    const ID = Number(this.getAttribute('data-timer-id'));
    if (Number.isInteger(ID)) ToggleSelection(ID);
  });
  // A group's rail toggles the whole group.
  $('#TIMER_GRID').on('click', '.GROUP_TITLE_CLICKABLE', function () {
    ToggleGroupSelection(ParseGroupKey(this.getAttribute('data-groupid')));
  });
  // In EDIT mode a double-click anywhere on a tile opens its editor.
  $('#TIMER_GRID').on('dblclick', '.SHOWTRAK_TIMER', function () {
    if (Mode !== 'EDIT') return;
    void OpenTimerEditor(Number(this.getAttribute('data-timer-id')));
  });
  $('#ADD_TIMER_BUTTON, #EMPTY_CREATE_BUTTON').on('click', () => void CreateTimerAndEdit());
  window.API.OnGroups((List) => {
    setGroups(List);
    RefreshGroupLayout();
  });
  window.API.OnSettings(() => RefreshGroupLayout());
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

/** The group a rail or zone element belongs to (null: the Default group); undefined for neither. */
export function GroupOfElement(El: Element | null): number | null | undefined {
  const Holder = El?.closest('.GROUP_TITLE_CLICKABLE, .timer-group-zone');
  if (!Holder) return undefined;
  return ParseGroupKey(Holder.getAttribute('data-groupid'));
}
