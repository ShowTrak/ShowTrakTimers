// The contract between the main process and the desktop renderer: the IPC
// channel names, and the shape of `window.API` the preload bridge exposes.
//
// Like ShowTrak Server's IPC registry, the channel lists here are the single
// source of truth: the main process may only register these, and the sandboxed
// preload (src/bridge_main.ts) inlines the same lists, checked against these
// types at compile time and by test/ipc-channels.test.js at runtime.
import type { EndBehaviour, TimerStatus, TimerType, TimerView } from './timers';
import type { GroupPatchView, GroupView } from './groups';

export const INVOKE_CHANNELS = [
  'Config:Get',
  'Loaded',
  'Settings:Get',
  'Settings:Set',
  'Mode:Get',
  'Mode:Set',
  'Timers:List',
  'Timer:Get',
  'Timer:Create',
  'Timer:Update',
  'Timer:Delete',
  'Timer:Move',
  'Timers:Reorder',
  'Timer:Control',
  'Timer:JumpTo',
  'Timers:ControlAll',
  'Timers:ControlMany',
  'Timers:DeleteMany',
  'Timers:MoveToGroup',
  'Timers:Arrange',
  'Groups:List',
  'Group:Create',
  'Group:Update',
  'Group:Delete',
  'Groups:Reorder',
  'Show:GetCurrentFile',
  'Show:New',
  'Show:Open',
  'Show:Save',
  'Show:SaveAs',
  'Show:CheckUpgrade',
  'Show:ResolveUpgrade',
  'Show:HasUnsavedData',
  'Show:EnsureFileExists',
  'App:OpenBackupsFolder',
  'Sounds:List',
  'Sounds:Import',
  'Sounds:Update',
  'Sounds:Delete',
  'Sounds:GetData',
  'Services:GetStatus',
  'OSC:GetRoutes',
  'App:OpenLogsFolder',
  'App:OpenExternal',
  'App:GetDependencies',
  'App:GetLicense',
  'AppUpdate:Check',
  'AppUpdate:Install',
  'Shutdown',
] as const;

export const PUSH_CHANNELS = [
  'Timers:Updated',
  'Timer:Event',
  'Groups:Updated',
  'ShowFile:Updated',
  'Settings:Updated',
  'Mode:Updated',
  'Notify',
  'Sounds:Updated',
  'Services:Status',
  'WebDashboard:ClientCount',
  'AppUpdate:Status',
  'AppMenuAction',
  'ShutdownRequested',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type PushChannel = (typeof PUSH_CHANNELS)[number];

/** `[Error, Value]`: the result convention of every ShowTrak IPC call. */
export type ResultTuple<T> = [string | null, T | null];

export type AppMode = 'SHOW' | 'EDIT';

export type ControlAction = 'Start' | 'Stop' | 'Pause' | 'Unpause';

export type ExternalLink = 'discord' | 'website' | 'github';

export interface AppConfigView {
  Application: { Name: string; Version: string };
  Platform: string;
  IsPackaged: boolean;
}

export type SettingType = 'BOOLEAN' | 'INTEGER' | 'STRING' | 'OPTION' | 'SLIDER';
export type SettingValue = boolean | number | string;

export interface SettingView {
  Group: string;
  Key: string;
  Title: string;
  Description: string;
  Type: SettingType;
  Value: SettingValue;
  isDefault: boolean;
  DefaultValue: SettingValue;
  OnUpdateEvent: string | null;
  Options: string[] | null;
  Min: number | null;
  Max: number | null;
  Unit: string | null;
  ShowWhen: string[] | null;
  RequiresSave: boolean;
  /** 'INSTALL' for a machine setting (kept with this installation, not the show file). */
  Scope: 'INSTALL' | null;
}

export interface SettingGroupView {
  Name: string;
  Title: string;
}

/** Fields a timer create/update may carry (all optional). */
export interface TimerPatchView {
  Type?: TimerType;
  Name?: string;
  Description?: string;
  Duration?: number | null;
  ShowOnWeb?: boolean;
  EndBehaviour?: EndBehaviour;
  CompletionSound?: string | null;
  CompletionToast?: boolean;
  WarningMs?: number | null;
  WarningSound?: string | null;
  WarningToast?: boolean;
  ShowHundredths?: boolean;
  /** A group ID, or null for the Default group. */
  GroupID?: number | null;
}

/** A show file an older version saved, waiting on the operator to agree to upgrade it. */
export interface ShowFileUpgradeView {
  FilePath: string;
  FileName: string;
  FileVersion: string | null;
  CurrentVersion: string;
}

export type ShowOpenOutcome =
  | { Status: 'Opened'; FilePath: string }
  | { Status: 'UpgradeRequired'; Upgrade: ShowFileUpgradeView };

/** What the title bar shows about the open show file. */
export interface ShowFileStateView {
  FilePath: string | null;
  Unsaved: boolean;
  /** Goes up each time another show is loaded (open, new, a declined upgrade). */
  Generation: number;
}

export interface TimerPlacementView {
  ID: number;
  GroupID: number | null;
}

export interface TimerEventView {
  Kind: 'warning' | 'complete';
  TimerID: number;
  Name: string;
  Sound: string | null;
  Toast: boolean;
}

export interface LibrarySoundView {
  ID: string;
  Label: string;
  OriginalName: string;
  Extension: string;
  Volume: number;
  Size: number;
  Timestamp: number;
  Missing: boolean;
}

export interface SoundDataView {
  ID: string;
  Label: string;
  Volume: number;
  DataURL: string;
}

export interface ServiceStatus {
  Enabled: boolean;
  Running: boolean;
  Host: string | null;
  Port: number | null;
}

export interface ServicesStatusView {
  OSC: ServiceStatus;
  WebDashboard: ServiceStatus & {
    /** http:// addresses the dashboard can be opened at from another device. */
    URLs: string[];
    Clients: number;
  };
}

export interface OscRouteView {
  Path: string;
  Title: string;
}

export interface DependencyView {
  name: string;
  version: string;
}

/** A status update from the self-updater (the same shape as ShowTrak Server's). */
export interface AppUpdateStatus {
  state:
    | 'checking'
    | 'available'
    | 'none'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'installed'
    | 'error'
    | string;
  error?: string;
  percent?: number;
  simulated?: boolean;
  info?: {
    version?: string;
    tag?: string;
    releaseNotes?: unknown;
    notes?: unknown;
    body?: unknown;
    reason?: string;
    details?: string;
  } | null;
}

type Unsubscribe = () => void;

/** `window.API` in the desktop renderer. */
export interface TimersAPI {
  GetConfig(): Promise<AppConfigView>;
  Loaded(): Promise<void>;

  GetSettings(): Promise<SettingView[]>;
  SetSetting(Key: string, Value: SettingValue): Promise<ResultTuple<SettingView>>;
  OnSettings(Callback: (Settings: SettingView[], Groups: SettingGroupView[]) => void): Unsubscribe;

  GetMode(): Promise<AppMode>;
  SetMode(Mode: AppMode): Promise<AppMode>;
  OnMode(Callback: (Mode: AppMode) => void): Unsubscribe;

  ListTimers(): Promise<TimerView[]>;
  GetTimer(ID: number): Promise<ResultTuple<TimerView>>;
  CreateTimer(Patch: TimerPatchView): Promise<ResultTuple<TimerView>>;
  UpdateTimer(ID: number, Patch: TimerPatchView): Promise<ResultTuple<TimerView>>;
  DeleteTimer(ID: number): Promise<ResultTuple<true>>;
  MoveTimer(ID: number, Direction: 'UP' | 'DOWN'): Promise<ResultTuple<boolean>>;
  ReorderTimers(IDs: number[]): Promise<ResultTuple<true>>;
  ControlTimer(ID: number, Action: ControlAction): Promise<ResultTuple<TimerView>>;
  JumpTimer(ID: number, Ms: number): Promise<ResultTuple<TimerView>>;
  ControlAllTimers(Action: ControlAction): Promise<ResultTuple<number>>;
  ControlTimers(IDs: number[], Action: ControlAction): Promise<ResultTuple<number>>;
  DeleteTimers(IDs: number[]): Promise<ResultTuple<number>>;
  MoveTimersToGroup(IDs: number[], GroupID: number | null): Promise<ResultTuple<number>>;
  ArrangeTimers(Layout: TimerPlacementView[]): Promise<ResultTuple<true>>;
  OnTimers(Callback: (Timers: TimerView[]) => void): Unsubscribe;
  OnTimerEvent(Callback: (Event: TimerEventView) => void): Unsubscribe;

  ListGroups(): Promise<GroupView[]>;
  CreateGroup(Patch: GroupPatchView): Promise<ResultTuple<GroupView>>;
  UpdateGroup(ID: number, Patch: GroupPatchView): Promise<ResultTuple<GroupView>>;
  DeleteGroup(ID: number): Promise<ResultTuple<true>>;
  ReorderGroups(IDs: number[]): Promise<ResultTuple<true>>;
  OnGroups(Callback: (Groups: GroupView[]) => void): Unsubscribe;

  GetCurrentShowFile(): Promise<string | null>;
  NewShow(): Promise<ResultTuple<string>>;
  OpenShow(): Promise<ResultTuple<ShowOpenOutcome>>;
  SaveShow(): Promise<ResultTuple<string>>;
  SaveShowAs(): Promise<ResultTuple<string>>;
  CheckShowFileUpgrade(): Promise<ResultTuple<ShowFileUpgradeView | null>>;
  ResolveShowFileUpgrade(Accept: boolean): Promise<ResultTuple<unknown>>;
  HasUnsavedShowData(): Promise<boolean>;
  EnsureShowFileExists(): Promise<ResultTuple<{ Missing: boolean; FilePath?: string }>>;
  OnShowFile(Callback: (State: ShowFileStateView) => void): Unsubscribe;
  OpenBackupsFolder(): Promise<void>;

  ListSounds(): Promise<LibrarySoundView[]>;
  ImportSound(): Promise<ResultTuple<LibrarySoundView>>;
  UpdateSound(
    ID: string,
    Patch: { Label?: string; Volume?: number }
  ): Promise<ResultTuple<LibrarySoundView>>;
  DeleteSound(ID: string): Promise<ResultTuple<true>>;
  GetSoundData(ID: string): Promise<ResultTuple<SoundDataView>>;
  OnSounds(Callback: (Sounds: LibrarySoundView[]) => void): Unsubscribe;

  GetServicesStatus(): Promise<ServicesStatusView>;
  OnServicesStatus(Callback: (Status: ServicesStatusView) => void): Unsubscribe;
  OnWebDashboardClientCount(Callback: (Count: number) => void): Unsubscribe;
  GetOscRoutes(): Promise<OscRouteView[]>;

  OpenLogsFolder(): Promise<void>;
  OpenExternal(Link: ExternalLink): Promise<void>;
  GetDependencies(): Promise<ResultTuple<{ dependencies: DependencyView[] }>>;
  GetLicense(): Promise<ResultTuple<{ license: string }>>;

  CheckForAppUpdates(): Promise<void>;
  InstallAppUpdate(): Promise<void>;
  OnAppUpdateStatus(Callback: (Status: AppUpdateStatus) => void): Unsubscribe;

  OnNotify(Callback: (Message: string, Type: string, Duration: number | null) => void): Unsubscribe;
  OnAppMenuAction(Callback: (Action: string) => void): Unsubscribe;
  OnShutdownRequested(Callback: () => void): Unsubscribe;
  Shutdown(Confirmed?: boolean): Promise<void>;
}

export type { TimerView, TimerStatus, TimerType, EndBehaviour, GroupView, GroupPatchView };
