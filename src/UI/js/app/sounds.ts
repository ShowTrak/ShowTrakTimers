// Alert sounds: playing a timer's warning/completion sound, previewing one, and
// the Sound Library modal (laid out like ShowTrak Server's Audio Assets).
import { ParseSoundRef } from '../../../common/sounds';
import { Sounds, setSounds } from './state';
import { GetAlertVolume, HandleNonFatalError, Safe } from './utils';
import { Notify, ConfirmationDialog } from './lib/toasts';
import { openModal } from './lib/modal';
import { CloseAllModals } from './modals';
import { BuildSoundOptions, FormatSoundSize } from './lib/sound-options';
import type { LibrarySoundView } from '../../../common/api';

// The built-in sounds: AAC first (small), WAV as the fallback for a browser that
// cannot play AAC. Howler plays the first source it can.
const BUILTIN_SOURCES: Record<string, string[]> = {
  alert_1: ['audio/alert_1.m4a', 'audio/alert_1.wav'],
  alert_2: ['audio/alert_2.m4a', 'audio/alert_2.wav'],
  alert_3: ['audio/alert_3.m4a', 'audio/alert_3.wav'],
};
const FALLBACK_SOUND = 'alert_1';

const BuiltinHowls: Record<string, Howl> = {};
// Imported sounds, by ID, with the volume they were loaded at.
const AssetHowls = new Map<string, { Howl: Howl; Volume: number }>();
let PreviewHowl: Howl | null = null;

function Builtin(Name: string): Howl | null {
  if (typeof Howl === 'undefined') return null;
  const Src = BUILTIN_SOURCES[Name] ?? BUILTIN_SOURCES[FALLBACK_SOUND]!;
  BuiltinHowls[Name] ??= new Howl({ src: Src, preload: false });
  return BuiltinHowls[Name]!;
}

async function Asset(ID: string): Promise<{ Howl: Howl; Volume: number } | null> {
  if (typeof Howl === 'undefined') return null;
  const Cached = AssetHowls.get(ID);
  if (Cached) return Cached;
  const [Err, Data] = await window.API.GetSoundData(ID);
  if (Err || !Data) return null;
  const Entry = { Howl: new Howl({ src: [Data.DataURL] }), Volume: Data.Volume / 100 };
  AssetHowls.set(ID, Entry);
  return Entry;
}

// Resolve a sound reference to something playable. An imported sound that has
// gone (deleted, file missing) falls back to the built-in chime: an alert the
// operator asked for is never silently dropped.
async function Resolve(Ref: string | null): Promise<{ Howl: Howl; Volume: number } | null> {
  const Parsed = ParseSoundRef(Ref);
  if (!Parsed) return null;
  if (Parsed.Kind === 'asset') {
    const Found = await Asset(Parsed.ID);
    if (Found) return Found;
    const Fallback = Builtin(FALLBACK_SOUND);
    return Fallback ? { Howl: Fallback, Volume: 1 } : null;
  }
  const Sound = Builtin(Parsed.Sound.Name);
  return Sound ? { Howl: Sound, Volume: 1 } : null;
}

function Play(Entry: { Howl: Howl; Volume: number }): Howl {
  const { Howl: Sound, Volume } = Entry;
  if (Sound.state() === 'unloaded') Sound.load();
  Sound.volume(Math.min(1, GetAlertVolume() * Volume));
  Sound.play();
  return Sound;
}

/** Play a timer's sound (warning or completion). */
export async function PlaySoundRef(Ref: string | null): Promise<void> {
  try {
    const Entry = await Resolve(Ref);
    if (Entry) Play(Entry);
  } catch (Err) {
    HandleNonFatalError('Sounds:Play', Err);
  }
}

/** Preview a sound from a picker; a second preview stops the first. */
export async function PreviewSoundRef(Ref: string | null): Promise<void> {
  try {
    PreviewHowl?.stop();
    PreviewHowl = null;
    const Entry = await Resolve(Ref);
    if (Entry) PreviewHowl = Play(Entry);
  } catch (Err) {
    HandleNonFatalError('Sounds:Preview', Err);
  }
}

/** Fill a <select> with the sound choices, keeping `Selected` selected. */
export function FillSoundSelect($Select: JQuery<HTMLElement>, Selected: string | null): void {
  const Options = BuildSoundOptions(Sounds, Selected);
  const Group = (Name: SoundOptionGroup, Label: string) => {
    const Items = Options.filter((O) => O.Group === Name);
    if (!Items.length) return '';
    const Html = Items.map(
      (O) => `<option value="${Safe(O.Value)}">${Safe(O.Label)}</option>`
    ).join('');
    return Label ? `<optgroup label="${Safe(Label)}">${Html}</optgroup>` : Html;
  };
  $Select.html(
    Group('none', '') + Group('builtin', 'Built-in') + Group('library', 'Sound Library')
  );
  $Select.val(Selected ?? '');
}
type SoundOptionGroup = 'none' | 'builtin' | 'library';

// --- Sound Library modal ----------------------------------------------------

const LabelTimers = new Map<string, ReturnType<typeof setTimeout>>();
const VolumeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function RenderSoundLibrary(): void {
  const $Host = $('#SOUND_LIBRARY_LIST');
  if (!$Host.length) return;
  if (!Sounds.length) {
    $Host.html(
      '<div class="rounded bg-ghost p-2 text-center text-muted">No sounds yet. Use “Import a Sound” to add one.</div>'
    );
    return;
  }
  $Host.html(
    Sounds.map((Sound: LibrarySoundView) => {
      const Meta = [Sound.Extension.toUpperCase(), FormatSoundSize(Sound.Size)].join(' · ');
      const Missing = Sound.Missing
        ? '<span class="badge bg-warning text-dark ms-2" title="The sound file is missing">Missing</span>'
        : '';
      return `
      <div class="audio-asset-row rounded bg-ghost p-2 text-start" data-sound-id="${Safe(Sound.ID)}">
        <input type="text" class="form-control form-control-sm audio-asset-label-inline" data-sound-label
          value="${Safe(Sound.Label)}" maxlength="40" placeholder="Label" />
        <div class="text-sm text-muted text-truncate audio-asset-meta" title="${Safe(Sound.OriginalName)}">
          ${Safe(Meta)}${Missing}
        </div>
        <div class="d-flex align-items-center gap-2 audio-asset-volume-wrap">
          <i class="bi bi-volume-down text-muted" aria-hidden="true"></i>
          <input type="range" class="form-range flex-grow-1" min="0" max="100" step="1"
            value="${Math.min(100, Sound.Volume)}" data-sound-volume />
          <span class="text-sm" data-sound-volume-label>${Math.min(100, Sound.Volume)}%</span>
        </div>
        <div class="d-flex gap-1 flex-shrink-0 audio-asset-actions">
          <button type="button" class="btn btn-sm bg-ghost-light text-white" data-sound-play title="Preview" ${
            Sound.Missing ? 'disabled' : ''
          }><i class="bi bi-play"></i></button>
          <button type="button" class="btn btn-sm btn-delete" data-sound-delete title="Delete sound">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </div>`;
    }).join('')
  );
}

function WireSoundLibrary(): void {
  const $Host = $('#SOUND_LIBRARY_LIST');
  const RowID = (El: Element) => $(El).closest('[data-sound-id]').attr('data-sound-id') || '';

  $Host.on('input', '[data-sound-label]', function () {
    const ID = RowID(this);
    const Label = String($(this).val() ?? '');
    clearTimeout(LabelTimers.get(ID));
    LabelTimers.set(
      ID,
      setTimeout(async () => {
        LabelTimers.delete(ID);
        const [Err] = await window.API.UpdateSound(ID, { Label });
        if (Err) void Notify(Err, 'error');
      }, 600)
    );
  });

  $Host.on('input', '[data-sound-volume]', function () {
    const ID = RowID(this);
    const Volume = Number($(this).val());
    $(this).closest('[data-sound-id]').find('[data-sound-volume-label]').text(`${Volume}%`);
    clearTimeout(VolumeTimers.get(ID));
    VolumeTimers.set(
      ID,
      setTimeout(async () => {
        VolumeTimers.delete(ID);
        AssetHowls.delete(ID);
        const [Err] = await window.API.UpdateSound(ID, { Volume });
        if (Err) void Notify(Err, 'error');
      }, 400)
    );
  });

  $Host.on('click', '[data-sound-play]', function () {
    void PreviewSoundRef(`asset:${RowID(this)}`);
  });

  $Host.on('click', '[data-sound-delete]', async function () {
    const ID = RowID(this);
    const Sound = Sounds.find((S) => S.ID === ID);
    const Confirmed = await ConfirmationDialog(
      `Delete the sound "${Sound?.Label ?? 'Sound'}"? Timers using it will play the built-in chime instead.`,
      { ConfirmLabel: 'Delete Sound' }
    );
    if (!Confirmed) return;
    const [Err] = await window.API.DeleteSound(ID);
    if (Err) void Notify(Err, 'error');
    else AssetHowls.delete(ID);
  });

  $('#SOUND_LIBRARY_IMPORT').on('click', async () => {
    const [Err, Sound] = await window.API.ImportSound();
    if (Err) void Notify(Err, 'error');
    else if (Sound) void Notify(`Imported ${Sound.Label}.`, 'success', 2000);
  });
}

export async function OpenSoundLibrary(): Promise<void> {
  await CloseAllModals();
  RenderSoundLibrary();
  openModal('SHOWTRAK_MODAL_SOUND_LIBRARY');
}

export function ApplySounds(List: LibrarySoundView[]): void {
  setSounds(List);
  // Labels/volumes may have changed: drop cached players so they reload.
  AssetHowls.clear();
  // Don't redraw under someone typing a label.
  const Active = document.activeElement;
  if (!(Active instanceof HTMLInputElement && Active.closest('#SOUND_LIBRARY_LIST'))) {
    RenderSoundLibrary();
  }
}

export function InitSounds(): void {
  WireSoundLibrary();
  window.API.OnSounds((List) => ApplySounds(List));
}
