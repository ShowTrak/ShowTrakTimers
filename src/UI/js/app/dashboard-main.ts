// Web Dashboard entry point (bundled into WebDashboard/dashboard.js): a
// read-only grid of timers in their groups, drawn with the same tile model as
// the desktop app and animated locally between pushes.
import { Anchor, ElapsedAt, PaintInterval, type AnchoredTimer } from './lib/anchor';
import { BuildTileModel } from './lib/timer-tile';
import {
  NormalizeDashboardTimer,
  ReadCachedTimers,
  WriteCachedTimers,
  type DashboardTimerLike,
} from './lib/dashboard-cache';
import type { TimerView } from '../../../common/timers';
import { GroupTintHex } from '../../../common/groups';
import { BuildGroupSections, SectionsKey, type GroupLike } from './lib/group-layout';

let Anchored: AnchoredTimer<DashboardTimerLike>[] = [];
let Online = false;
let LastPaint = 0;
let FrameRequested = false;
let Groups: GroupLike[] = [];
let LastTimers: DashboardTimerLike[] = [];
let RenderedKey = '';

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
    if (performance.now() - LastPaint >= PaintInterval(Anchored.map((A) => A.Timer))) Paint();
    if (Ticking()) RequestFrame();
  });
}

function Render(Timers: DashboardTimerLike[]): void {
  const At = performance.now();
  LastTimers = Timers;
  Anchored = Timers.map((T) => Anchor(T, At));
  if (!Grid) return;
  // With no groups (or a host from before groups) this is one plain grid, as
  // before; otherwise one titled section per group that has timers on show.
  const Sections = BuildGroupSections(Groups, Timers, { IncludeEmptyGroups: false });
  const Plain = Sections.length <= 1 && Sections.every((S) => S.GroupID === null);
  const Key = Plain ? `plain:${Timers.map((T) => T.ID).join(',')}` : SectionsKey(Sections);
  if (Key !== RenderedKey) {
    RenderedKey = Key;
    const Existing = new Map<string, HTMLElement>();
    for (const El of Array.from(Grid.querySelectorAll<HTMLElement>('.SHOWTRAK_TIMER'))) {
      Existing.set(El.id, El);
    }
    const Tile = (Timer: DashboardTimerLike) =>
      Existing.get(`TIMER_${Timer.ID}`) ?? TileElement(Timer);
    const Fragment = document.createDocumentFragment();
    if (Plain) {
      Grid.className = 'timer-grid';
      for (const Timer of Timers) Fragment.appendChild(Tile(Timer));
    } else {
      Grid.className = 'dashboard-groups';
      for (const Section of Sections) {
        const El = document.createElement('section');
        El.className = 'dashboard-group';
        const Tint = GroupTintHex(Section.Group);
        if (Tint) {
          El.classList.add('group-tinted');
          El.style.setProperty('--group-tint', Tint);
        }
        const Title = document.createElement('div');
        Title.className = 'dashboard-group-title';
        Title.textContent = Section.Title;
        const Tiles = document.createElement('div');
        Tiles.className = 'timer-grid';
        for (const Timer of Section.Timers) Tiles.appendChild(Tile(Timer));
        El.append(Title, Tiles);
        Fragment.appendChild(El);
      }
    }
    Grid.replaceChildren(Fragment);
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

// --- Passcode (as ShowTrak Server's Web UI login) -----------------------------

const PASSCODE_KEY = 'showtrak-timers:dashboard:passcode';
const PIN_LENGTH = 4;
let Pin = '';
let Socket: DashboardSocket | null = null;

function Stored(): string | null {
  try {
    return window.localStorage.getItem(PASSCODE_KEY);
  } catch {
    return null;
  }
}

function Store(Value: string | null): void {
  try {
    if (Value === null) window.localStorage.removeItem(PASSCODE_KEY);
    else window.localStorage.setItem(PASSCODE_KEY, Value);
  } catch {
    // Private browsing may refuse storage: the passcode is then asked each visit.
  }
}

function LoginVisible(): boolean {
  const Overlay = document.getElementById('WEB_LOGIN_OVERLAY');
  return !!Overlay && !Overlay.classList.contains('d-none');
}

function SetLoginError(Message: string): void {
  const Node = document.getElementById('WEB_LOGIN_ERROR');
  if (!Node) return;
  Node.textContent = Message;
  Node.classList.toggle('d-none', !Message);
}

function RenderPin(): void {
  const Dots = document.getElementById('WEB_LOGIN_DOTS');
  if (!Dots) return;
  Dots.classList.toggle('is-empty', Pin.length === 0);
  let Html = '';
  for (let I = 0; I < PIN_LENGTH; I++) {
    Html += `<span class="web-pin-dot${I < Pin.length ? ' is-filled' : ''}"></span>`;
  }
  Dots.innerHTML = Html;
}

function ShowLogin(Visible: boolean): void {
  document.getElementById('WEB_LOGIN_OVERLAY')?.classList.toggle('d-none', !Visible);
  if (Visible) {
    Pin = '';
    RenderPin();
  }
}

type LoginReply = { ok?: boolean; error?: string; retryAfterMs?: number };

function SendLogin(Passcode: string, OnReply: (Reply: LoginReply) => void): void {
  if (!Socket) return;
  Socket.emit('auth:login', { password: Passcode }, OnReply);
}

function SubmitPin(): void {
  if (Pin.length < PIN_LENGTH) {
    SetLoginError('Enter the 4 digit passcode.');
    return;
  }
  const Passcode = Pin;
  SendLogin(Passcode, (Reply) => {
    if (Reply && Reply.ok) {
      Store(Passcode);
      SetLoginError('');
      ShowLogin(false);
      return;
    }
    Pin = '';
    RenderPin();
    SetLoginError(
      Reply && Reply.error === 'rate_limited'
        ? `Too many attempts. Try again in ${Math.ceil((Reply.retryAfterMs ?? 0) / 60000)} minutes.`
        : 'Incorrect passcode. Please try again.'
    );
  });
}

function PinKey(Digit: string): void {
  if (Pin.length >= PIN_LENGTH) return;
  SetLoginError('');
  Pin += Digit;
  RenderPin();
  // A fixed-length code submits itself once complete (after the last dot paints).
  if (Pin.length === PIN_LENGTH) setTimeout(SubmitPin, 120);
}

function WireLogin(): void {
  document.getElementById('WEB_LOGIN_PAD')?.addEventListener('click', (Event) => {
    const Key = (Event.target as HTMLElement | null)?.closest('.web-pin-key');
    if (!Key) return;
    const Action = Key.getAttribute('data-action');
    if (Action === 'submit') return SubmitPin();
    if (Action === 'backspace') {
      SetLoginError('');
      Pin = Pin.slice(0, -1);
      return RenderPin();
    }
    const Digit = Key.getAttribute('data-key');
    if (Digit) PinKey(Digit);
  });
  document.addEventListener('keydown', (Event) => {
    if (!LoginVisible()) return;
    if (Event.key >= '0' && Event.key <= '9') PinKey(Event.key);
    else if (Event.key === 'Backspace') {
      Pin = Pin.slice(0, -1);
      RenderPin();
    } else if (Event.key === 'Enter') SubmitPin();
    else return;
    Event.preventDefault();
  });
}

// The host's greeting: straight in, or a passcode is needed. A passcode this
// browser was given before is tried first, silently.
function OnHello(Hello: { PasswordProtection?: boolean; Authed?: boolean } | null): void {
  if (!Hello || !Hello.PasswordProtection || Hello.Authed) {
    ShowLogin(false);
    return;
  }
  const Remembered = Stored();
  if (!Remembered) {
    ShowLogin(true);
    return;
  }
  SendLogin(Remembered, (Reply) => {
    if (Reply && Reply.ok) {
      ShowLogin(false);
      return;
    }
    // A passcode that no longer works is forgotten.
    if (Reply && Reply.error === 'invalid_password') Store(null);
    ShowLogin(true);
    if (Reply && Reply.error === 'rate_limited')
      SetLoginError('Too many attempts. Try again later.');
  });
}

WireLogin();

if (typeof io === 'function') {
  Socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });
  Socket.on('connect', () => SetOnline(true));
  Socket.on('disconnect', () => SetOnline(false));
  Socket.on('connect_error', () => SetOnline(false));
  Socket.on('hello', (Hello: { PasswordProtection?: boolean; Authed?: boolean }) => OnHello(Hello));
  Socket.on('groups:update', (Payload: unknown) => {
    Groups = Array.isArray(Payload)
      ? Payload.filter(
          (G): G is GroupLike =>
            !!G && typeof G === 'object' && typeof (G as GroupLike).GroupID === 'number'
        ).map((G) => ({
          GroupID: G.GroupID,
          Title: String(G.Title ?? ''),
          Weight: Number(G.Weight) || 0,
          Colour: typeof G.Colour === 'number' ? G.Colour : null,
        }))
      : [];
    Render(LastTimers);
  });
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
