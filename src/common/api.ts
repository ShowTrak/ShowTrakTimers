// The IPC channel allowlists between the main process and the desktop
// renderer: the runtime half of the contract in @showtrak/protocol/timers,
// which declares what each channel takes, answers and carries (InvokeMap,
// PushMap) and the `window.API` the preload bridges expose (TimersAPI,
// PreloaderAPI).
//
// Like ShowTrak Server's IPC registry, these lists are the single source of
// truth at runtime: the main process may only register these, and the
// sandboxed preload (src/bridge_main.ts) inlines the same lists. Both copies are
// checked against the protocol's channel unions at compile time, in both
// directions, and against each other by test/ipc-channels.test.js.
import type {
  AssertTrue,
  ChannelListCheck,
  InvokeChannel,
  PushChannel,
} from '@showtrak/protocol/timers';

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
] as const;

export const PUSH_CHANNELS = [
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
] as const;

// Every listed channel is declared, and every declared channel is listed.
type _InvokeChannelsMatch = AssertTrue<ChannelListCheck<InvokeChannel, typeof INVOKE_CHANNELS>>;
type _PushChannelsMatch = AssertTrue<ChannelListCheck<PushChannel, typeof PUSH_CHANNELS>>;
