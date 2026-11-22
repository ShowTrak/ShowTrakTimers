// The Group Manager and Group Editor modals, as ShowTrak Server's: the group
// list (drag to reorder, click to edit, the locked Default group last) and the
// editor (name, slug, width, colour, selection keybind, members). Every field
// saves as it changes.
import { closeModal, openModal } from './lib/modal';
import { ConfirmationDialog, Notify } from './lib/toasts';
import { CloseAllModals } from './modals';
import { Groups, Mode, SettingValue } from './state';
import { Safe } from './utils';
import { CurrentTimers } from './timers';
import { TimerIDsInGroup } from './lib/group-layout';
import {
  BuildGroupWidthOptions,
  DescribeKeyBind,
  FormatKeyBindLabel,
  GetGroupWidthValue,
  GROUP_COLOURS,
  GROUP_KEYBINDS,
  ParseGroupColumnCount,
  type GroupPatchView,
  type GroupView,
} from '../../../common/groups';

const MANAGER_ID = 'SHOWTRAK_MODAL_GROUPMANAGER';
const EDITOR_ID = 'SHOWTRAK_MODAL_GROUP_EDITOR';

let EditingGroupID: number | null = null;
let RenameTimer: ReturnType<typeof setTimeout> | null = null;
// What the list and the member list last drew. Timers push about once a second
// while any runs, and redrawing an unchanged list then would swallow clicks and
// end drags mid-way: they are only redrawn when what they show changed.
let RenderedListHtml = '';
let RenderedMembersHtml = '';

function GroupByID(ID: number | null): GroupView | undefined {
  return ID === null ? undefined : Groups.find((G) => G.GroupID === ID);
}

function MemberCount(GroupID: number | null): number {
  return TimerIDsInGroup(Groups, CurrentTimers(), GroupID).length;
}

function Members(GroupID: number | null): string {
  const Count = MemberCount(GroupID);
  return `${Count} ${Count === 1 ? 'Timer' : 'Timers'}`;
}

async function Save(Patch: GroupPatchView, Success?: string): Promise<boolean> {
  if (EditingGroupID === null) return false;
  const [Err] = await window.API.UpdateGroup(EditingGroupID, Patch);
  if (Err) {
    void Notify(Err, 'error');
    return false;
  }
  if (Success) void Notify(Success, 'success', 1800);
  return true;
}

// --- The list ----------------------------------------------------------------

function RenderGroupList(Force = false): void {
  const $List = $('#GROUP_MANAGER_GROUP_LIST');
  // Never under a drag in progress (the drop would land on a row that is gone).
  if (!Force && document.querySelector('#GROUP_MANAGER_SORTABLE_LIST .dragging')) return;
  const Rows = Groups.map((Group) => {
    const KeyBind = FormatKeyBindLabel(Group.KeyBind);
    const Badge = KeyBind
      ? `<span class="group-manager-keybind-indicator" title="Selection keybind">${Safe(KeyBind)}</span>`
      : '';
    const Swatch =
      typeof Group.Colour === 'number' && GROUP_COLOURS[Group.Colour]
        ? `<span class="group-manager-colour-dot" style="background:${Safe(GROUP_COLOURS[Group.Colour]!.hex)}"></span>`
        : '';
    return `<div class="GROUP_MANAGER_GROUP_ITEM p-3 rounded bg-ghost d-flex align-items-center gap-2" data-groupid="${Group.GroupID}" draggable="true">
      <span class="group-manager-grip" title="Drag to reorder"><i class="bi bi-grip-vertical"></i></span>
      <button type="button" class="GROUP_MANAGER_GROUP_OPEN d-flex justify-content-between align-items-center w-100 border-0" draggable="false">
        <span class="d-flex align-items-center gap-2 text-start">${Swatch}<span class="GROUP_MANAGER_GROUP_TITLE text-bold">${Safe(Group.Title)}</span></span>
        <div class="d-flex align-items-center gap-2">
          ${Badge}
          <span class="badge bg-ghost-light text-light">${Members(Group.GroupID)}</span>
          <i class="bi bi-chevron-right group-manager-chevron"></i>
        </div>
      </button>
    </div>`;
  }).join('');
  const Html = `<div id="GROUP_MANAGER_SORTABLE_LIST" class="d-grid gap-2">${Rows}</div>
    <div class="GROUP_MANAGER_GROUP_ITEM GROUP_MANAGER_GROUP_ITEM_DEFAULT d-flex justify-content-between align-items-center p-3 rounded bg-ghost">
      <span class="GROUP_MANAGER_GROUP_TITLE text-start">Default Group</span>
      <div class="d-flex align-items-center gap-2">
        <span class="badge bg-ghost-light text-light">${Members(null)}</span>
        <span class="text-muted text-sm">Locked</span>
      </div>
    </div>`;
  if (!Force && Html === RenderedListHtml) return;
  RenderedListHtml = Html;
  $List.html(Html);
}

function DragAfterElement(Container: HTMLElement, Y: number): Element | null {
  let Closest: { Offset: number; El: Element | null } = {
    Offset: Number.NEGATIVE_INFINITY,
    El: null,
  };
  for (const Child of Array.from(
    Container.querySelectorAll('.GROUP_MANAGER_GROUP_ITEM:not(.dragging)')
  )) {
    const Box = Child.getBoundingClientRect();
    const Offset = Y - Box.top - Box.height / 2;
    if (Offset < 0 && Offset > Closest.Offset) Closest = { Offset, El: Child };
  }
  return Closest.El;
}

function WireGroupList(): void {
  const $List = $('#GROUP_MANAGER_GROUP_LIST');
  $List.on(
    'dragstart',
    '.GROUP_MANAGER_GROUP_ITEM[draggable="true"]',
    function (this: HTMLElement, Event) {
      this.dataset.dragged = '';
      this.classList.add('dragging');
      this.dataset.dragged = '';
      const Transfer = (Event.originalEvent as DragEvent | undefined)?.dataTransfer;
      if (Transfer) {
        Transfer.effectAllowed = 'move';
        Transfer.setData('text/plain', this.getAttribute('data-groupid') || '');
      }
    }
  );
  $List.on('dragover', '#GROUP_MANAGER_SORTABLE_LIST', function (this: HTMLElement, Event) {
    Event.preventDefault();
    const Dragging = this.querySelector('.GROUP_MANAGER_GROUP_ITEM.dragging');
    if (!Dragging) return;
    const After = DragAfterElement(this, (Event.originalEvent as DragEvent).clientY);
    if (After) this.insertBefore(Dragging, After);
    else this.appendChild(Dragging);
  });
  $List.on('drop', '#GROUP_MANAGER_SORTABLE_LIST', (Event) => Event.preventDefault());
  $List.on('dragend', '.GROUP_MANAGER_GROUP_ITEM', async function (this: HTMLElement, Event) {
    this.classList.remove('dragging');
    this.dataset.dragged = '1';
    // Cancelled (Escape) or dropped outside the list: put the rows back.
    if ((Event.originalEvent as DragEvent | undefined)?.dataTransfer?.dropEffect === 'none') {
      RenderGroupList(true);
      return;
    }
    const Order = Array.from(
      document.querySelectorAll('#GROUP_MANAGER_SORTABLE_LIST .GROUP_MANAGER_GROUP_ITEM')
    )
      .map((El) => Number(El.getAttribute('data-groupid')))
      .filter((ID) => Number.isInteger(ID));
    if (Order.join(',') === Groups.map((G) => G.GroupID).join(',')) return;
    const [Err] = await window.API.ReorderGroups(Order);
    if (Err) void Notify(Err, 'error');
  });
  // The whole row opens the editor, except for the click that ends a drag.
  $List.on(
    'click',
    '.GROUP_MANAGER_GROUP_ITEM:not(.GROUP_MANAGER_GROUP_ITEM_DEFAULT)',
    function (this: HTMLElement) {
      if (this.dataset.dragged === '1') {
        this.dataset.dragged = '';
        return;
      }
      const ID = Number(this.getAttribute('data-groupid'));
      if (Number.isInteger(ID)) void OpenGroupEditor(ID);
    }
  );
  $('#GROUP_MANAGER_NEW_GROUP').on('click', () => void CreateGroupAndEdit());
}

export async function OpenGroupManager(): Promise<void> {
  if (Mode !== 'EDIT') {
    void Notify('Switch to Edit mode to manage groups.', 'info', 2500);
    return;
  }
  await CloseAllModals();
  RenderGroupList(true);
  openModal(MANAGER_ID);
}

/** Create a group and open its editor. */
export async function CreateGroupAndEdit(): Promise<void> {
  if (Mode !== 'EDIT') {
    void Notify('Switch to Edit mode to add groups.', 'info', 2500);
    return;
  }
  const [Err, Group] = await window.API.CreateGroup({ Title: 'New Group' });
  if (Err || !Group) {
    void Notify(Err || 'Failed to create the group.', 'error');
    return;
  }
  await OpenGroupEditor(Group.GroupID, Group, { FocusName: true });
}

// --- The editor ----------------------------------------------------------------

function RenderSwatches(Group: GroupView): void {
  const Container = document.getElementById('GROUP_MANAGER_EDITOR_COLOUR_SWATCHES');
  if (!Container) return;
  Container.innerHTML = '';
  const Options: Array<{ Index: number | null; Label: string; Hex: string | null }> = [
    { Index: null, Label: 'None', Hex: null },
    ...GROUP_COLOURS.map((C, Index) => ({ Index, Label: C.label, Hex: C.hex })),
  ];
  for (const Option of Options) {
    const Button = document.createElement('button');
    Button.type = 'button';
    Button.className =
      'script-manager-swatch' +
      (Option.Hex ? '' : ' group-colour-none') +
      (Option.Index === Group.Colour ? ' selected' : '');
    Button.title = Option.Label;
    Button.setAttribute('aria-label', `${Option.Label} tint`);
    if (Option.Hex) Button.style.background = Option.Hex;
    Button.addEventListener('click', async () => {
      if (Button.classList.contains('selected')) return;
      if (!(await Save({ Colour: Option.Index }))) return;
      Container.querySelectorAll('.script-manager-swatch').forEach((S) =>
        S.classList.remove('selected')
      );
      Button.classList.add('selected');
    });
    Container.appendChild(Button);
  }
}

function RenderMembers(GroupID: number, Force = false): void {
  const Members = CurrentTimers().filter((T) => T.GroupID === GroupID);
  const Html = Members.length
    ? Members.map(
        (
          T
        ) => `<div class="group-manager-member-row d-flex align-items-center justify-content-between gap-2">
            <span class="text-light text-truncate">${Safe(T.Name)}</span>
            <span class="d-flex align-items-center gap-2">
              <span class="text-muted text-sm">#${T.ID}</span>
              <button type="button" class="btn btn-sm group-manager-member-remove GROUP_MANAGER_MEMBER_REMOVE" data-timer-id="${T.ID}" title="Move to the Default group" aria-label="Move to the Default group"><i class="bi bi-dash-lg"></i></button>
            </span>
          </div>`
      ).join('')
    : '<div class="text-muted text-sm">No timers in this group.</div>';
  if (!Force && Html === RenderedMembersHtml) return;
  RenderedMembersHtml = Html;
  $('#GROUP_MANAGER_EDITOR_MEMBER_LIST').html(Html);
}

export async function OpenGroupEditor(
  GroupID: number,
  Known?: GroupView,
  Options: { FocusName?: boolean } = {}
): Promise<void> {
  const Group = Known ?? GroupByID(GroupID);
  if (!Group) {
    void Notify('Group not found.', 'error');
    return;
  }
  // Whatever is open closes first (Preferences, the list, this editor on
  // another group, whose rename still waiting is saved as it closes).
  await CloseAllModals();
  EditingGroupID = Group.GroupID;
  if (RenameTimer) clearTimeout(RenameTimer);
  RenameTimer = null;
  const Columns = ParseGroupColumnCount(SettingValue('UI_GROUP_COLUMN_COUNT'));
  $('#GROUP_MANAGER_EDITOR_NAME').val(Group.Title);
  $('#GROUP_MANAGER_EDITOR_SLUG').val(Group.Slug);
  $('#GROUP_MANAGER_EDITOR_OSC').text(`/ShowTrak/Group/${Group.Slug}/Start`);
  $('#GROUP_MANAGER_EDITOR_WIDTH')
    .html(
      BuildGroupWidthOptions(Group, Columns)
        .map((O) => `<option value="${Safe(O.Value)}">${Safe(O.Label)}</option>`)
        .join('')
    )
    .val(GetGroupWidthValue(Group));
  const Taken = new Map(
    Groups.filter((G) => G.KeyBind && G.GroupID !== Group.GroupID).map((G) => [G.KeyBind!, G.Title])
  );
  const KeyOption = (Code: string) =>
    `<option value="${Code}">${Safe(DescribeKeyBind(Code))}${Taken.has(Code) ? ` (${Safe(Taken.get(Code))})` : ''}</option>`;
  $('#GROUP_MANAGER_EDITOR_KEYBIND')
    .html(
      `<option value="">None</option>` +
        `<optgroup label="Keyboard">${GROUP_KEYBINDS.filter((K) => K.startsWith('Digit'))
          .map(KeyOption)
          .join('')}</optgroup>` +
        `<optgroup label="Numpad">${GROUP_KEYBINDS.filter((K) => K.startsWith('Numpad'))
          .map(KeyOption)
          .join('')}</optgroup>`
    )
    .val(Group.KeyBind ?? '');
  RenderSwatches(Group);
  RenderMembers(Group.GroupID, true);
  if (Options.FocusName) {
    // Once shown: Bootstrap moves the focus to the modal itself as it opens.
    $(`#${EDITOR_ID}`).one('shown.bs.modal', () => {
      $('#GROUP_MANAGER_EDITOR_NAME').trigger('focus').trigger('select');
    });
  }
  openModal(EDITOR_ID);
}

async function SaveName(NotifyProblems: boolean): Promise<void> {
  const Group = GroupByID(EditingGroupID);
  const Title = String($('#GROUP_MANAGER_EDITOR_NAME').val() ?? '').trim();
  if (!Group || Title === Group.Title) return;
  if (!Title) {
    if (NotifyProblems) {
      void Notify('A group name is required.', 'error');
      $('#GROUP_MANAGER_EDITOR_NAME').val(Group.Title);
    }
    return;
  }
  await Save({ Title });
}

function WireEditor(): void {
  $('#GROUP_MANAGER_EDITOR_NAME')
    .on('input', () => {
      if (RenameTimer) clearTimeout(RenameTimer);
      RenameTimer = setTimeout(() => {
        RenameTimer = null;
        void SaveName(false);
      }, 450);
    })
    .on('blur', () => {
      if (RenameTimer) clearTimeout(RenameTimer);
      RenameTimer = null;
      void SaveName(true);
    })
    .on('keydown', function (Event) {
      if (Event.key !== 'Enter') return;
      Event.preventDefault();
      this.blur();
    });

  // The slug never follows a rename (OSC senders would break): it is edited here.
  $('#GROUP_MANAGER_EDITOR_SLUG')
    .on('blur', async function () {
      const Group = GroupByID(EditingGroupID);
      if (!Group) return;
      const Slug = String($(this).val() ?? '').trim();
      if (!Slug || Slug === Group.Slug) {
        $(this).val(Group.Slug);
        return;
      }
      if (await Save({ Slug }, 'Group slug updated.')) {
        $('#GROUP_MANAGER_EDITOR_OSC').text(`/ShowTrak/Group/${Slug}/Start`);
      } else {
        $(this).val(Group.Slug);
      }
    })
    .on('keydown', function (Event) {
      if (Event.key !== 'Enter') return;
      Event.preventDefault();
      this.blur();
    });

  $('#GROUP_MANAGER_EDITOR_WIDTH').on('change', async function () {
    const Group = GroupByID(EditingGroupID);
    const Next = String($(this).val() || 'full');
    const Ok = await Save(
      { Width: Next === 'full' ? 'full' : Number(Next) },
      `Group set to ${Next === 'full' ? 'full width' : `${Next} column${Next === '1' ? '' : 's'}`}.`
    );
    if (!Ok && Group) $(this).val(GetGroupWidthValue(Group));
  });

  $('#GROUP_MANAGER_EDITOR_KEYBIND').on('change', async function () {
    const Group = GroupByID(EditingGroupID);
    const Next = String($(this).val() || '');
    const Ok = await Save(
      { KeyBind: Next || null },
      Next ? 'Group selection keybind updated.' : 'Group selection keybind cleared.'
    );
    if (!Ok && Group) $(this).val(Group.KeyBind ?? '');
  });

  $('#GROUP_MANAGER_EDITOR_MEMBER_LIST').on(
    'click',
    '.GROUP_MANAGER_MEMBER_REMOVE',
    async function (this: HTMLElement) {
      const ID = Number(this.getAttribute('data-timer-id'));
      if (!Number.isInteger(ID) || EditingGroupID === null) return;
      const [Err] = await window.API.MoveTimersToGroup([ID], null);
      if (Err) {
        void Notify(Err, 'error');
        return;
      }
      void Notify('Timer moved to the Default group.', 'success', 1800);
    }
  );

  $('#GROUP_MANAGER_EDITOR_DELETE').on('click', async () => {
    const Group = GroupByID(EditingGroupID);
    if (!Group) return;
    const Confirmed = await ConfirmationDialog(
      `Delete "${Group.Title}"? Its timers move to the Default group. This cannot be undone.`,
      { ConfirmLabel: 'Delete Group' }
    );
    // Still the group asked about, in the show it was asked about.
    if (Confirmed !== true || EditingGroupID !== Group.GroupID || !GroupByID(Group.GroupID)) {
      return;
    }
    const [Err] = await window.API.DeleteGroup(Group.GroupID);
    if (Err) {
      void Notify(`Failed to delete the group: ${Err}`, 'error');
      return;
    }
    EditingGroupID = null;
    closeModal(EDITOR_ID);
    void Notify('Group deleted.', 'success', 1800);
    await OpenGroupManager();
  });

  $('#GROUP_EDITOR_BACK').on('click', () => void OpenGroupManager());
}

/** Another show was loaded: close the editor, dropping a rename still waiting to save. */
export function DiscardGroupEditor(): void {
  if (RenameTimer) clearTimeout(RenameTimer);
  RenameTimer = null;
  EditingGroupID = null;
  closeModal(EDITOR_ID);
}

// Keep an open list or editor in step with pushes (another window, OSC, a drag).
function Refresh(): void {
  if ($(`#${MANAGER_ID}`).hasClass('show')) RenderGroupList();
  if ($(`#${EDITOR_ID}`).hasClass('show') && EditingGroupID !== null) {
    if (!GroupByID(EditingGroupID)) {
      closeModal(EDITOR_ID);
      return;
    }
    RenderMembers(EditingGroupID);
  }
}

export function InitGroupManager(): void {
  WireGroupList();
  WireEditor();
  window.API.OnGroups(() => Refresh());
  window.API.OnTimers(() => Refresh());
  // Leaving the editor saves a name still waiting on its debounce.
  $(`#${EDITOR_ID}`).on('hide.bs.modal', () => {
    if (RenameTimer) {
      clearTimeout(RenameTimer);
      RenameTimer = null;
      void SaveName(false);
    }
  });
}
