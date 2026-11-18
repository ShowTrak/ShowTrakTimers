// SettingsManager: defaults merged with saved values, typed on the way in and
// out, with change events. Modelled on ShowTrak Server's SettingsManager.
//
// Fixes over 1.x: Init() never marked itself done (so every GetValue re-read
// every setting from the database), Get() did not wait for Init(), a failed
// validation still reported the old value as saved, and `isDefault` compared a
// stored value against an uncoerced default.
import { CreateLogger } from '../Logger';
import { DefaultSettings, Groups } from './DefaultSettings';
import type { SettingDefinition, SettingGroup, SettingValue } from './DefaultSettings';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as AppDb, type Database } from '../DB';

const Logger = CreateLogger('Settings');

/** A setting as held in memory and sent to the renderer (no functions). */
export interface Setting {
  Group: string;
  Key: string;
  Title: string;
  Description: string;
  Type: SettingDefinition['Type'];
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
}

export interface SettingsManagerShape {
  Initialized: boolean;
  Init(): Promise<void>;
  GetGroups(): Promise<SettingGroup[]>;
  GetAll(): Promise<Setting[]>;
  GetValue(Key: string): Promise<SettingValue | null>;
  Get(Key: string): Promise<Setting | undefined>;
  Set(Key: string, Value: unknown): Promise<[string | null, Setting | null]>;
}

function ClampInteger(Def: { Min?: number | null; Max?: number | null }, Value: number): number {
  let Result = Value;
  if (typeof Def.Min === 'number' && Result < Def.Min) Result = Def.Min;
  if (typeof Def.Max === 'number' && Result > Def.Max) Result = Def.Max;
  return Result;
}

// Coerce a stored or incoming value to the setting's declared type. Shared by
// load and save, so the two can never disagree about what a value means.
export function CoerceValue(
  Def: Pick<SettingDefinition, 'Type' | 'DefaultValue' | 'Options' | 'Min' | 'Max'>,
  Value: unknown
): SettingValue {
  switch (Def.Type) {
    case 'BOOLEAN': {
      if (typeof Value === 'boolean') return Value;
      if (Value === 1 || Value === '1' || Value === 'true') return true;
      if (Value === 0 || Value === '0' || Value === 'false') return false;
      return !!Value;
    }
    case 'INTEGER':
    case 'SLIDER': {
      if (Value === null || Value === undefined || Value === '') return Def.DefaultValue;
      const Num = typeof Value === 'number' ? Math.trunc(Value) : parseInt(String(Value), 10);
      return Number.isFinite(Num) ? ClampInteger(Def, Num) : Def.DefaultValue;
    }
    case 'STRING':
      return Value === null || Value === undefined ? '' : String(Value).trim();
    case 'OPTION':
      return typeof Value === 'string' && Def.Options?.includes(Value) ? Value : Def.DefaultValue;
    default:
      return Value as SettingValue;
  }
}

// Build a settings manager over a database. The app uses the default export
// (`Manager`, over the app database); the tests build their own.
export function CreateSettingsManager(
  Db: Database,
  Definitions: SettingDefinition[] = DefaultSettings,
  SettingGroups: SettingGroup[] = Groups,
  Broadcast: { emit(Event: string, ...Args: unknown[]): unknown } = BroadcastManager
): SettingsManagerShape {
  const Settings = new Map<string, Setting>();
  const DefinitionsByKey = new Map(Definitions.map((Def) => [Def.Key, Def]));
  let Initializing: Promise<void> | null = null;

  // A copy a caller may change freely: the arrays too, since Options is what
  // CoerceValue validates against.
  const Snapshot = (S: Setting): Setting => ({
    ...S,
    Options: S.Options ? [...S.Options] : null,
    ShowWhen: S.ShowWhen ? [...S.ShowWhen] : null,
  });

  const Manager: SettingsManagerShape = {
    Initialized: false,

    async Init() {
      if (Manager.Initialized) return;
      if (Initializing) return Initializing;
      Initializing = (async () => {
        const [Err, Rows] = await Db.All<{ Key: string; Value: unknown }>(
          'SELECT Key, Value FROM Settings'
        );
        if (Err) throw Err;
        const Saved = new Map((Rows || []).map((Row) => [String(Row.Key), Row.Value]));
        for (const Def of Definitions) {
          const HasSaved = Saved.has(Def.Key);
          const Value = HasSaved ? CoerceValue(Def, Saved.get(Def.Key)) : Def.DefaultValue;
          Settings.set(Def.Key, {
            Group: Def.Group,
            Key: Def.Key,
            Title: Def.Title,
            Description: Def.Description,
            Type: Def.Type,
            Value,
            isDefault: Value === Def.DefaultValue,
            DefaultValue: Def.DefaultValue,
            OnUpdateEvent: Def.OnUpdateEvent || null,
            Options: Def.Options ? [...Def.Options] : null,
            Min: typeof Def.Min === 'number' ? Def.Min : null,
            Max: typeof Def.Max === 'number' ? Def.Max : null,
            Unit: Def.Unit || null,
            ShowWhen: Def.ShowWhen ? [...Def.ShowWhen] : null,
            RequiresSave: !!Def.RequiresSave,
          });
        }
        Manager.Initialized = true;
      })();
      try {
        await Initializing;
      } finally {
        Initializing = null;
      }
    },

    async GetGroups() {
      return SettingGroups;
    },

    async GetAll() {
      await Manager.Init();
      return Array.from(Settings.values(), Snapshot);
    },

    async GetValue(Key) {
      await Manager.Init();
      const S = Settings.get(Key);
      return S ? S.Value : null;
    },

    async Get(Key) {
      await Manager.Init();
      const S = Settings.get(Key);
      return S ? Snapshot(S) : undefined;
    },

    async Set(Key, Value) {
      await Manager.Init();
      const S = Settings.get(Key);
      const Def = DefinitionsByKey.get(Key);
      if (!S || !Def) return ['Invalid Setting Key', null];

      const Next = CoerceValue(Def, Value);
      if (Next === S.Value) return [null, Snapshot(S)];

      if (Def.Validate) {
        let Problem: string | null = null;
        try {
          Problem = await Def.Validate(Next, S.Value);
        } catch (Err) {
          Problem = Err instanceof Error && Err.message ? Err.message : 'Validation failed.';
        }
        if (Problem) return [Problem, null];
      }

      const [Err] = await Db.Run('INSERT OR REPLACE INTO Settings (Key, Value) VALUES (?, ?)', [
        Key,
        Next,
      ]);
      if (Err) return ['Error updating setting', null];

      S.Value = Next;
      S.isDefault = Next === S.DefaultValue;
      Logger.log(`Setting ${Key} updated to ${Next}`);

      Broadcast.emit('SettingsUpdated');
      if (S.OnUpdateEvent) Broadcast.emit(S.OnUpdateEvent);
      return [null, Snapshot(S)];
    },
  };

  return Manager;
}

export const Manager = CreateSettingsManager(AppDb);
