// The timer editor. Like ShowTrak Server's editors it saves as you go (fields
// debounce, toggles and dropdowns save at once) rather than having a Save
// button; the header's close button just closes it.
import {
  CLOCK_FORMATS,
  CLOCK_FORMAT_LABELS,
  END_BEHAVIOURS,
  END_BEHAVIOUR_LABELS,
  FormatDurationInput,
  ParseDuration,
  type TimerView,
} from '../../../common/timers';
import { buildModalHeader } from './lib/modal-header';
import { closeModal, openModal } from './lib/modal';
import { ConfirmationDialog, Notify } from './lib/toasts';
import { CloseAllModals } from './modals';
import { FillSoundSelect, PreviewSoundRef } from './sounds';
import { HandleNonFatalError, Safe } from './utils';
import type { TimerPatchView } from '../../../common/api';
import { EditorFieldVisibility, TypeHint } from './lib/timer-editor-model';
import { Groups } from './state';
import { DEFAULT_GROUP_TITLE, EffectiveGroupID } from '../../../common/groups';

// The Group select: every group, then the Default group ('' as its value).
function FillGroupSelect(GroupID: number | null): void {
  const Known = new Set(Groups.map((G) => G.GroupID));
  const Current = EffectiveGroupID(GroupID, Known);
  $('#TIMER_EDITOR_GROUP')
    .html(
      Groups.map((G) => `<option value="${G.GroupID}">${Safe(G.Title)}</option>`).join('') +
        `<option value="">${Safe(DEFAULT_GROUP_TITLE)}</option>`
    )
    .val(Current === null ? '' : String(Current));
}

// Keep the select's options in step with the groups while the editor is open.
export function RefreshEditorGroups(): void {
  if (!Current || !$(`#${MODAL_ID}`).hasClass('show')) return;
  FillGroupSelect(Current.GroupID);
}

const MODAL_ID = 'SHOWTRAK_MODAL_TIMER_EDITOR';
const FIELD_DEBOUNCE_MS = 600;

let EditingID: number | null = null;
let Current: TimerView | null = null;
let SetTitle: ((Title: string) => void) | null = null;
const Pending = new Map<string, ReturnType<typeof setTimeout>>();

function ApplyVisibility(): void {
  if (!Current) return;
  const Visible = EditorFieldVisibility(Current);
  $(`#${MODAL_ID} [data-timer-field="duration"]`).toggleClass('d-none', !Visible.Duration);
  $(`#${MODAL_ID} [data-timer-field="ending"]`).toggleClass('d-none', !Visible.Ending);
  $(`#${MODAL_ID} [data-timer-field="warning"]`).toggleClass('d-none', !Visible.Warning);
  $(`#${MODAL_ID} [data-timer-field="clock"]`).toggleClass('d-none', !Visible.Clock);
  $('#TIMER_EDITOR_TYPE_HINT').text(TypeHint(Current.Type));
}

async function Save(Patch: TimerPatchView): Promise<boolean> {
  const ID = EditingID;
  if (ID === null) return false;
  try {
    const [Err, Saved] = await window.API.UpdateTimer(ID, Patch);
    if (Err || !Saved) {
      void Notify(Err || 'Failed to save the timer.', 'error');
      return false;
    }
    // The editor may have moved on to another timer while this saved.
    if (EditingID !== ID) return true;
    Current = Saved;
    SetTitle?.(Saved.Name);
    ApplyVisibility();
    return true;
  } catch (Err) {
    HandleNonFatalError('TimerEditor:Save', Err);
    return false;
  }
}

function Debounced(Key: string, Fn: () => void): void {
  clearTimeout(Pending.get(Key));
  Pending.set(
    Key,
    setTimeout(() => {
      Pending.delete(Key);
      Fn();
    }, FIELD_DEBOUNCE_MS)
  );
}

// Run any pending field saves now (on close), so nothing typed is lost.
function FlushPending(): void {
  for (const [Key, Timer] of Pending) {
    clearTimeout(Timer);
    Pending.delete(Key);
    Flushers[Key]?.();
  }
}

const Flushers: Record<string, () => void> = {
  name: () => {
    const Name = String($('#TIMER_EDITOR_NAME').val() ?? '').trim();
    if (Name && Current && Name !== Current.Name) void Save({ Name });
  },
  duration: () => SaveDurationField('#TIMER_EDITOR_DURATION', 'Duration'),
  warning: () => SaveDurationField('#TIMER_EDITOR_WARNING', 'WarningMs'),
};

function SaveDurationField(Selector: string, Field: 'Duration' | 'WarningMs'): void {
  if (!Current) return;
  const $Input = $(Selector);
  const Raw = String($Input.val() ?? '').trim();
  const Ms = Raw === '' ? null : ParseDuration(Raw);
  const Invalid = Raw !== '' && Ms === null;
  $Input.toggleClass('is-invalid', Invalid);
  if (Invalid) return;
  if (Field === 'Duration' && Ms === null && Current.Type === 'COUNTDOWN') {
    $Input.addClass('is-invalid');
    void Notify('A countdown needs a duration.', 'error');
    return;
  }
  if (Field === 'WarningMs' && Ms === 0) {
    void Save({ WarningMs: null });
    return;
  }
  if (Ms === Current[Field]) return;
  void Save({ [Field]: Ms } as TimerPatchView);
}

function Populate(Timer: TimerView): void {
  $('#TIMER_EDITOR_ID').text(`Timer ID ${Timer.ID} (used in OSC addresses)`);
  $('#TIMER_EDITOR_NAME').val(Timer.Name);
  $('#TIMER_EDITOR_TYPE').val(Timer.Type);
  FillGroupSelect(Timer.GroupID);
  $('#TIMER_EDITOR_DURATION').val(FormatDurationInput(Timer.Duration)).removeClass('is-invalid');
  $('#TIMER_EDITOR_SHOWONWEB').prop('checked', Timer.ShowOnWeb);
  $('#TIMER_EDITOR_HUNDREDTHS').prop('checked', Timer.ShowHundredths);
  $('#TIMER_EDITOR_CLOCK_FORMAT')
    .html(
      CLOCK_FORMATS.map(
        (Value) => `<option value="${Value}">${Safe(CLOCK_FORMAT_LABELS[Value])}</option>`
      ).join('')
    )
    .val(Timer.ClockFormat);
  $('#TIMER_EDITOR_END_BEHAVIOUR').html(
    END_BEHAVIOURS.map(
      (Value) => `<option value="${Value}">${Safe(END_BEHAVIOUR_LABELS[Value])}</option>`
    ).join('')
  );
  $('#TIMER_EDITOR_END_BEHAVIOUR').val(Timer.EndBehaviour);
  FillSoundSelect($('#TIMER_EDITOR_COMPLETION_SOUND'), Timer.CompletionSound);
  $('#TIMER_EDITOR_COMPLETION_TOAST').prop('checked', Timer.CompletionToast);
  $('#TIMER_EDITOR_WARNING').val(FormatDurationInput(Timer.WarningMs)).removeClass('is-invalid');
  FillSoundSelect($('#TIMER_EDITOR_WARNING_SOUND'), Timer.WarningSound);
  $('#TIMER_EDITOR_WARNING_TOAST').prop('checked', Timer.WarningToast);
  ApplyVisibility();
}

// The editable fields a push can bring in from elsewhere (OSC, another editor).
const SYNCED_FIELDS = [
  'Name',
  'Type',
  'GroupID',
  'Duration',
  'ShowOnWeb',
  'ShowHundredths',
  'ClockFormat',
  'EndBehaviour',
  'CompletionSound',
  'CompletionToast',
  'WarningMs',
  'WarningSound',
  'WarningToast',
] as const;

/**
 * The open timer changed elsewhere (an OSC SetLabel, a drag to another group):
 * show the new values, except in a field being typed in or still waiting to
 * save, so nothing the operator is typing is overwritten.
 */
function SyncFromPush(Timers: readonly TimerView[]): void {
  if (!Current || EditingID === null || !$(`#${MODAL_ID}`).hasClass('show')) return;
  const Pushed = Timers.find((T) => T.ID === EditingID);
  if (!Pushed || SYNCED_FIELDS.every((Key) => Pushed[Key] === Current![Key])) return;
  const Busy = new Set<string>();
  const Focused = document.activeElement;
  if (Pending.has('name') || Focused?.id === 'TIMER_EDITOR_NAME') Busy.add('TIMER_EDITOR_NAME');
  if (Pending.has('duration') || Focused?.id === 'TIMER_EDITOR_DURATION') {
    Busy.add('TIMER_EDITOR_DURATION');
  }
  if (Pending.has('warning') || Focused?.id === 'TIMER_EDITOR_WARNING') {
    Busy.add('TIMER_EDITOR_WARNING');
  }
  const Kept = new Map<string, unknown>();
  for (const ID of Busy) Kept.set(ID, $(`#${ID}`).val());
  Current = Pushed;
  SetTitle?.(Pushed.Name);
  Populate(Pushed);
  for (const [ID, Value] of Kept) $(`#${ID}`).val(Value as string);
}

/**
 * Another show was loaded: close the editor without saving what is pending,
 * which belongs to a timer of the old show (the same ID may be another timer now).
 */
export function DiscardTimerEditor(): void {
  for (const Timer of Pending.values()) clearTimeout(Timer);
  Pending.clear();
  EditingID = null;
  Current = null;
  closeModal(MODAL_ID);
}

// Re-fill the sound pickers when the Sound Library changes while open.
export function RefreshEditorSounds(): void {
  if (!Current || !$(`#${MODAL_ID}`).hasClass('show')) return;
  FillSoundSelect($('#TIMER_EDITOR_COMPLETION_SOUND'), Current.CompletionSound);
  FillSoundSelect($('#TIMER_EDITOR_WARNING_SOUND'), Current.WarningSound);
}

export async function OpenTimerEditor(
  ID: number,
  Options: { IsNew?: boolean } = {}
): Promise<void> {
  const [Err, Timer] = await window.API.GetTimer(ID);
  if (Err || !Timer) {
    void Notify(Err || 'Timer not found.', 'error');
    return;
  }
  await CloseAllModals();
  EditingID = ID;
  Current = Timer;
  SetTitle?.(Timer.Name);
  Populate(Timer);
  openModal(MODAL_ID);
  if (Options.IsNew) {
    $(`#${MODAL_ID}`).one('shown.bs.modal', () => {
      const Input = document.getElementById('TIMER_EDITOR_NAME') as HTMLInputElement | null;
      Input?.focus();
      Input?.select();
    });
  }
}

export function InitTimerEditor(): void {
  const Header = buildModalHeader({
    title: 'Edit Timer',
    titleId: 'TIMER_EDITOR_TITLE',
    onClose: () => closeModal(MODAL_ID),
  });
  SetTitle = Header.setTitle;
  $('#TIMER_EDITOR_HEADER').empty().append(Header.$el);
  window.API.OnGroups(() => RefreshEditorGroups());

  $(`#${MODAL_ID}`).on('hide.bs.modal', () => FlushPending());
  $(`#${MODAL_ID}`).on('hidden.bs.modal', () => {
    EditingID = null;
    Current = null;
  });

  $('#TIMER_EDITOR_NAME').on('input', () => Debounced('name', Flushers.name!));
  $('#TIMER_EDITOR_NAME').on('keydown', (Event) => {
    if (Event.key === 'Enter') FlushPending();
  });
  $('#TIMER_EDITOR_DURATION').on('input', () => Debounced('duration', Flushers.duration!));
  $('#TIMER_EDITOR_WARNING').on('input', () => Debounced('warning', Flushers.warning!));
  $('#TIMER_EDITOR_DURATION, #TIMER_EDITOR_WARNING').on('blur', () => FlushPending());

  $('#TIMER_EDITOR_TYPE').on('change', function () {
    const Type = String($(this).val()) as TimerView['Type'];
    void Save({ Type }).then(() => {
      if (Current) $('#TIMER_EDITOR_DURATION').val(FormatDurationInput(Current.Duration));
    });
  });
  $('#TIMER_EDITOR_GROUP').on('change', function () {
    const Value = String($(this).val() ?? '');
    void Save({ GroupID: Value === '' ? null : Number(Value) });
  });
  $('#TIMER_EDITOR_SHOWONWEB').on('change', function () {
    void Save({ ShowOnWeb: $(this).is(':checked') });
  });
  $('#TIMER_EDITOR_HUNDREDTHS').on('change', function () {
    void Save({ ShowHundredths: $(this).is(':checked') });
  });
  $('#TIMER_EDITOR_CLOCK_FORMAT').on('change', function () {
    void Save({ ClockFormat: String($(this).val()) as TimerView['ClockFormat'] });
  });
  $('#TIMER_EDITOR_END_BEHAVIOUR').on('change', function () {
    void Save({ EndBehaviour: String($(this).val()) as TimerView['EndBehaviour'] });
  });
  $('#TIMER_EDITOR_COMPLETION_SOUND').on('change', function () {
    void Save({ CompletionSound: String($(this).val() || '') || null });
  });
  $('#TIMER_EDITOR_WARNING_SOUND').on('change', function () {
    void Save({ WarningSound: String($(this).val() || '') || null });
  });
  $('#TIMER_EDITOR_COMPLETION_TOAST').on('change', function () {
    void Save({ CompletionToast: $(this).is(':checked') });
  });
  $('#TIMER_EDITOR_WARNING_TOAST').on('change', function () {
    void Save({ WarningToast: $(this).is(':checked') });
  });
  $(`#${MODAL_ID}`).on('click', '[data-sound-preview]', function (this: HTMLElement) {
    const SelectID = this.getAttribute('data-sound-preview') || '';
    const Ref = String($(`#${SelectID}`).val() || '') || null;
    if (!Ref) {
      void Notify('Choose a sound to preview.', 'info', 1800);
      return;
    }
    void PreviewSoundRef(Ref);
  });

  window.API.OnTimers((Timers) => SyncFromPush(Timers));

  $('#TIMER_EDITOR_DELETE').on('click', async () => {
    // The timer asked about, whatever the editor shows by the time it is answered.
    const ID = EditingID;
    if (ID === null || !Current) return;
    const Confirmed = await ConfirmationDialog(`Delete "${Current.Name}"? This cannot be undone.`, {
      ConfirmLabel: 'Delete Timer',
    });
    if (Confirmed !== true || EditingID !== ID) return;
    Pending.forEach((Timer) => clearTimeout(Timer));
    Pending.clear();
    const [Err] = await window.API.DeleteTimer(ID);
    if (Err) {
      void Notify(Err, 'error');
      return;
    }
    closeModal(MODAL_ID);
    void Notify('Timer deleted.', 'success', 1500);
  });
}
