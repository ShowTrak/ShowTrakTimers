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

// Order two dotted version strings ("3.29.3") numerically, part by part:
// negative when a is older than b, positive when newer, 0 when equal. A
// pre-release suffix is compared as further numeric parts. (Squirrel rewrites
// "2.0.0-beta.1" as "2.0.0-beta1", which the strict semver comparison in
// @showtrak/protocol/runtime would not parse; this is ShowTrak Server's lenient
// one, used only for Squirrel package names.)
export function CompareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
