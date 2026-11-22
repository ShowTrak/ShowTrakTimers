// Small helpers shared by the main-process modules.
import fs from 'fs';
import path from 'path';

export function Wait(Ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Ms));
}

// Order two version strings: negative when A is older than B, positive when
// newer, 0 when equal. Lenient on purpose, because Squirrel rewrites
// "2.0.0-beta.1" as "2.0.0-beta1" and the strict semver comparison in
// @showtrak/protocol/runtime would not parse that. Both spellings order the same:
// the numeric parts of the version core first, then a release outranks its own
// pre-releases, and pre-release parts compare number-to-number ("beta2" after
// "beta1", "beta10" after "beta9") or text-to-text.
export function CompareVersions(A: string, B: string): number {
  const Split = (Version: string) => {
    const Text = String(Version || '')
      .trim()
      .replace(/^v/i, '');
    const Dash = Text.indexOf('-');
    const Core = (Dash === -1 ? Text : Text.slice(0, Dash))
      .split('.')
      .map((N) => parseInt(N, 10) || 0);
    const Pre = Dash === -1 ? [] : (Text.slice(Dash + 1).match(/\d+|[A-Za-z]+/g) ?? []);
    return { Core, Pre };
  };
  const PA = Split(A);
  const PB = Split(B);
  for (let I = 0; I < Math.max(PA.Core.length, PB.Core.length); I++) {
    const Diff = (PA.Core[I] ?? 0) - (PB.Core[I] ?? 0);
    if (Diff !== 0) return Diff;
  }
  if (!PA.Pre.length || !PB.Pre.length) return PB.Pre.length - PA.Pre.length;
  for (let I = 0; I < Math.max(PA.Pre.length, PB.Pre.length); I++) {
    const X = PA.Pre[I];
    const Y = PB.Pre[I];
    if (X === undefined) return -1;
    if (Y === undefined) return 1;
    const XNum = /^\d+$/.test(X);
    const YNum = /^\d+$/.test(Y);
    if (XNum && YNum) {
      if (Number(X) !== Number(Y)) return Number(X) - Number(Y);
    } else if (XNum !== YNum) {
      return XNum ? -1 : 1;
    } else if (X !== Y) {
      return X < Y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Load something on first use. Callers that arrive while a load is running
 * share it, and a load that fails is tried again by the next caller. Reset
 * makes the next call load afresh, once a load still running has settled.
 */
export function CreateLoadOnce(Load: () => Promise<void>) {
  let Loaded = false;
  let Loading: Promise<void> | null = null;
  return {
    async Ensure(): Promise<void> {
      if (Loaded) return;
      if (Loading) return Loading;
      Loading = (async () => {
        await Load();
        Loaded = true;
      })();
      try {
        await Loading;
      } finally {
        Loading = null;
      }
    },

    async Reset(): Promise<void> {
      if (Loading) await Loading.catch(() => {});
      Loaded = false;
    },

    IsLoaded(): boolean {
      return Loaded;
    },
  };
}

/**
 * Write a text file and flush it to the disk before returning. For the temp
 * file of a write-then-rename: without the flush, a power cut can leave the
 * renamed file empty, because the rename can reach the disk before the data.
 */
export function WriteAndSyncFileSync(FilePath: string, Text: string): void {
  const Fd = fs.openSync(FilePath, 'w');
  try {
    fs.writeSync(Fd, Text, null, 'utf8');
    fs.fsyncSync(Fd);
  } finally {
    fs.closeSync(Fd);
  }
}

/**
 * Replace a file's contents so that a crash mid-write leaves the old file or the
 * new one, never a torn one: the text goes to a temp file beside it, flushed to
 * the disk, which is then renamed over it. Creates the folder when missing.
 */
export function ReplaceFileSync(FilePath: string, Text: string): void {
  fs.mkdirSync(path.dirname(FilePath), { recursive: true });
  const TempPath = `${FilePath}.tmp`;
  WriteAndSyncFileSync(TempPath, Text);
  fs.renameSync(TempPath, FilePath);
}

/**
 * A path as compared for "the same file": resolved, and in lower case except on
 * Linux, whose file systems tell case apart (Windows' and macOS's do not).
 */
export function SamePathKey(FilePath: string): string {
  const Resolved = path.resolve(FilePath);
  return process.platform === 'linux' ? Resolved : Resolved.toLowerCase();
}

/** Whether two paths name the same file (see SamePathKey); false when either is missing. */
export function IsSamePath(A: string | null, B: string | null): boolean {
  return !!A && !!B && SamePathKey(A) === SamePathKey(B);
}
