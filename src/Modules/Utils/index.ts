// Small helpers shared by the main-process modules.
import path from 'path';

export function Wait(Ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Ms));
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
