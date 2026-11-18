// The choices offered by a sound picker: none, the built-in sounds, then the
// imported library. A reference to a library sound that no longer exists stays
// selectable (marked missing) so opening an editor never silently changes it.
import { BUILTIN_SOUNDS, ParseSoundRef } from '../../../../common/sounds';
import type { LibrarySoundView } from '../../../../common/api';

export interface SoundOption {
  Value: string;
  Label: string;
  Group: 'none' | 'builtin' | 'library';
}

export function BuildSoundOptions(
  Library: readonly LibrarySoundView[],
  Selected: string | null
): SoundOption[] {
  const Options: SoundOption[] = [{ Value: '', Label: 'None', Group: 'none' }];
  for (const Sound of BUILTIN_SOUNDS) {
    Options.push({ Value: `builtin:${Sound.Name}`, Label: Sound.Label, Group: 'builtin' });
  }
  for (const Sound of Library) {
    Options.push({
      Value: `asset:${Sound.ID}`,
      Label: Sound.Missing ? `${Sound.Label} (missing)` : Sound.Label,
      Group: 'library',
    });
  }
  const Ref = ParseSoundRef(Selected);
  if (Ref && Ref.Kind === 'asset' && !Library.some((S) => S.ID === Ref.ID)) {
    Options.push({ Value: `asset:${Ref.ID}`, Label: 'Deleted sound', Group: 'library' });
  }
  return Options;
}

/** A label for a sound reference, as shown in summaries. */
export function SoundLabel(Ref: string | null, Library: readonly LibrarySoundView[]): string {
  const Parsed = ParseSoundRef(Ref);
  if (!Parsed) return 'None';
  if (Parsed.Kind === 'builtin') return Parsed.Sound.Label;
  return Library.find((S) => S.ID === Parsed.ID)?.Label ?? 'Deleted sound';
}
