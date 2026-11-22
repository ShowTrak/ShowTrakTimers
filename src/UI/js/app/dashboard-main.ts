// Web Dashboard entry point (bundled into WebDashboard/dashboard.js): a
// read-only grid of timers in their groups, drawn with the same tile model as
// the desktop app and animated locally between pushes.
import { Anchor, ElapsedAt, NextPaintDelay, type AnchoredTimer } from './lib/anchor';
import { PaintTileElement } from './lib/tile-dom';
import { CreatePaintLoop } from './lib/paint-loop';
import { BuildTileModel } from './lib/timer-tile';
import {
  NormalizeDashboardGroups,
  NormalizeDashboardLayout,
  NormalizeDashboardTimer,
  ReadCachedGroups,
  ReadCachedLayout,
  ReadCachedTimers,
  WriteCachedGroups,
  WriteCachedLayout,
  WriteCachedTimers,
  type DashboardTimerLike,
} from './lib/dashboard-cache';
import type { DashboardGroup, DashboardLayout, TimerView } from '@showtrak/protocol/timers';
import { IsTicking } from '../../../common/timers';
import { IsArray } from '../../../common/guards';
import { GetGroupSpan, GroupTintHex } from '../../../common/groups';
import { BuildGroupSections, SectionsKey } from './lib/group-layout';

let Anchored: AnchoredTimer<DashboardTimerLike>[] = [];
let Online = false;
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

// The last groups and layout seen, so an offline reload still draws the groups.
let Groups: DashboardGroup[] = ReadCachedGroups(Storage);
let Layout: DashboardLayout = ReadCachedLayout(Storage);

// The desktop's Group Colour Saturation, as its grid applies it.
function ApplyLayout(): void {
  document.documentElement.style.setProperty(
    '--group-tint-scale',
    String(Layout.GroupColourSaturation / 100)
  );
}

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

function Paint(OnlyTicking = false): void {
  const At = performance.now();
  for (const Entry of Anchored) {
    if (OnlyTicking && !IsTicking(Entry.Timer.Status)) continue;
    const El = document.getElementById(`TIMER_${Entry.Timer.ID}`);
    if (!El) continue;
    // The tile model needs a full view; the dashboard only ever reads these.
    PaintTileElement(
      El,
      BuildTileModel(
        Entry.Timer as TimerView,
        Online ? ElapsedAt(Entry, At) : Entry.Timer.ElapsedMs
      )
    );
  }
}

// While timers run, repaint the ticking tiles whenever one would next change.
const Loop = CreatePaintLoop({
  Delay: () => NextPaintDelay(Anchored, performance.now()),
  Paint: () => Paint(true),
  Active: () => Online,
});

function SchedulePaint(): void {
  Loop.Schedule();
}

// Draw the timers. Reanchor is for a new list from the host; a redraw for a
// groups or layout change keeps each running timer where it is, rather than
// winding it back to the last list's value.
function Render(Timers: DashboardTimerLike[], Reanchor = true): void {
  const At = performance.now();
  LastTimers = Timers;
  if (Reanchor || Anchored.length !== Timers.length) Anchored = Timers.map((T) => Anchor(T, At));
  if (!Grid) return;
  // With no groups (or a host from before groups) this is one plain grid, as
  // before; otherwise one titled section per group that has timers on show.
  const Sections = BuildGroupSections(Groups, Timers, { IncludeEmptyGroups: false });
  const Plain = Sections.length <= 1 && Sections.every((S) => S.GroupID === null);
  const Columns = Layout.GroupColumns;
  const Key = Plain
    ? `plain:${Timers.map((T) => T.ID).join(',')}`
    : `${Columns}|${SectionsKey(Sections)}`;
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
      Grid.style.removeProperty('grid-template-columns');
      for (const Timer of Timers) Fragment.appendChild(Tile(Timer));
    } else {
      // The desktop's group column grid: each group spans its own width.
      Grid.className = 'dashboard-groups';
      Grid.style.gridTemplateColumns = `repeat(${Columns}, minmax(0, 1fr))`;
      for (const Section of Sections) {
        const El = document.createElement('section');
        El.className = 'dashboard-group';
        El.style.gridColumn = `span ${GetGroupSpan(Section.Group as DashboardGroup | null, Columns)}`;
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
  SchedulePaint();
}

// The timers cached for an offline reload: rewritten when what is shown
// changes (a timer added, renamed, started or stopped), and otherwise at most
// every few seconds, not on every push while timers run.
const CACHE_REFRESH_MS = 5000;
let CachedKey = '';
let CachedAt = 0;
function CacheTimers(Timers: DashboardTimerLike[]): void {
  const Key = JSON.stringify(Timers.map(({ ElapsedMs: _E, Warning: _W, ...Rest }) => Rest));
  const At = performance.now();
  if (Key === CachedKey && At - CachedAt < CACHE_REFRESH_MS) return;
  CachedKey = Key;
  CachedAt = At;
  WriteCachedTimers(Storage, Timers);
}

function SetOnline(Value: boolean): void {
  // Going offline, running timers stop where they are on screen, rather than
  // snapping back to the last list the host sent.
  if (Online && !Value) {
    const At = performance.now();
    Anchored = Anchored.map((Entry) =>
      IsTicking(Entry.Timer.Status)
        ? Anchor({ ...Entry.Timer, ElapsedMs: ElapsedAt(Entry, At) }, At)
        : Entry
    );
    LastTimers = Anchored.map((Entry) => Entry.Timer);
    WriteCachedTimers(Storage, LastTimers);
  }
  Online = Value;
  document.body.classList.toggle('is-offline', !Value);
  if (Status) {
    Status.textContent = Value ? 'Connected' : 'Offline';
    Status.className = `dashboard-connection ${Value ? 'is-online' : 'is-offline'}`;
  }
  Paint();
  SchedulePaint();
}

ApplyLayout();
Render(ReadCachedTimers(Storage));
SetOnline(false);

// --- Passcode (as ShowTrak Server's Web UI login) -----------------------------

// What the browser keeps after a sign-in: the host's token, never the passcode
// (so it cannot be read back out of a crew phone). Earlier versions kept the
// passcode itself; that is forgotten here.
const TOKEN_KEY = 'showtrak-timers:dashboard:token';
const OLD_PASSCODE_KEY = 'showtrak-timers:dashboard:passcode';
const PIN_LENGTH = 4;
let Pin = '';
let Socket: DashboardSocket | null = null;

function Stored(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function Store(Value: string | null): void {
  try {
    if (Value === null) window.localStorage.removeItem(TOKEN_KEY);
    else window.localStorage.setItem(TOKEN_KEY, Value);
  } catch {
    // Private browsing may refuse storage: the passcode is then asked each visit.
  }
}

try {
  window.localStorage.removeItem(OLD_PASSCODE_KEY);
} catch {
  // Storage blocked: nothing was kept there either.
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

type LoginReply = { ok?: boolean; token?: string; error?: string; retryAfterMs?: number };

function SendLogin(
  Credentials: { password: string } | { token: string },
  OnReply: (Reply: LoginReply) => void
): void {
  if (!Socket) return;
  Socket.emit('auth:login', Credentials, OnReply);
}

function SubmitPin(): void {
  if (Pin.length < PIN_LENGTH) {
    SetLoginError('Enter the 4 digit passcode.');
    return;
  }
  SendLogin({ password: Pin }, (Reply) => {
    if (Reply && Reply.ok) {
      if (typeof Reply.token === 'string') Store(Reply.token);
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

// The host's greeting: straight in, or a passcode is needed. The token this
// browser was given at its last sign-in is tried first, silently.
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
  SendLogin({ token: Remembered }, (Reply) => {
    if (Reply && Reply.ok) {
      ShowLogin(false);
      return;
    }
    // A token that no longer works (the passcode changed) is forgotten.
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
    // Fall back to polling where WebSockets are blocked (some venue Wi-Fi):
    // without this the client only ever tries the first transport.
    tryAllTransports: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });
  Socket.on('connect', () => SetOnline(true));
  Socket.on('disconnect', () => SetOnline(false));
  Socket.on('connect_error', () => SetOnline(false));
  Socket.on('hello', (Hello: { PasswordProtection?: boolean; Authed?: boolean }) => OnHello(Hello));
  Socket.on('layout:update', (Payload: unknown) => {
    Layout = NormalizeDashboardLayout(Payload);
    WriteCachedLayout(Storage, Layout);
    ApplyLayout();
    Render(LastTimers, false);
  });
  Socket.on('groups:update', (Payload: unknown) => {
    Groups = NormalizeDashboardGroups(Payload);
    WriteCachedGroups(Storage, Groups);
    Render(LastTimers, false);
  });
  Socket.on('timers:update', (Payload: unknown) => {
    const List = IsArray(Payload)
      ? Payload.filter((T) => T && typeof T === 'object').map((T) =>
          NormalizeDashboardTimer(T as Record<string, unknown>)
        )
      : [];
    CacheTimers(List);
    SetOnline(true);
    Render(List);
  });
}

window.addEventListener('offline', () => SetOnline(false));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) Paint();
  SchedulePaint();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}
