const { CreateLogger } = require("../Logger");
const Logger = CreateLogger("Settings");

const { DefaultSettings, Groups } = require("./DefaultSettings");

const { Manager: BroadcastManager } = require("../Broadcast");

const { Manager: DB } = require("../DB");

const Settings = new Map();

function coerceValueByType(type, value) {
	const T = String(type || '').toUpperCase();
	if (T === 'BOOLEAN') return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
	if (T === 'INTEGER') {
		const n = Number(value);
		return Number.isFinite(n) ? Math.trunc(n) : 0;
	}
	if (T === 'NUMBER') {
		const n = Number(value);
		return Number.isFinite(n) ? n : 0;
	}
	if (T === 'TEXT') return value == null ? '' : String(value);
	return value;
}

const Manager = [];

Manager.Initialized = false;

Manager.Init = async () => {
	if (Manager.Initialized) return;

	for (const Setting of DefaultSettings) {
		let [Err, ManualSetting] = await DB.Get("SELECT * FROM Settings WHERE Key = ?", [Setting.Key]);
		if (Err) throw Err;

		let NewSetting = {
            Group: Setting.Group,
			Key: Setting.Key,
			Title: Setting.Title,
			Description: Setting.Description,
			Type: Setting.Type,
			Value: coerceValueByType(Setting.Type, ManualSetting ? ManualSetting.Value : Setting.DefaultValue),
			isDefault: ManualSetting ? ManualSetting.Value === Setting.DefaultValue : true,
			DefaultValue: Setting.DefaultValue,
			OnUpdateEvent: Setting.OnUpdateEvent || null,
			RequiresSave: !!Setting.RequiresSave,
			Validate: typeof Setting.Validate === 'function' ? Setting.Validate : null,
		};

		Settings.set(NewSetting.Key, NewSetting);

		// Logger.log(`Setting ${NewSetting.Key} is ${NewSetting.Value}`);
	}
	return;
};

Manager.GetGroups = async () => {
    return Groups;
}

Manager.GetAll = async () => {
	if (!Manager.Initialized) await Manager.Init();
	// Strip function fields (e.g., Validate) to keep IPC payloads cloneable
	return Array.from(Settings.values()).map((s) => {
		const { Validate, ...rest } = s;
		return { ...rest };
	});
};

Manager.GetValue = async (Key) => {
	if (!Manager.Initialized) await Manager.Init();
	let Setting = Settings.get(Key);
	if (!Setting) return null;
	return Setting.Value;
}

Manager.Get = async (Key) => {
	if (!Manager.Initialized) Manager.Init();
	const s = Settings.get(Key);
	if (!s) return null;
	const { Validate, ...rest } = s;
	return { ...rest };
};

Manager.Set = async (Key, Value) => {
	if (!Manager.Initialized) await Manager.Init();

	let Setting = Settings.get(Key);
	if (!Setting) return ["Invalid Setting Key", null];

	if (Setting.Value === Value) return [null, Setting];

	// Coerce and validate before persisting
	const TypedValue = coerceValueByType(Setting.Type, Value);
	if (typeof Setting.Validate === 'function') {
		try {
			const result = await Setting.Validate(TypedValue, Setting);
			if (result === false) {
				return ["Invalid value", null];
			}
			if (Array.isArray(result)) {
				const [ok, message] = result;
				if (!ok) {
					try { BroadcastManager.emit('Notify', message || 'Invalid setting value', 'error', 4000); } catch {}
					return [message || "Invalid value", null];
				}
			}
		} catch (e) {
			const msg = e && e.message ? e.message : 'Validation failed';
			try { BroadcastManager.emit('Notify', msg, 'error', 4000); } catch {}
			return [msg, null];
		}
	}

	// persist
	let [Err, _Res] = await DB.Run("INSERT OR REPLACE INTO Settings (Key, Value) VALUES (?, ?)", [Key, TypedValue]);
	if (Err) return ["Error updating setting", null];

	Setting.Value = TypedValue;
	Setting.isDefault = Setting.Value === coerceValueByType(Setting.Type, Setting.DefaultValue);

	Settings.set(Key, Setting);

	Logger.log(`Setting ${Key} updated to ${Value}`);

    BroadcastManager.emit('SettingsUpdated');

	if (Setting.OnUpdateEvent) BroadcastManager.emit(Setting.OnUpdateEvent);

	// Return a cloneable version (no functions)
	const { Validate, ...rest } = Setting;
	return [null, { ...rest }];
};

Manager.Init();

module.exports = {
	Manager,
};
