// Renderer state shared between modules. Mutated only through the setters, so
// a module reading it always sees the latest push from the main process.
import type {
  AppConfigView,
  AppMode,
  GroupView,
  LibrarySoundView,
  ServicesStatusView,
  SettingGroupView,
  SettingView,
  ShowFileStateView,
} from '@showtrak/protocol/timers';

export let Config: AppConfigView | null = null;
export let Settings: SettingView[] = [];
export let SettingsGroups: SettingGroupView[] = [];
export let Mode: AppMode = 'SHOW';
export let Sounds: LibrarySoundView[] = [];
export let Services: ServicesStatusView | null = null;
export let ConfirmDialogActive = false;
export let Groups: GroupView[] = [];
export let ShowFile: ShowFileStateView = { FilePath: null, Unsaved: false, Generation: 0 };
// Pending debounced settings saves, keyed by setting key.
export const SettingDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function setConfig(Value: AppConfigView | null): void {
  Config = Value;
}
export function setSettings(Value: SettingView[]): void {
  Settings = Array.isArray(Value) ? Value : [];
}
export function setSettingsGroups(Value: SettingGroupView[]): void {
  SettingsGroups = Array.isArray(Value) ? Value : [];
}
export function setMode(Value: AppMode): void {
  Mode = Value === 'EDIT' ? 'EDIT' : 'SHOW';
}
export function setSounds(Value: LibrarySoundView[]): void {
  Sounds = Array.isArray(Value) ? Value : [];
}
export function setServices(Value: ServicesStatusView | null): void {
  Services = Value;
}
export function setConfirmDialogActive(Value: boolean): void {
  ConfirmDialogActive = Value;
}
export function setGroups(Value: GroupView[]): void {
  Groups = Array.isArray(Value) ? Value : [];
}
export function setShowFile(Value: ShowFileStateView | null): void {
  ShowFile =
    Value && typeof Value === 'object' ? Value : { FilePath: null, Unsaved: false, Generation: 0 };
}

export function SettingValue(Key: string): SettingView['Value'] | null {
  const Setting = Settings.find((S) => S && S.Key === Key);
  return Setting ? Setting.Value : null;
}
