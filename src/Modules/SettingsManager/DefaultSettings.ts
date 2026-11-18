// Every setting ShowTrak Timers has, with its default. The shapes and field
// meanings match ShowTrak Server's DefaultSettings (Type, Options, Min/Max, Unit,
// ShowWhen, OnUpdateEvent), and so does the Preferences modal that renders them.
//
// Keys kept from 1.x keep their stored values. Two changed in 2.0 (see the DB
// migration "Settings renamed in 2.0"): SYSTEM_AUTO_UPDATE is now
// SYSTEM_AUTO_UPDATE_ENABLED, and SYSTEM_PREVENT_DISPLAY_SLEEP is gone because
// display sleep is now always prevented.
import { DEFAULT_OSC_PORT, DEFAULT_WEB_DASHBOARD_PORT } from '../Config/constants';
import { ValidateBindAddress, ValidatePasscode, ValidatePort } from './validators';

// STRING is free text; OPTION one of Options; SLIDER an INTEGER drawn as a range.
export type SettingType = 'BOOLEAN' | 'INTEGER' | 'STRING' | 'OPTION' | 'SLIDER';
export type SettingValue = boolean | number | string;

// A validator returns null when the value is acceptable, or the message to show.
export type SettingValidator = (
  Value: SettingValue,
  Current: SettingValue
) => Promise<string | null> | string | null;

export interface SettingDefinition {
  Group: string;
  Key: string;
  Title: string;
  Description: string;
  Type: SettingType;
  DefaultValue: SettingValue;
  Min?: number;
  Max?: number;
  Options?: string[];
  // Unit label shown alongside numeric/slider values in the UI (e.g. '%').
  Unit?: string;
  // Broadcast after the value changes, so the owning service can re-apply it.
  OnUpdateEvent?: string;
  // Shown only while every BOOLEAN setting named here is on (presentational).
  ShowWhen?: string[];
  // Edited with an explicit Save button rather than applied as typed: used for
  // network settings, where every intermediate keystroke would rebind a socket.
  RequiresSave?: boolean;
  Validate?: SettingValidator;
}

export interface SettingGroup {
  Name: string;
  Title: string;
}

export const DefaultSettings: SettingDefinition[] = [
  {
    Group: 'Machine',
    Key: 'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4',
    Title: 'Stop Accidental Shutdowns',
    Description: 'Ask for confirmation before quitting ShowTrak Timers.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Machine',
    Key: 'SYSTEM_AUTO_UPDATE_ENABLED',
    Title: 'Automatic Updates',
    Description:
      'Download new releases in the background. They install the next time ShowTrak Timers restarts.',
    Type: 'BOOLEAN',
    DefaultValue: false,
    OnUpdateEvent: 'AutoUpdateSettingsChanged',
  },
  {
    Group: 'Machine',
    Key: 'SYSTEM_UPDATE_CHANNEL',
    Title: 'Update Channel',
    Description:
      'Beta also offers pre-releases, always moving to the newest release of any kind. Switching back to Stable keeps the installed version until a newer stable release is out.',
    Type: 'OPTION',
    DefaultValue: 'Stable',
    Options: ['Stable', 'Beta'],
    OnUpdateEvent: 'AutoUpdateSettingsChanged',
  },
  {
    Group: 'Alerts',
    Key: 'ALERT_SOUND_VOLUME',
    Title: 'Alert Volume',
    Description: 'Volume of timer warning and completion sounds.',
    Type: 'SLIDER',
    DefaultValue: 80,
    Min: 0,
    Max: 100,
    Unit: '%',
  },
  {
    Group: 'Alerts',
    Key: 'NOTIFY_SETTINGS_CHANGES',
    Title: 'Settings Change Notifications',
    Description: 'Show a notification whenever a setting is changed or saved.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Alerts',
    Key: 'NOTIFY_OSC_DEBUG',
    Title: 'OSC Notifications',
    Description: 'Show a notification for every OSC command received, and for OSC errors.',
    Type: 'BOOLEAN',
    DefaultValue: true,
  },
  {
    Group: 'Web',
    Key: 'WEB_ENABLE_DASHBOARD',
    Title: 'Enable Web Dashboard',
    Description: 'Serve a read-only view of your timers to browsers on the local network.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'WebDashboard:Restart',
  },
  {
    Group: 'Web',
    Key: 'WEB_DASHBOARD_PORT',
    Title: 'Web Dashboard Port',
    Description: 'TCP port the Web Dashboard is served on.',
    Type: 'INTEGER',
    DefaultValue: DEFAULT_WEB_DASHBOARD_PORT,
    Min: 1,
    Max: 65535,
    OnUpdateEvent: 'WebDashboard:Restart',
    ShowWhen: ['WEB_ENABLE_DASHBOARD'],
    RequiresSave: true,
    Validate: (Value, Current) => ValidatePort('tcp', Value, Current),
  },
  {
    Group: 'Web',
    Key: 'WEB_DASHBOARD_BIND',
    Title: 'Web Dashboard Bind Address',
    Description: 'IPv4 address to serve the Web Dashboard on (0.0.0.0 for every interface).',
    Type: 'STRING',
    DefaultValue: '0.0.0.0',
    OnUpdateEvent: 'WebDashboard:Restart',
    ShowWhen: ['WEB_ENABLE_DASHBOARD'],
    RequiresSave: true,
    Validate: (Value) => ValidateBindAddress('tcp', Value),
  },
  {
    Group: 'Web',
    Key: 'WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED',
    Title: 'Password Protection Enabled',
    Description:
      'Require the passcode to open the Web Dashboard. Applies once a passcode is set below.',
    Type: 'BOOLEAN',
    DefaultValue: false,
    ShowWhen: ['WEB_ENABLE_DASHBOARD'],
    // Connected browsers are asked again (or let straight in) at once.
    OnUpdateEvent: 'WebDashboard:AuthChanged',
  },
  {
    Group: 'Web',
    Key: 'WEB_DASHBOARD_PASSWORD',
    Title: 'Password (4 Digit Numeric)',
    Description: 'Browsers that have entered it stay signed in until it is changed.',
    Type: 'STRING',
    DefaultValue: '',
    ShowWhen: ['WEB_ENABLE_DASHBOARD', 'WEB_DASHBOARD_PASSWORD_PROTECTION_ENABLED'],
    RequiresSave: true,
    Validate: (Value) => ValidatePasscode(Value),
    // A new passcode signs every browser out.
    OnUpdateEvent: 'WebDashboard:AuthChanged',
  },
  {
    Group: 'OSC',
    Key: 'OSC_ENABLE',
    Title: 'Enable OSC Server',
    Description: 'Listen for OSC commands to control timers remotely.',
    Type: 'BOOLEAN',
    DefaultValue: true,
    OnUpdateEvent: 'OSC:Restart',
  },
  {
    Group: 'OSC',
    Key: 'OSC_PORT',
    Title: 'OSC Port',
    Description: 'UDP port to listen for OSC commands on.',
    Type: 'INTEGER',
    DefaultValue: DEFAULT_OSC_PORT,
    Min: 1,
    Max: 65535,
    OnUpdateEvent: 'OSC:Restart',
    ShowWhen: ['OSC_ENABLE'],
    RequiresSave: true,
    Validate: (Value, Current) => ValidatePort('udp', Value, Current),
  },
  {
    Group: 'OSC',
    Key: 'OSC_BIND',
    Title: 'OSC Bind Address',
    Description: 'IPv4 address to listen on (0.0.0.0 for every interface).',
    Type: 'STRING',
    DefaultValue: '0.0.0.0',
    OnUpdateEvent: 'OSC:Restart',
    ShowWhen: ['OSC_ENABLE'],
    RequiresSave: true,
    Validate: (Value) => ValidateBindAddress('udp', Value),
  },
];

export const Groups: SettingGroup[] = [
  { Name: 'Machine', Title: 'Machine Settings' },
  { Name: 'Alerts', Title: 'Alerts' },
  { Name: 'Web', Title: 'Web Dashboard' },
  { Name: 'OSC', Title: 'OSC' },
];
