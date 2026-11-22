// Preload bridge for the main window: exposes `window.API`.
//
// This is a SANDBOXED preload script. Its `require` can only resolve Electron
// built-ins, not local files, so the channel allowlists are inlined here rather
// than imported from src/common/api.ts. That file stays the source of truth and
// drift is a COMPILE error: the imports from it below are type-only (erased from
// the emitted JS), `satisfies` rejects an entry that is not a known channel, and
// the _Missing* aliases reject a known channel missing from these lists.
import { contextBridge, ipcRenderer } from 'electron';
import type { InvokeChannel, PushChannel, TimersAPI } from './common/api';

type AssertAllChannelsListed<T extends never> = T;

const INVOKE_CHANNEL_LIST = [
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
  'Show:TakeOpenRequest',
  'Show:OpenRequested',
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
] as const satisfies readonly InvokeChannel[];
type _MissingInvokeChannels = AssertAllChannelsListed<
  Exclude<InvokeChannel, (typeof INVOKE_CHANNEL_LIST)[number]>
>;
const INVOKE_CHANNELS = new Set<string>(INVOKE_CHANNEL_LIST);

const PUSH_CHANNEL_LIST = [
  'Timers:Updated',
  'Timer:Event',
  'Groups:Updated',
  'ShowFile:Updated',
  'ShowFile:OpenRequested',
  'Settings:Updated',
  'Mode:Updated',
  'Notify',
  'Sounds:Updated',
  'Services:Status',
  'WebDashboard:ClientCount',
  'AppUpdate:Status',
  'AppMenuAction',
  'ShutdownRequested',
  'MainWindowFullscreenChanged',
] as const satisfies readonly PushChannel[];
type _MissingPushChannels = AssertAllChannelsListed<
  Exclude<PushChannel, (typeof PUSH_CHANNEL_LIST)[number]>
>;
const PUSH_CHANNELS = new Set<string>(PUSH_CHANNEL_LIST);

function invoke<T = unknown>(Channel: InvokeChannel, ...Args: unknown[]): Promise<T> {
  if (!INVOKE_CHANNELS.has(Channel)) throw new Error(`Blocked invoke channel: ${Channel}`);
  // Electron leaves the reply untyped; what each channel resolves to is the
  // contract's (T is inferred from TimersAPI at each call below).
  return ipcRenderer.invoke(Channel, ...Args) as Promise<T>;
}

// Subscribe to a push channel; returns the unsubscribe function. The Electron
// event object is never handed to the page.
function subscribe<Args extends unknown[]>(
  Channel: PushChannel,
  Callback: (...Args: Args) => void
): () => void {
  if (!PUSH_CHANNELS.has(Channel)) throw new Error(`Blocked push channel: ${Channel}`);
  if (typeof Callback !== 'function')
    throw new TypeError(`Callback for ${Channel} must be a function`);
  const Handler = (_Event: unknown, ...Payload: unknown[]) => Callback(...(Payload as Args));
  ipcRenderer.on(Channel, Handler);
  return () => ipcRenderer.removeListener(Channel, Handler);
}

const API: TimersAPI = {
  GetConfig: () => invoke('Config:Get'),
  Loaded: () => invoke('Loaded'),

  GetSettings: () => invoke('Settings:Get'),
  SetSetting: (Key, Value) => invoke('Settings:Set', Key, Value),
  OnSettings: (Callback) => subscribe('Settings:Updated', Callback),

  GetMode: () => invoke('Mode:Get'),
  SetMode: (Mode) => invoke('Mode:Set', Mode),
  OnMode: (Callback) => subscribe('Mode:Updated', Callback),

  ListTimers: () => invoke('Timers:List'),
  GetTimer: (ID) => invoke('Timer:Get', ID),
  CreateTimer: (Patch) => invoke('Timer:Create', Patch),
  UpdateTimer: (ID, Patch) => invoke('Timer:Update', ID, Patch),
  DeleteTimer: (ID) => invoke('Timer:Delete', ID),
  ControlTimer: (ID, Action) => invoke('Timer:Control', ID, Action),
  JumpTimer: (ID, Ms) => invoke('Timer:JumpTo', ID, Ms),
  ControlAllTimers: (Action) => invoke('Timers:ControlAll', Action),
  ControlTimers: (IDs, Action) => invoke('Timers:ControlMany', IDs, Action),
  DeleteTimers: (IDs) => invoke('Timers:DeleteMany', IDs),
  MoveTimersToGroup: (IDs, GroupID) => invoke('Timers:MoveToGroup', IDs, GroupID),
  ArrangeTimers: (Layout) => invoke('Timers:Arrange', Layout),
  OnTimers: (Callback) => subscribe('Timers:Updated', Callback),
  OnTimerEvent: (Callback) => subscribe('Timer:Event', Callback),

  ListGroups: () => invoke('Groups:List'),
  CreateGroup: (Patch) => invoke('Group:Create', Patch),
  UpdateGroup: (ID, Patch) => invoke('Group:Update', ID, Patch),
  DeleteGroup: (ID) => invoke('Group:Delete', ID),
  ReorderGroups: (IDs) => invoke('Groups:Reorder', IDs),
  OnGroups: (Callback) => subscribe('Groups:Updated', Callback),

  GetCurrentShowFile: () => invoke('Show:GetCurrentFile'),
  NewShow: () => invoke('Show:New'),
  OpenShow: () => invoke('Show:Open'),
  SaveShow: () => invoke('Show:Save'),
  SaveShowAs: () => invoke('Show:SaveAs'),
  CheckShowFileUpgrade: () => invoke('Show:CheckUpgrade'),
  ResolveShowFileUpgrade: (Accept) => invoke('Show:ResolveUpgrade', Accept),
  HasUnsavedShowData: () => invoke('Show:HasUnsavedData'),
  EnsureShowFileExists: () => invoke('Show:EnsureFileExists'),
  OnShowFile: (Callback) => subscribe('ShowFile:Updated', Callback),
  TakeShowFileRequest: () => invoke('Show:TakeOpenRequest'),
  OpenRequestedShow: () => invoke('Show:OpenRequested'),
  OnShowFileRequest: (Callback) => subscribe('ShowFile:OpenRequested', Callback),
  OpenBackupsFolder: () => invoke('App:OpenBackupsFolder'),

  ListSounds: () => invoke('Sounds:List'),
  ImportSound: () => invoke('Sounds:Import'),
  UpdateSound: (ID, Patch) => invoke('Sounds:Update', ID, Patch),
  DeleteSound: (ID) => invoke('Sounds:Delete', ID),
  GetSoundData: (ID) => invoke('Sounds:GetData', ID),
  OnSounds: (Callback) => subscribe('Sounds:Updated', Callback),

  GetServicesStatus: () => invoke('Services:GetStatus'),
  OnServicesStatus: (Callback) => subscribe('Services:Status', Callback),
  OnWebDashboardClientCount: (Callback) => subscribe('WebDashboard:ClientCount', Callback),
  GetOscRoutes: () => invoke('OSC:GetRoutes'),

  OpenLogsFolder: () => invoke('App:OpenLogsFolder'),
  OpenExternal: (Link) => invoke('App:OpenExternal', Link),
  GetDependencies: () => invoke('App:GetDependencies'),
  GetLicense: () => invoke('App:GetLicense'),

  CheckForAppUpdates: () => invoke('AppUpdate:Check'),
  InstallAppUpdate: () => invoke('AppUpdate:Install'),
  OnAppUpdateStatus: (Callback) => subscribe('AppUpdate:Status', Callback),

  OnNotify: (Callback) => subscribe('Notify', Callback),
  OnAppMenuAction: (Callback) => subscribe('AppMenuAction', Callback),
  OnShutdownRequested: (Callback) => subscribe('ShutdownRequested', Callback),
  OnWindowFullscreenChanged: (Callback) => subscribe('MainWindowFullscreenChanged', Callback),
  Shutdown: (Confirmed = false) => invoke('Shutdown', Confirmed),
};

contextBridge.exposeInMainWorld('API', API);
