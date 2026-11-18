// Web Dashboard entry point (bundled into WebDashboard/dashboard.js): a
// read-only grid of timers, drawn with the same tile model as the desktop app
// and animated locally between pushes.
import { Anchor, ElapsedAt, type AnchoredTimer } from './lib/anchor';
import { BuildTileModel } from './lib/timer-tile';
import {
  NormalizeDashboardTimer,
  ReadCachedTimers,
  WriteCachedTimers,
  type DashboardTimerLike,
} from './lib/dashboard-cache';
import type { TimerView } from '../../../common/timers';

const PAINT_INTERVAL_MS = 100;

let Anchored: AnchoredTimer<DashboardTimerLike>[] = [];
let Online = false;
let LastPaint = 0;
let FrameRequested = false;

const Grid = document.getElementById('TIMER_GRID');
const Status = document.getElementById('CONNECTION_STATUS');
const Empty = document.getElementById('EMPTY_STATE');
const Storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

function TileElement(Timer: DashboardTimerLike): HTMLElement {
  const El = document.createElement('div');
  El.id = `TIMER_${Timer.ID}`;
  El.className = 'SHOWTRAK_TIMER';
  El.innerHTML = `
    <div class="timer-tile-head"><span class="timer-tile-status" data-role="status"></span></div>
    <div class="timer-tile-name" data-role="name"></div>
    <div class="timer-tile-readout">
      <span class="timer-tile-primary" data-role="primary"></span>
      <span class="timer-tile-secondary" data-role="secondary"></span>
    </div>
    <div class="progress timer-tile-progress" data-role="progress">
      <div class="progress-bar bg-white" role="progressbar"></div>
    </div>`;
  return El;
}

function Paint(): void {
  const At = performance.now();
  LastPaint = At;
  for (const Entry of Anchored) {
    const El = document.getElementById(`TIMER_${Entry.Timer.ID}`);
    if (!El) continue;
    // The tile model needs a full view; the dashboard only ever reads these.
    const Model = BuildTileModel(
      Entry.Timer as TimerView,
      Online ? ElapsedAt(Entry, At) : Entry.Timer.ElapsedMs
    );
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
      if (Bar) Bar.style.transform = `scaleX(${(Model.Progress ?? 0) / 100})`;
    }
  }
}

function Ticking(): boolean {
  return (
    Online && Anchored.some((A) => A.Timer.Status === 'RUNNING' || A.Timer.Status === 'OVERRUN')
  );
}

function RequestFrame(): void {
  if (FrameRequested) return;
  FrameRequested = true;
  requestAnimationFrame(() => {
    FrameRequested = false;
    if (performance.now() - LastPaint >= PAINT_INTERVAL_MS) Paint();
    if (Ticking()) RequestFrame();
  });
}

function Render(Timers: DashboardTimerLike[]): void {
  const At = performance.now();
  Anchored = Timers.map((T) => Anchor(T, At));
  if (!Grid) return;
  const Wanted = new Set(Timers.map((T) => `TIMER_${T.ID}`));
  for (const Child of Array.from(Grid.children)) if (!Wanted.has(Child.id)) Child.remove();
  for (const Timer of Timers) {
    const El = document.getElementById(`TIMER_${Timer.ID}`) ?? TileElement(Timer);
    Grid.appendChild(El);
  }
  Empty?.classList.toggle('d-none', Timers.length > 0);
  Paint();
  if (Ticking()) RequestFrame();
}

function SetOnline(Value: boolean): void {
  Online = Value;
  document.body.classList.toggle('is-offline', !Value);
  if (Status) {
    Status.textContent = Value ? 'Connected' : 'Offline';
    Status.className = `dashboard-connection ${Value ? 'is-online' : 'is-offline'}`;
  }
  Paint();
  if (Ticking()) RequestFrame();
}

Render(ReadCachedTimers(Storage));
SetOnline(false);

if (typeof io === 'function') {
  const Socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });
  Socket.on('connect', () => SetOnline(true));
  Socket.on('disconnect', () => SetOnline(false));
  Socket.on('connect_error', () => SetOnline(false));
  Socket.on('timers:update', (Payload: unknown) => {
    const List = Array.isArray(Payload)
      ? Payload.filter((T) => T && typeof T === 'object').map((T) =>
          NormalizeDashboardTimer(T as Record<string, unknown>)
        )
      : [];
    WriteCachedTimers(Storage, List);
    SetOnline(true);
    Render(List);
  });
}

window.addEventListener('offline', () => SetOnline(false));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) Paint();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}
