// Small helpers shared by the main-process modules.

export function Wait(Ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Ms));
}

// A human-readable message from an unknown thrown value (catch clauses are
// typed `unknown`).
export function ErrorMessage(Err: unknown): string {
  if (Err && typeof Err === 'object' && 'message' in Err) {
    const Message = (Err as { message?: unknown }).message;
    if (typeof Message === 'string' && Message.length > 0) return Message;
  }
  return String(Err);
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
