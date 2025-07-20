const { app, BrowserWindow, ipcMain: RPC, Menu } = require("electron/main");
if (require("electron-squirrel-startup")) app.quit();

const { Manager: AppDataManager } = require("./Modules/AppData");
AppDataManager.Initialize();
const { CreateLogger } = require("./Modules/Logger");
const Logger = CreateLogger("Main");
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
	Logger.error("Another instance of ShowTrak Timers is already running. Exiting this instance.");
	app.quit();
	process.exit(0);
} else {
	Logger.log("Single instance lock acquired");
}

const { Config } = require("./Modules/Config");
const { Manager: FileSelectorManager } = require("./Modules/FileSelectorManager");
const { Manager: BackupManager } = require("./Modules/BackupManager");
const { Manager: BroadcastManager } = require("./Modules/Broadcast");
const { Manager: SettingsManager } = require("./Modules/SettingsManager");
const { Manager: TimerManager } = require("./Modules/TimerManager");
const { OSC } = require("./Modules/OSC");
const { Wait } = require("./Modules/Utils");
const path = require("path");

var MainWindow = null;

if (app.isPackaged) Menu.setApplicationMenu(null);
let PreloaderWindow = null;
app.whenReady().then(async () => {
	if (require("electron-squirrel-startup")) return app.quit();

	if (MainWindow) {
		MainWindow.close();
		MainWindow = null;
	}

	let SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4 = await SettingsManager.GetValue("SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4")
	if (SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4) {
		app.on("web-contents-created", (_, contents) => {
			contents.on("before-input-event", (event, input) => {
				if (input.code == "F4" && input.alt) {
					event.preventDefault();
					if (!MainWindow || !MainWindow.isVisible()) return Shutdown();
					Logger.warn("Prevented alt+f4 shutdown, passing request to agent");
					MainWindow.webContents.send("ShutdownRequested");
				}
			});
		});
	}

	PreloaderWindow = new BrowserWindow({
		show: false,
		backgroundColor: "#161618",
		width: 400,
		height: 500,
		resizable: false,
		webPreferences: {
			preload: path.join(__dirname, "bridge_preloader.js"),
			devTools: !app.isPackaged,
		},
		icon: path.join(__dirname, "./Images/icon.ico"),
		frame: true,
		titleBarStyle: "hidden",
	});

	PreloaderWindow.once("ready-to-show", () => {
		PreloaderWindow.show();
	});

	PreloaderWindow.loadFile(path.join(__dirname, 'UI', 'preloader.html'));

	MainWindow = new BrowserWindow({
		show: false,
		backgroundColor: "#161618",
		width: 535,
		height: 940,
		minWidth: 535,
		minHeight: 600,
		webPreferences: {
			preload: path.join(__dirname, "bridge_main.js"),
			devTools: !app.isPackaged,
		},
		icon: path.join(__dirname, "./Images/icon.ico"),
		frame: true,
		titleBarStyle: "hidden",
	});

	MainWindow.loadFile(path.join(__dirname, 'UI', 'index.html')).then(async () => {
		Logger.log("MainWindow finished loading UI");
		await Wait(800);
		PreloaderWindow.close();
		MainWindow.show();
	});

	RPC.handle("BackupConfig", async () => {
		let { canceled, filePath } = await FileSelectorManager.SaveDialog("Export ShowTrak Configuration");
		if (canceled || !filePath) {
			Logger.log("BackupConfig canceled");
			return ["Cancelled By User", null];
		}
		Logger.log("Backing up configuration to:", filePath);
		let [Err, Result] = await BackupManager.ExportConfig(filePath);
		if (Err) return [Err, null];
		return [null, Result];
	});

	RPC.handle("ImportConfig", async () => {
		let { canceled, filePaths } = await FileSelectorManager.SelectFile(
			"Select ShowTrak Configuration File to Import"
		);
		if (canceled || !filePaths) {
			console.log(canceled, filePaths);
			Logger.log("ImportConfig canceled");
			return ["Cancelled By User", null];
		}
		if (filePaths.length === 0) {
			Logger.log("No files selected for import");
			return ["No files selected for import", null];
		}
		Logger.log("Importing configuration from:", filePaths[0]);
		let [Err, Result] = await BackupManager.ImportConfig(filePaths[0]);
		if (Err) return [Err, null];
		return [null, Result];
	});

	RPC.handle("Config:Get", async () => {
		return Config;
	});

	RPC.handle("Settings:Get", async () => {
		let Settings = await SettingsManager.GetAll();
		return Settings
	});

	RPC.handle("Loaded", async () => {
		Logger.log("Application Page Hot Reloaded");
		await UpdateSettings();
		await UpdateOSCList();
		await HandleUpdateTimerList();
		return;
	});

	async function Shutdown() {
		Logger.log("Application shutdown requested");
		app.quit();
		return process.exit(0);
	}

	RPC.handle("Shutdown", async () => {
		Shutdown();
	});

	RPC.handle("OpenLogsFolder", async (_event) => {
		let LogsPath = AppDataManager.GetLogsDirectory();
		Logger.log("Opening logs folder:", LogsPath);
		require("child_process").exec(`start ${LogsPath}`);
		return;
	});

	RPC.handle("OpenDiscordInviteLinkInBrowser", async (_event, _URL) => {
		var url = "https://discord.gg/DACmwsbSGW";
		var start = process.platform == "darwin" ? "open" : process.platform == "win32" ? "start" : "xdg-open";
		require("child_process").exec(start + " " + url);
		return;
	});

	RPC.handle("SetSetting", async (_event, Key, Value) => {
		let [Err, Setting] = await SettingsManager.Set(Key, Value);
		if (Err) return [Err, null];
		return [null, Setting];
	});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			// TODO: Recreate the main window
		}
	});

	// MainWindow.webContents.openDevTools();
});

async function UpdateSettings() {
	if (!MainWindow || MainWindow.isDestroyed()) return;
	let Settings = await SettingsManager.GetAll();
	let SettingGroups = await SettingsManager.GetGroups();
	MainWindow.webContents.send("UpdateSettings", Settings, SettingGroups);
}

BroadcastManager.on("SettingsUpdated", UpdateSettings);

async function ReinitializeSystem() {
	if (!MainWindow || MainWindow.isDestroyed()) return;
	Logger.log("Reinitializing system...");
	await ClientManager.ClearCache();
	await AdoptionManager.ClearAllDevicesPendingAdopption();
	let [ClientsErr, Clients] = await ClientManager.GetAll();
	if (ClientsErr) return Logger.error("Failed to fetch full client list:", ClientsErr);
	let [GroupsErr, Groups] = await GroupManager.GetAll();
	if (GroupsErr) return Logger.error("Failed to fetch client groups:", GroupsErr);
	MainWindow.webContents.send("SetFullClientList", Clients, Groups);
}
BroadcastManager.on("ReinitializeSystem", ReinitializeSystem);

async function UpdateOSCList() {
	if (!MainWindow || MainWindow.isDestroyed()) return;
	let Routes = OSC.GetRoutes();
	MainWindow.webContents.send("SetOSCList", JSON.parse(JSON.stringify(Routes)));
}

async function Notify(Message, Type = "info", Duration = 5000) {
	if (!MainWindow || MainWindow.isDestroyed()) return;
	MainWindow.webContents.send("Notify", Message, Type, Duration);
}
BroadcastManager.on("Notify", Notify)

async function PlaySound(SoundName) {
	MainWindow.webContents.send("PlaySound", SoundName);
}
BroadcastManager.on("PlaySound", PlaySound)

async function PlaySound(SoundName) {
	MainWindow.webContents.send("PlaySound", SoundName);
}

async function HandleUpdateTimerList(Timers) {
	if (!Timers) Timers = await TimerManager.GetAll();
	MainWindow.webContents.send("SetTimers", Timers);
}

BroadcastManager.on("TimersUpdated", HandleUpdateTimerList)

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

const { powerSaveBlocker } = require("electron");
async function StartOptionalFeatures() {
	let SYSTEM_PREVENT_DISPLAY_SLEEP = await SettingsManager.GetValue("SYSTEM_PREVENT_DISPLAY_SLEEP")
	if (SYSTEM_PREVENT_DISPLAY_SLEEP) {
		Logger.log("Prevent Display Sleep is enabled, starting powerSaveBlocker.");
		powerSaveBlocker.start("prevent-display-sleep");
	} else {
		Logger.log("Prevent Display Sleep is disabled in settings, not starting powerSaveBlocker.");
	}

	let SYSTEM_AUTO_UPDATE = await SettingsManager.GetValue("SYSTEM_AUTO_UPDATE");
	if (SYSTEM_AUTO_UPDATE) {
		Logger.log("Automatic updates are enabled, starting update process...");
		const { updateElectronApp } = require("update-electron-app");
		updateElectronApp({
			notifyUser: true,
		});
	} else {
		Logger.log("Automatic updates are disabled in settings, not starting update process.");
	}
}
StartOptionalFeatures()

app.on("will-quit", (_event) => {
	Logger.log("App is closing, performing cleanup...");
});
