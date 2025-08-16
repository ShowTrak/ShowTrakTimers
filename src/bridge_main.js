const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("API", {
	OpenDiscordInviteLinkInBrowser: async () => ipcRenderer.invoke("OpenDiscordInviteLinkInBrowser"),
	GetConfig: async () => ipcRenderer.invoke("Config:Get"),
	GetSettings: async () => ipcRenderer.invoke("Settings:Get"),
	Loaded: () => ipcRenderer.invoke("Loaded"),
	Shutdown: () => ipcRenderer.invoke("Shutdown"),
	OpenLogsFolder: async () => ipcRenderer.invoke("OpenLogsFolder"),
	BackupConfig: async () => ipcRenderer.invoke("BackupConfig"),
	ImportConfig: async () => ipcRenderer.invoke("ImportConfig"),
	// Optional mode APIs (no-op if main doesn't handle)
	GetMode: async () => ipcRenderer.invoke("Mode:Get"),
	SetMode: async (Mode) => ipcRenderer.invoke("Mode:Set", Mode),
	OnModeUpdated: (Callback) => ipcRenderer.on("Mode:Updated", (_e, Mode) => Callback(Mode)),
	PlaySound: (Callback) =>
		ipcRenderer.on("PlaySound", (_event, SoundName) => {
			Callback(SoundName);
		}),
	Notify: (Callback) =>
		ipcRenderer.on("Notify", (_event, Message, Type, Duration) => {
			Callback(Message, Type, Duration);
		}),
	SetOSCList: (Callback) =>
		ipcRenderer.on("SetOSCList", (_event, Routes) => {
			Callback(Routes);
		}),
	ShutdownRequested: (Callback) =>
		ipcRenderer.on("ShutdownRequested", (_event) => {
			Callback();
		}),
	SetTimers: (Callback) =>
		ipcRenderer.on("SetTimers", (_event, Timers) => {
			Callback(Timers);
		}),
	UpdateSettings: (Callback) => ipcRenderer.on("UpdateSettings", (_event, Settings, SettingsGroupps) => {
			Callback(Settings, SettingsGroupps);
		}),
	SetSetting: async (Key, Value) => ipcRenderer.invoke("SetSetting", Key, Value),
	// Timer controls
	TimerStart: async (TimerID) => ipcRenderer.invoke("Timer:Start", TimerID),
	TimerStop: async (TimerID) => ipcRenderer.invoke("Timer:Stop", TimerID),
	TimerPause: async (TimerID) => ipcRenderer.invoke("Timer:Pause", TimerID),
	TimerUnpause: async (TimerID) => ipcRenderer.invoke("Timer:Unpause", TimerID),
	TimerGet: async (TimerID) => ipcRenderer.invoke("Timer:Get", TimerID),
	TimerUpdate: async (TimerID, Patch) => ipcRenderer.invoke("Timer:Update", TimerID, Patch),
	TimerCreate: async (Payload) => ipcRenderer.invoke("Timer:Create", Payload),
	TimerDelete: async (TimerID) => ipcRenderer.invoke("Timer:Delete", TimerID),
});
