// Renderer utilities: the alert volume and Wait, and the HTML escaper and
// error reporter every module uses, which are the renderer kit's (shared with
// ShowTrak Server) and re-exported here.
import { Settings } from './state';

export { Safe } from '@showtrak/protocol/ui/html';
export { HandleNonFatalError } from '@showtrak/protocol/ui/errors';

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

export function Wait(Ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Ms));
}
