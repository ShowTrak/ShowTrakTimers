// The timer editor. Like ShowTrak Server's editors it saves as you go (fields
// debounce, toggles and dropdowns save at once) rather than having a Save
// button; the header's close button just closes it.
import {
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
  $('#TIMER_EDITOR_TYPE_HINT').text(TypeHint(Current.Type));
}

async function Save(Patch: TimerPatchView): Promise<boolean> {
  if (EditingID === null) return false;
  try {
    const [Err, Saved] = await window.API.UpdateTimer(EditingID, Patch);
    if (Err || !Saved) {
      void Notify(Err || 'Failed to save the timer.', 'error');
      return false;
    }
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
  $('#TIMER_EDITOR_DURATION').val(FormatDurationInput(Timer.Duration)).removeClass('is-invalid');
  $('#TIMER_EDITOR_SHOWONWEB').prop('checked', Timer.ShowOnWeb);
  $('#TIMER_EDITOR_HUNDREDTHS').prop('checked', Timer.ShowHundredths);
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
  $('#TIMER_EDITOR_SHOWONWEB').on('change', function () {
    void Save({ ShowOnWeb: $(this).is(':checked') });
  });
  $('#TIMER_EDITOR_HUNDREDTHS').on('change', function () {
    void Save({ ShowHundredths: $(this).is(':checked') });
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
  $(`#${MODAL_ID}`).on('click', '[data-sound-preview]', function () {
    const SelectID = this.getAttribute('data-sound-preview') || '';
    const Ref = String($(`#${SelectID}`).val() || '') || null;
    if (!Ref) {
      void Notify('Choose a sound to preview.', 'info', 1800);
      return;
    }
    void PreviewSoundRef(Ref);
  });

  $('#TIMER_EDITOR_DELETE').on('click', async () => {
    if (EditingID === null || !Current) return;
    const Confirmed = await ConfirmationDialog(`Delete "${Current.Name}"? This cannot be undone.`, {
      ConfirmLabel: 'Delete Timer',
    });
    if (!Confirmed || EditingID === null) return;
    Pending.forEach((Timer) => clearTimeout(Timer));
    Pending.clear();
    const [Err] = await window.API.DeleteTimer(EditingID);
    if (Err) {
      void Notify(Err, 'error');
      return;
    }
    closeModal(MODAL_ID);
    void Notify('Timer deleted.', 'success', 1500);
  });
}
