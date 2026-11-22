// AudioLibrary: sounds imported by the operator for timer warnings and
// completions. A port of ShowTrak Server's AudioAssetManager: the files are
// copied into the app data Audio folder (so they survive the original being
// moved) and described by a manifest.json beside them. The renderer plays them
// from data URLs, which its Content-Security-Policy allows.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CreateLogger } from '../Logger';
import { Manager as AppData } from '../AppData';
import { WriteAndSyncFileSync } from '../Utils';
import { IsArray, IsRecord } from '../../common/guards';

const Logger = CreateLogger('AudioLibrary');

export type Result<T> = [string | null, T | null];

interface StoredSound {
  ID: string;
  Label: string;
  FileName: string;
  OriginalName: string;
  Extension: string;
  Volume: number;
  Size: number;
  Timestamp: number;
}

/** A sound as shown to the renderer (no file name; flags a missing file). */
export interface LibrarySound {
  ID: string;
  Label: string;
  OriginalName: string;
  Extension: string;
  Volume: number;
  Size: number;
  Timestamp: number;
  Missing: boolean;
}

export interface SoundData {
  ID: string;
  Label: string;
  Volume: number;
  DataURL: string;
}

export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
export const MAX_LABEL_LENGTH = 40;
export const ALLOWED_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'];

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
};

// The file name Import gives a sound: its id and its extension.
const STORED_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\.[a-z0-9]{1,8}$/;

// A manifest entry worth keeping. The manifest is this library's own file, so
// beyond the id and file name its entries are taken as written.
function IsStoredSound(Value: unknown): Value is StoredSound {
  return (
    IsRecord(Value) &&
    typeof Value.ID === 'string' &&
    typeof Value.FileName === 'string' &&
    // Only names this library writes ("<id>.<ext>"): a manifest entry
    // can never point out of the folder, or at the folder itself.
    STORED_FILE_NAME.test(Value.FileName)
  );
}

export function SanitizeLabel(Input: unknown): string {
  const Cleaned = String(Input ?? '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LENGTH)
    .trim();
  return Cleaned || 'Sound';
}

export function ClampVolume(Value: unknown): number {
  const Num = Number(Value);
  if (!Number.isFinite(Num)) return 100;
  return Math.min(200, Math.max(0, Math.round(Num)));
}

function ExtensionOf(Name: unknown): string {
  const Base = String(Name ?? '');
  const Dot = Base.lastIndexOf('.');
  return Dot === -1 ? '' : Base.slice(Dot + 1).toLowerCase();
}

// Best-effort magic-byte sniff so an obviously non-audio file is rejected even
// when it has an audio extension.
export function LooksLikeAudio(Header: Buffer | null): boolean {
  if (!Header || Header.length < 4) return false;
  const Ascii = (Start: number, Length: number) =>
    Header.subarray(Start, Start + Length).toString('latin1');
  if (Ascii(0, 4) === 'RIFF' && Header.length >= 12 && Ascii(8, 4) === 'WAVE') return true;
  if (Ascii(0, 4) === 'OggS') return true;
  if (Ascii(0, 4) === 'fLaC') return true;
  if (Ascii(0, 3) === 'ID3') return true;
  if (Header.length >= 8 && Ascii(4, 4) === 'ftyp') return true;
  // MPEG/ADTS frame sync: MP3 without a tag, raw AAC.
  return Header[0] === 0xff && ((Header[1] ?? 0) & 0xe0) === 0xe0;
}

function ReadHeader(FilePath: string): Buffer | null {
  let Handle: number | undefined;
  try {
    Handle = fs.openSync(FilePath, 'r');
    const Header = Buffer.alloc(16);
    const Read = fs.readSync(Handle, Header, 0, 16, 0);
    return Header.subarray(0, Read);
  } catch {
    return null;
  } finally {
    if (Handle !== undefined) fs.closeSync(Handle);
  }
}

export function CreateAudioLibrary(Directory: () => string = () => AppData.GetAudioDirectory()) {
  let Sounds: StoredSound[] = [];
  let Loaded = false;

  const ManifestPath = () => path.join(Directory(), 'manifest.json');
  const FilePathOf = (Sound: StoredSound) => path.join(Directory(), Sound.FileName);
  const FileExists = (Sound: StoredSound) => fs.existsSync(FilePathOf(Sound));

  function Load(): void {
    if (Loaded) return;
    fs.mkdirSync(Directory(), { recursive: true });
    try {
      const Parsed: unknown = JSON.parse(fs.readFileSync(ManifestPath(), 'utf8'));
      Sounds = IsArray(Parsed) ? Parsed.filter(IsStoredSound) : [];
    } catch (Err) {
      if ((Err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        Logger.error('Failed to read the sound library manifest; starting empty', Err);
      }
      Sounds = [];
    }
    Loaded = true;
  }

  function Save(): boolean {
    try {
      fs.mkdirSync(Directory(), { recursive: true });
      // Write then rename, so a crash mid-write never leaves a torn manifest.
      const Temp = `${ManifestPath()}.tmp`;
      WriteAndSyncFileSync(Temp, JSON.stringify(Sounds, null, 2));
      fs.renameSync(Temp, ManifestPath());
      return true;
    } catch (Err) {
      Logger.error('Failed to save the sound library manifest', Err);
      return false;
    }
  }

  const Public = (Sound: StoredSound): LibrarySound => ({
    ID: Sound.ID,
    Label: Sound.Label,
    OriginalName: Sound.OriginalName || '',
    Extension: Sound.Extension,
    Volume: ClampVolume(Sound.Volume),
    Size: Sound.Size || 0,
    Timestamp: Sound.Timestamp || 0,
    Missing: !FileExists(Sound),
  });

  /** Why a file cannot be imported, or null when it can. */
  function Inspect(SourcePath: string): string | null {
    const Extension = ExtensionOf(path.basename(SourcePath));
    if (!ALLOWED_EXTENSIONS.includes(Extension)) {
      return `Unsupported file type: .${Extension || '?'}`;
    }
    let Stat: fs.Stats;
    try {
      Stat = fs.statSync(SourcePath);
    } catch {
      return 'The file could not be read.';
    }
    if (!Stat.isFile()) return 'Not a file.';
    if (Stat.size === 0) return 'The file is empty.';
    if (Stat.size > MAX_FILE_SIZE_BYTES) {
      return `The file is too large (the limit is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB).`;
    }
    if (!LooksLikeAudio(ReadHeader(SourcePath))) {
      return 'The file does not look like an audio file.';
    }
    return null;
  }

  const Library = {
    List(): LibrarySound[] {
      Load();
      return Sounds.map(Public);
    },

    Exists(ID: string): boolean {
      Load();
      const Sound = Sounds.find((S) => S.ID === ID);
      return !!Sound && FileExists(Sound);
    },

    Inspect,

    Import(SourcePath: unknown, Label?: unknown): Result<LibrarySound> {
      Load();
      const Source = String(SourcePath ?? '');
      if (!Source) return ['No file was chosen.', null];
      const Problem = Inspect(Source);
      if (Problem) return [Problem, null];

      const Extension = ExtensionOf(path.basename(Source));
      const ID = crypto.randomUUID();
      const FileName = `${ID}.${Extension}`;
      try {
        fs.copyFileSync(Source, path.join(Directory(), FileName));
      } catch (Err) {
        Logger.error('Failed to copy a sound into the library', Err);
        return ['The sound could not be saved.', null];
      }
      const OriginalName = path.basename(Source);
      const Sound: StoredSound = {
        ID,
        Label: SanitizeLabel(Label ?? OriginalName.replace(/\.[^.]+$/, '')),
        FileName,
        OriginalName,
        Extension,
        Volume: 100,
        Size: fs.statSync(Source).size,
        Timestamp: Date.now(),
      };
      Sounds.push(Sound);
      if (!Save()) {
        Sounds = Sounds.filter((S) => S.ID !== ID);
        fs.rmSync(path.join(Directory(), FileName), { force: true });
        return ['The sound could not be saved.', null];
      }
      Logger.log(`Imported sound ${Sound.Label} (${ID})`);
      return [null, Public(Sound)];
    },

    Update(ID: unknown, Patch: { Label?: unknown; Volume?: unknown }): Result<LibrarySound> {
      Load();
      const Sound = Sounds.find((S) => S.ID === ID);
      if (!Sound) return ['Sound not found.', null];
      const Before = { ...Sound };
      if (Patch && Patch.Label !== undefined) Sound.Label = SanitizeLabel(Patch.Label);
      if (Patch && Patch.Volume !== undefined) Sound.Volume = ClampVolume(Patch.Volume);
      if (!Save()) {
        Object.assign(Sound, Before);
        return ['The sound could not be saved.', null];
      }
      return [null, Public(Sound)];
    },

    Delete(ID: unknown): Result<true> {
      Load();
      const Sound = Sounds.find((S) => S.ID === ID);
      if (!Sound) return ['Sound not found.', null];
      Sounds = Sounds.filter((S) => S !== Sound);
      if (!Save()) {
        Sounds.push(Sound);
        return ['The sound could not be deleted.', null];
      }
      fs.rmSync(FilePathOf(Sound), { force: true });
      Logger.log(`Deleted sound ${Sound.Label} (${Sound.ID})`);
      return [null, true];
    },

    GetData(ID: unknown): Result<SoundData> {
      Load();
      const Sound = Sounds.find((S) => S.ID === ID);
      if (!Sound) return ['Sound not found.', null];
      try {
        const Data = fs.readFileSync(FilePathOf(Sound));
        const Mime = MIME_BY_EXTENSION[Sound.Extension] || 'application/octet-stream';
        return [
          null,
          {
            ID: Sound.ID,
            Label: Sound.Label,
            Volume: ClampVolume(Sound.Volume),
            DataURL: `data:${Mime};base64,${Data.toString('base64')}`,
          },
        ];
      } catch {
        return ['The sound file is missing.', null];
      }
    },
  };

  return Library;
}

export type AudioLibrary = ReturnType<typeof CreateAudioLibrary>;

export const Manager: AudioLibrary = CreateAudioLibrary();
