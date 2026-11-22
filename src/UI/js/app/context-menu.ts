// The right-click menu (#SHOWTRAK_CONTEXT_MENU), with ShowTrak Server's look
// and mechanics: drawn at the pointer and kept inside the window, arrow keys,
// Home/End, Enter/Space and Escape, type-to-search by title, hover-to-focus.
// Right-clicking a timer that is not selected selects just that timer first;
// right-clicking a group's rail selects that group. What the menu offers is
// decided in lib/context-menu-model.ts; this draws it and runs the actions.
import { Groups, Mode, SettingValue } from './state';
import { HandleNonFatalError, Safe } from './utils';
import { Notify } from './lib/toasts';
import {
  BuildContextMenuRows,
  type ContextMenuActionID,
  type ContextMenuRow,
} from './lib/context-menu-model';
import { PlaceMenu, ResolveMenuAnchor } from '@showtrak/protocol/ui/menu-placement';
import { FindTypeaheadMatch, NextTypeaheadBuffer } from '@showtrak/protocol/ui/menu-typeahead';
import {
  ClearSelection,
  IsSelected,
  SelectAll,
  SelectedIDs,
  SelectedTimers,
  SelectMany,
  SelectOnly,
} from './selection';
import { TimerIDsInGroup } from './lib/group-layout';
import { ControlTimers, CreateTimerAndEdit, CurrentTimers, GroupOfElement } from './timers';
import { OpenTimerEditor } from './timer-editor';
import { ConfirmedAll } from './menu';
import { CreateGroupAndEdit, OpenGroupEditor } from './group-manager';

const MENU_ID = 'SHOWTRAK_CONTEXT_MENU';

function Menu(): JQuery<HTMLElement> {
  return $(`#${MENU_ID}`);
}

export function HideContextMenu(): void {
  Menu().hide();
}

export function IsContextMenuOpen(): boolean {
  return Menu().is(':visible');
}

// What each row does. Resolves false when nothing happened (cancelled, or
// nothing to do), which keeps the selection.
async function RunAction(Row: ContextMenuRow): Promise<boolean | void> {
  const Action = Row.Action as ContextMenuActionID;
  switch (Action) {
    case 'SELECTION_START':
      return ControlTimers(SelectedIDs(), 'Start');
    case 'SELECTION_PAUSE':
      return ControlTimers(SelectedIDs(), 'Pause');
    case 'SELECTION_RESUME':
      return ControlTimers(SelectedIDs(), 'Unpause');
    case 'SELECTION_STOP':
      return ControlTimers(SelectedIDs(), 'Stop');
    case 'SELECTION_EDIT': {
      const [ID] = SelectedIDs();
      if (ID !== undefined) await OpenTimerEditor(ID);
      return;
    }
    case 'SELECT_ALL':
      SelectAll();
      return;
    case 'CLEAR_SELECTION':
      ClearSelection();
      return;
    case 'ALL_START':
      return ConfirmedAll('Start');
    case 'ALL_PAUSE':
      return ConfirmedAll('Pause');
    case 'ALL_RESUME':
      return ConfirmedAll('Unpause');
    case 'ALL_STOP':
      return ConfirmedAll('Stop');
    case 'NEW_TIMER':
      await CreateTimerAndEdit(typeof Row.GroupID === 'number' ? Row.GroupID : null);
      return;
    case 'NEW_GROUP':
      await CreateGroupAndEdit();
      return;
    case 'EDIT_GROUP':
      if (typeof Row.GroupID === 'number') await OpenGroupEditor(Row.GroupID);
      return;
  }
}

async function Run(Row: ContextMenuRow): Promise<void> {
  try {
    const Result = await RunAction(Row);
    if (
      Row.ActsOnSelection &&
      Result !== false &&
      SettingValue('UI_CLEAR_SELECTION_AFTER_ACTION') === true
    ) {
      ClearSelection();
    }
  } catch (Err) {
    HandleNonFatalError(`ContextMenu:${Row.Action}`, Err);
    void Notify('That action failed.', 'error');
  }
}

function RenderRows($Menu: JQuery<HTMLElement>, Rows: ContextMenuRow[]): void {
  $Menu.html(
    `<div class="context-menu-header"><span class="context-menu-close" role="button" aria-label="Dismiss menu" tabindex="-1">Dismiss</span></div><div class="context-menu-options"></div>`
  );
  const $Options = $Menu.find('.context-menu-options');
  for (const Row of Rows) {
    if (Row.Type === 'Divider') {
      $Options.append('<hr>');
      continue;
    }
    if (Row.Type === 'Header') {
      $Options.append(
        `<div class="context-section-header" role="presentation">${Safe(Row.Title)}</div>`
      );
      continue;
    }
    if (Row.Type === 'Info') {
      $Options.append(
        `<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(Row.Class ?? '')}" role="menuitem" aria-disabled="true" tabindex="-1"><span class="context-title">${Safe(Row.Title)}</span><span class="context-shortcut">${Safe(Row.Shortcut ?? '')}</span></a>`
      );
      continue;
    }
    const IconStyle = Row.IconColour ? ` style="color:${Safe(Row.IconColour)}"` : '';
    const Disabled = Row.Disabled ? ' aria-disabled="true"' : '';
    const $Row = $(
      `<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(Row.Class ?? '')}" role="menuitem" tabindex="-1"${Disabled}>` +
        `<span class="context-icon"><i class="bi ${Safe(Row.Icon || 'bi-dot')}"${IconStyle}></i></span>` +
        `<span class="context-title">${Safe(Row.Title)}</span>` +
        `<span class="context-shortcut">${Safe(Row.Shortcut ?? '')}</span>` +
        `</a>`
    );
    if (!Row.Disabled) $Row.on('click', () => void Run(Row));
    $Options.append($Row);
  }
}

function Position(
  $Menu: JQuery<HTMLElement>,
  Event: { clientX?: unknown; clientY?: unknown; pageX?: unknown; pageY?: unknown }
): void {
  const Pad = 8;
  const ViewWidth = window.innerWidth;
  const ViewHeight = window.innerHeight;
  const Bounds = (
    document.getElementById('APPLICATION_CONTAINER') ?? document.documentElement
  ).getBoundingClientRect();
  const Navbar = document.querySelector('.dragbar')?.getBoundingClientRect();
  const MinX = Math.max(Pad, Math.floor(Bounds.left) + Pad);
  const MinY = Math.max(
    Pad,
    Math.floor(Bounds.top) + Pad,
    Navbar ? Math.floor(Navbar.bottom) + Pad : Pad
  );
  const MaxX = Math.min(ViewWidth - Pad, Math.floor(Bounds.right) - Pad);
  const MaxY = Math.min(ViewHeight - Pad, Math.floor(Bounds.bottom) - Pad);
  const MaxHeight = Math.max(220, Math.floor(Math.max(120, MaxY - MinY) - Pad));
  $Menu.css({
    display: 'block',
    visibility: 'hidden',
    left: 0,
    top: 0,
    'max-height': `${MaxHeight}px`,
  });
  const Size = {
    Width: $Menu.outerWidth() || 0,
    Height: Math.min($Menu.outerHeight() || 0, MaxHeight),
  };
  const Anchor = ResolveMenuAnchor(
    Event,
    { X: window.scrollX || 0, Y: window.scrollY || 0 },
    { Width: ViewWidth, Height: ViewHeight }
  );
  const { Left, Top } = PlaceMenu(Anchor, Size, { MinX, MaxX, MinY, MaxY });
  $Menu.css({ display: 'block', visibility: 'visible', left: `${Left}px`, top: `${Top}px` });
  $Menu.attr('role', 'menu');
  const $First = $Menu
    .find('a.SHOWTRAK_CONTEXTMENU_BUTTON[role="menuitem"]:not([aria-disabled="true"])')
    .first();
  setTimeout(() => $First.trigger('focus'), 0);
}

function BindKeyboard($Menu: JQuery<HTMLElement>): void {
  let Buffer = '';
  let BufferAt = 0;
  $Menu.off('keydown').on('keydown', (Event) => {
    const $Items = $Menu.find(
      'a.SHOWTRAK_CONTEXTMENU_BUTTON[role="menuitem"]:not([aria-disabled="true"])'
    );
    if (!$Items.length) return;
    let Index = $Items.index(document.activeElement as Element);
    const Key = Event.key;
    const Focus = (I: number) =>
      $Items.eq(I).trigger('focus')[0]?.scrollIntoView({ block: 'nearest' });
    if (Key.length === 1 && Key !== ' ' && !Event.ctrlKey && !Event.metaKey && !Event.altKey) {
      Event.preventDefault();
      const Now = Date.now();
      Buffer = NextTypeaheadBuffer(Buffer, BufferAt, Key, Now);
      BufferAt = Now;
      const Titles = $Items
        .map((_I, El) => $(El).find('.context-title').text().trim().toLowerCase())
        .get();
      const Found = FindTypeaheadMatch(Titles, Buffer, Index);
      if (Found !== -1) Focus(Found);
      return;
    }
    if (Key === 'ArrowDown' || Key === 'ArrowUp') {
      Event.preventDefault();
      Index = (Index + (Key === 'ArrowDown' ? 1 : -1) + $Items.length) % $Items.length;
      Focus(Index);
      return;
    }
    if (Key === 'Home' || Key === 'End') {
      Event.preventDefault();
      Focus(Key === 'Home' ? 0 : $Items.length - 1);
      return;
    }
    if (Key === 'Enter' || Key === ' ') {
      Event.preventDefault();
      Event.stopPropagation();
      if (Index >= 0) {
        const Target = $Items.eq(Index);
        setTimeout(() => Target.trigger('click'), 0);
      }
      return;
    }
    if (Key === 'Escape') {
      Event.preventDefault();
      Event.stopPropagation();
      HideContextMenu();
    }
  });
  $Menu
    .off('mouseenter')
    .on('mouseenter', 'a.SHOWTRAK_CONTEXTMENU_BUTTON', function (this: HTMLElement) {
      if (this.getAttribute('aria-disabled') !== 'true') $(this).trigger('focus');
    });
}

/** Open the menu at a point (a right-click), or centred (the keyboard). */
export function OpenContextMenu(
  Event: { clientX?: unknown; clientY?: unknown; pageX?: unknown; pageY?: unknown } = {},
  Target: Element | null = null
): void {
  if (document.querySelector('.modal.show')) return;
  const $Menu = Menu();
  // Right-clicking an unselected tile narrows the selection to it; a group's
  // rail selects that group (as its click does, but never deselecting).
  const Tile = Target?.closest('.SHOWTRAK_TIMER');
  const RailGroup = Target?.closest('.GROUP_TITLE_CLICKABLE') ? GroupOfElement(Target) : undefined;
  if (Tile) {
    const ID = Number(Tile.getAttribute('data-timer-id'));
    if (Number.isInteger(ID) && !IsSelected(ID)) SelectOnly(ID);
  } else if (RailGroup !== undefined) {
    const IDs = TimerIDsInGroup(Groups, CurrentTimers(), RailGroup);
    if (IDs.length) SelectMany(IDs);
  }
  const Rows = BuildContextMenuRows({
    Selected: SelectedTimers(),
    TimerCount: CurrentTimers().length,
    Mode,
    Groups,
    RailGroupID: RailGroup,
  });
  RenderRows($Menu, Rows);
  Position($Menu, Event);
  BindKeyboard($Menu);
}

/** Open the menu in the middle of the window (Ctrl/Cmd+Shift+M, the Menu key, Shift+F10). */
export function OpenContextMenuCentred(): void {
  OpenContextMenu({
    clientX: Math.floor(window.innerWidth / 2),
    clientY: Math.floor(window.innerHeight / 2),
  });
}

export function InitContextMenu(): void {
  document.addEventListener('contextmenu', (Event) => {
    Event.preventDefault();
    const Target = Event.target instanceof Element ? Event.target : null;
    // Text fields keep their own menu (cut, copy, paste) where the platform has one.
    if (Target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (Target?.closest('.modal, #APP_BOTTOM_BAR, .dragbar')) return;
    OpenContextMenu(Event, Target);
  });
  // A click outside the open menu only closes it: it does not also select the
  // tile (or press the button) underneath.
  document.addEventListener(
    'click',
    (Event) => {
      if (!IsContextMenuOpen()) return;
      const Target = Event.target instanceof Element ? Event.target : null;
      if (Target?.closest(`#${MENU_ID}`)) {
        const Inert = Target.closest(
          '.SHOWTRAK_CONTEXTMENU_BUTTON[aria-disabled="true"], .context-section-header, hr'
        );
        if (!Inert) setTimeout(HideContextMenu, 0);
        return;
      }
      Event.preventDefault();
      Event.stopPropagation();
      HideContextMenu();
    },
    true
  );
  window.addEventListener('blur', HideContextMenu);
  window.addEventListener('resize', HideContextMenu);
  document
    .getElementById('APPLICATION_CONTENT')
    ?.addEventListener('scroll', HideContextMenu, { passive: true });
}
