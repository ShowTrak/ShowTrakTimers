// Renderer utilities, from ShowTrak Server's utils.ts: the one HTML escaper,
// error helpers, and the alert volume.
//
// 1.x escaped only < and >, so a timer name or setting value containing a quote
// broke out of the attribute it was rendered into.
import { Settings } from './state';

// Master alert volume as a 0..1 multiplier, read live from the settings
// snapshot (ALERT_SOUND_VOLUME, 0-100). Full volume when it is absent or
// malformed, so alerts are never silently muted.
export function GetAlertVolume(): number {
  const Setting = Settings.find((S) => S && S.Key === 'ALERT_SOUND_VOLUME');
  if (!Setting) return 1;
  const Pct = Number(Setting.Value);
  if (!Number.isFinite(Pct)) return 1;
  return Math.min(1, Math.max(0, Pct / 100));
}

// Close a toast message off as a sentence (dynamic messages, such as errors
// handed back by the main process, often are not).
export function WithFullStop(Message: unknown): unknown {
  if (typeof Message !== 'string') return Message;
  const Trimmed = Message.trimEnd();
  if (!Trimmed) return Message;
  return /[.!?…]$/.test(Trimmed) ? Trimmed : `${Trimmed}.`;
}

// Escape all five significant entities, so the result is safe in text content
// and in quoted attribute values. null/undefined become ''.
export function Safe(Input: unknown): string {
  if (typeof Input === 'string') {
    return Input.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  if (Array.isArray(Input)) return Input.map(Safe).join(',');
  if (Input === null || Input === undefined) return '';
  return Safe(String(Input));
}

export function ErrorMessage(Err: unknown, Fallback = ''): string {
  if (Err && typeof Err === 'object' && 'message' in Err) {
    const Message = (Err as { message?: unknown }).message;
    if (typeof Message === 'string' && Message.length > 0) return Message;
  }
  if (Fallback) return Fallback;
  return String(Err);
}

export function HandleNonFatalError(Context: unknown, Error: unknown = null): void {
  try {
    const Label = Context ? `[NonFatal] ${Context}` : '[NonFatal]';
    if (Error) console.warn(Label, Error);
    else console.warn(Label);
  } catch {
    /* the last-resort reporter must never throw */
  }
}

export function Wait(Ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Ms));
}
