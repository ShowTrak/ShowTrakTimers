var Config = {};

let Selected = [];
let AllClients = [];
let ScriptList = [];
const GroupUUIDCache = new Map();

let SettingsGroups = [];
let Settings = [];
let Timers = [];

window.API.SetTimers(async (NewTimers) => {
	Timers = NewTimers;
	for (const Timer of Timers) {
		await ProcessTimer(Timer);
	}
	return;
})

async function ProcessTimer(Timer) {
	let TimerElement = $(`#TIMER_${Timer.ID}`);
	if (TimerElement.length === 0) {
		$("#APPLICATION_CONTENT").append(`<div class="SHOWTRAK_TIMER card p-2 ${Timer.Status}" id="TIMER_${Timer.ID}">
			<h5 class="card-title mb-0"></h5>
			<p class="card-text mb-0">-</p>
			<div class="progress mt-2">
				<div class="progress-bar bg-light" role="progressbar" style="width: 0%;" id="TIMER_PROGRESS_${Timer.ID}"></div>
			</div>
			<span class="TIMER_CONTROLS">
				TEST
			</span>
			<span class="TIMER_ID">
				${Timer.ID}
			<span>
		</div>`);
		TimerElement = $(`#TIMER_${Timer.ID}`);
	}

	if (Timer.Type === "TIMER") {
		TimerElement.find(".card-title").text(Timer.Name);
		TimerElement.find(".card-text").eq(0).text(`${Timer.State.ElapsedTimeReadable} / ${Timer.TotalTimeReadable}`);
		TimerElement.find(".progress").find(".progress-bar").css("width", `${(Timer.State.ElapsedTime / Timer.Duration) * 100}%`);
		TimerElement.find(".TIMER_ID").text(`ID: ${Timer.ID}`);
		TimerElement.find(".TIMER_CONTROLS").text(Timer.Status);
	}

	if (Timer.Type === "STOPWATCH") {
		TimerElement.find(".card-title").text(Timer.Name);
		TimerElement.find(".card-text").eq(0).text(`${Timer.State.ElapsedTimeReadable}`);
		TimerElement.find(".progress").find(".progress-bar").css("width", `${(Timer.State.ElapsedTime / Timer.Duration) * 100}%`);
		TimerElement.find(".TIMER_ID").text(`ID: ${Timer.ID}`);
		TimerElement.find(".TIMER_CONTROLS").text(Timer.Status);
	}	

	$(`#TIMER_${Timer.ID}`).toggleClass("STANDBY", Timer.Status === "STANDBY");
	$(`#TIMER_${Timer.ID}`).toggleClass("RUNNING", Timer.Status === "RUNNING");
	$(`#TIMER_${Timer.ID}`).toggleClass("PAUSED", Timer.Status === "PAUSED");
	$(`#TIMER_${Timer.ID}`).toggleClass("COMPLETED", Timer.Status === "COMPLETED");

}

async function Start(TimerID) {

}

async function Stop(TimerID) {

}

async function Pause(TimerID) {

}

async function Unpause(TimerID) {

}

async function GetSettingValue(Key) {
	if (Settings.length == 0) Settings = await window.API.GetSettings();
	let Setting = Settings.find((s) => s.Key === Key);
	if (!Setting) return null;
	return Setting.Value;
}

let Sounds = {
	Notification: new Howl({
		src: ['audio/alert_1.wav'],
		volume: 0.5,
	}),
	Alert: new Howl({
		src: ['audio/alert_2.wav'],
		volume: 0.5,
	}),
	Warning: new Howl({
		src: ['audio/alert_3.wav'],
		volume: 0.5,
	}),
}


window.API.PlaySound(async (SoundName) => {
	let sound = Sounds[SoundName] || Sounds.Notification;
	sound.play();
})

window.API.UpdateSettings(async (NewSettings, NewSettingsGroups) => {
	Settings = NewSettings;
	SettingsGroups = NewSettingsGroups;

	$('#SETTINGS').html("");

	for (const Group of SettingsGroups) {
		$(`#SETTINGS`).append(`<div class="bg-ghost-light p-2 rounded">
			<strong class="text-start">
				${Group.Title}
			</strong>
		</div>`);
		let GroupSettings = Settings.filter((s) => s.Group == Group.Name);
		for (const Setting of GroupSettings) {
			if (Setting.Type === "BOOLEAN") {
				$(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-flex justify-content-between text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<div class="form-check form-switch">
						<input class="form-check-input" style="margin-top: 0.6em !important;" type="checkbox" id="SETTING_${Setting.Key}" ${Setting.Value ? "checked" : ""}>
					</div>
				</div>`);
				$(`#SETTING_${Setting.Key}`).off("change").on("change", async function () {
					let NewValue = $(this).is(":checked");
					if (NewValue === Setting.Value) return;
					let Set = Settings.find((s) => s.Key === Setting.Key);
					Set.Value = NewValue;
					Setting.Value = NewValue;
					await window.API.SetSetting(Setting.Key, NewValue);
					Notify(`[${Setting.Title}] ${NewValue ? 'Enabled' : 'Disabled'}`, NewValue ? 'success' : 'error');
				})
			}
		}
	}

	return;
	
})

function Safe(Input) {
	if (typeof Input === "string") {
		return Input.replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}
	if (typeof Input === "number") {
		return Input.toString();
	}
	if (Array.isArray(Input)) {
		return Input.map(Safe);
	}
	return Input;
}

window.API.ShutdownRequested(async () => {
	await CloseAllModals();
	let Confirmation = await ConfirmationDialog("Are you sure you want to shutdown ShowTrak?");
	if (!Confirmation) return;
	await window.API.Shutdown();
});

async function OpenOSCDictionary() {
	await CloseAllModals();
	$("#OSC_ROUTE_LIST_MODAL").modal("show");
}

window.API.Notify(async (Message, Type, Duration) => {
	Notify(Message, Type, Duration);
})

window.API.SetOSCList(async (Routes) => {
	$('#OSC_ROUTE_LIST').html("");
	$('#OSC_ROUTE_LIST').append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost-light rounded-3">
			The following OSC routes are accessible on port 3333.
		</div>
	`);
	for (const Route of Routes) {
		let PathFiller = "";
		for (const Segment of Route.Path.split("/").filter((s) => s.length > 0)) {
			PathFiller += `<span class="">/</span>`;
			if (Segment.startsWith(":")) {
				PathFiller += `<span class="text-info">[${Safe(Segment.substring(1))}]</span>`;
			} else {
				PathFiller += `<span>${Safe(Segment)}</span>`;
			}
		}

		$('#OSC_ROUTE_LIST').append(`
			<div class="d-grid gap-2 p-2 rounded bg-ghost rounded-3">
				<code class="bg-ghost rounded p-2">${PathFiller}</code>
				<p class="mb-0">${Safe(Route.Title)}</p>
			</div>
		`);
	}
	return;
})

async function CloseAllModals() {
	$(".modal").modal("hide");
	await Wait(300);
	return;
}

async function ImportConfig() {
	console.log("Starting import");
	await window.API.ImportConfig();
	await Notify("Restored from backup.", "success");
}

async function BackupConfig() {
	console.log("Starting backup");
	await window.API.BackupConfig();
	await Notify("Backup completed.", "success");
}


async function Wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function Notify(Message, Type = "info", Duration = 5000) {

	let Styles = {
		info: "linear-gradient(to right, rgb(63 59 104), rgb(56 52 109))",
		success: "linear-gradient(to right, rgb(40 167 69), rgb(30 139 54))",
		warning: "linear-gradient(to right, rgb(255 193 7), rgb(217 130 43))",
		error: "linear-gradient(to right, rgb(220 53 69), rgb(185 28 28))",
	}

	Toastify({
		text: Message,
		duration: Duration,
		close: false,
		gravity: "top", // `top` or `bottom`
		position: "right", // `left`, `center` or `right`
		stopOnFocus: true, // Prevents dismissing of toast on hover
		offset: {
			y: '2rem',
		},
		style: {
			background: Styles[Type] || Styles.info,
		},
	}).showToast();
}

async function ConfirmationDialog(Message) {
	return new Promise((resolve, reject) => {
		$("#SHOWTRAK_CONFIRMATION_MESSAGE").text(Message);

		$("#SHOWTRAK_CONFIRMATION_CANCEL")
			.off("click")
			.on("click", () => {
				$("#SHOWTRAL_MODAL_CONFIRMATION").modal("hide");
				resolve(false);
			});
		$("#SHOWTRAK_CONFIRMATION_CONFIRM")
			.off("click")
			.on("click", () => {
				$("#SHOWTRAL_MODAL_CONFIRMATION").modal("hide");
				resolve(true);
			});

		$("#SHOWTRAL_MODAL_CONFIRMATION").modal({
			backdrop: "static",
			keyboard: false,
		});
		$("#SHOWTRAL_MODAL_CONFIRMATION").modal("show");
	});
}

function ToggleSelection(UUID) {
	if (Selected.includes(UUID)) {
		Selected = Selected.filter((id) => id !== UUID);
		$(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass("SELECTED");
	} else {
		Selected.push(UUID);
		$(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass("SELECTED");
	}
	UpdateSelectionCount();
}

async function Init() {
	Config = await window.API.GetConfig();
	$("#APPLICATION_NAVBAR_TITLE").text(`${Config.Application.Name}`);
	$("#APPLICATION_NAVBAR_STATUS").text(`v${Config.Application.Version}`);

	$("#NAVBAR_CORE_BUTTON").on("click", async () => {
		$("#SHOWTRAK_MODEL_CORE").modal("show");
	});

	$('#SHOWTRAK_MODEL_CORE_OPEN_SETTINGS').on("click", async () => {
		await CloseAllModals();
		$("#SHOWTRAK_MODAL_SETTINGS").modal("show")
	})

	$("#SHOWTRAK_MODEL_CORE_OSC_ROUTE_LIST_BUTTON").on("click", async () => {
		await OpenOSCDictionary();
	});

	$("#SHOWTRAK_MODEL_CORE_LOGSFOLDER").on("click", async () => {
		await window.API.OpenLogsFolder();
	});

	$("#SHOWTRAK_MODEL_CORE_BACKUPCONFIG").on("click", async () => {
		await BackupConfig();
	});

	$("#SHOWTRAK_MODEL_CORE_IMPORTCONFIG").on("click", async () => {
		await ImportConfig();
	});

	$("#SHOWTRAK_MODEL_CORE_SUPPORTDISCORD").on("click", async () => {
		await window.API.OpenDiscordInviteLinkInBrowser();
	});

	$("#SHOWTRAK_MODEL_CORE_SHUTDOWN_BUTTON").on("click", async () => {
		window.API.Shutdown();
	});

	await window.API.Loaded();
}

Init();
