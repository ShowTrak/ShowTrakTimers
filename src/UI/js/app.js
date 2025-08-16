var Config = {};

let Selected = [];
let AllClients = [];
let ScriptList = [];
const GroupUUIDCache = new Map();

let SettingsGroups = [];
let Settings = [];
let Timers = [];
let _lastTimersJson = '';

// --- Application Mode (SHOW | EDIT) UI state ---
let AppMode = 'SHOW'; // default until backend confirms
function RenderMode(mode) {
  AppMode = String(mode).toUpperCase() === 'EDIT' ? 'EDIT' : 'SHOW';
  // Highlight the active button like ShowTrakServer
  const btnShow = document.getElementById('MODE_BTN_SHOW');
  const btnEdit = document.getElementById('MODE_BTN_EDIT');
  if (btnShow && btnEdit) {
    const activeClasses = ['btn-light', 'text-dark'];
    const inactiveClasses = ['btn-outline-light', 'text-light'];
    // reset
    btnShow.classList.remove(...activeClasses, ...inactiveClasses);
    btnEdit.classList.remove(...activeClasses, ...inactiveClasses);
    if (AppMode === 'SHOW') {
      btnShow.classList.add(...activeClasses);
      btnEdit.classList.add(...inactiveClasses);
    } else {
      btnEdit.classList.add(...activeClasses);
      btnShow.classList.add(...inactiveClasses);
    }
  }
  document.body.classList.toggle('mode-edit', AppMode === 'EDIT');

  // Ensure edit-only controls are shown/hidden immediately across all timers
  try {
    const showEdit = AppMode === 'EDIT';
    document
      .querySelectorAll("#APPLICATION_CONTENT .overlay-btn[data-action='edit']")
      .forEach((btn) => btn.classList.toggle('d-none', !showEdit));
  } catch {}
}

// Subscribe to backend push updates (parity with Server)
if (window.API && typeof window.API.OnModeUpdated === 'function') {
  try {
    window.API.OnModeUpdated((mode) => {
      RenderMode(mode);
    });
  } catch {}
}

document.addEventListener('DOMContentLoaded', async () => {
  // Wire mode buttons
  const btnShow = document.getElementById('MODE_BTN_SHOW');
  const btnEdit = document.getElementById('MODE_BTN_EDIT');
  if (btnShow && !btnShow.dataset.bound) {
    btnShow.addEventListener('click', async (e) => {
      // Match Server: prefer backend; fall back to local render
      if (window.API && typeof window.API.SetMode === 'function') {
        try {
          await window.API.SetMode('SHOW');
        } catch {}
      } else {
        RenderMode('SHOW');
      }
      // Remove focus ring immediately
      try {
        e.currentTarget.blur();
      } catch {}
    });
    btnShow.dataset.bound = '1';
  }
  if (btnEdit && !btnEdit.dataset.bound) {
    btnEdit.addEventListener('click', async (e) => {
      if (window.API && typeof window.API.SetMode === 'function') {
        try {
          await window.API.SetMode('EDIT');
        } catch {}
      } else {
        RenderMode('EDIT');
      }
      // Remove focus ring immediately
      try {
        e.currentTarget.blur();
      } catch {}
    });
    btnEdit.dataset.bound = '1';
  }
  // Initial mode from backend if provided
  if (window.API && typeof window.API.GetMode === 'function') {
    try {
      RenderMode(await window.API.GetMode());
    } catch {
      RenderMode('SHOW');
    }
  } else {
    RenderMode('SHOW');
  }

  // Keyboard shortcuts (only K for shortcuts modal retained)
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      try {
        ShowShortcutsModal();
      } catch {}
      return;
    }
  });
});

// Create a new timer and open the editor immediately
async function CreateTimerAndEdit() {
  try {
    const payload = { Type: 'TIMER', Name: 'New Timer', Duration: 300000 }; // default 5m
    const [err, timer] = await window.API.TimerCreate(payload);
    if (err || !timer) return Notify(err || 'Failed to create timer', 'error');
    await OpenTimerEditModal(timer.ID);
  } catch (e) {
    Notify(`Failed to create timer: ${e.message || e}`, 'error');
  }
}

// Bind plus button; ensure single binding
document.addEventListener('DOMContentLoaded', () => {
  const addBtn = document.getElementById('ADD_TIMER_BUTTON');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.addEventListener('click', async () => {
      await CreateTimerAndEdit();
    });
    addBtn.dataset.bound = '1';
  }
});

function renderEmptyStateHtml() {
  return `
		<div id="EMPTY_STATE" class="d-flex w-100 align-items-center justify-content-center" style="min-height: 60vh;">
			<div class="card bg-ghost-light border-0 rounded-3 p-3" style="max-width: 720px;">
				<div class="card-body text-start">
					<div class="d-flex align-items-center gap-2 mb-2">
						<img src="./img/icon.png" alt="ShowTrak Logo" style="width:28px;height:28px;" />
						<strong>Welcome to ShowTrak Timers</strong>
					</div>
					<p class="mb-2 text-sm">
						You don’t have any timers yet. Create your first timer to get started. You can make standard timers or stopwatches,
						then control them from here or view them on the web panel.
					</p>
					<div class="d-grid gap-2 bg-ghost rounded-3 p-2 mb-2">
						<div class="d-flex gap-2 align-items-start">
							<i class="bi bi-plus-lg text-light mt-1"></i>
							<div>
								<strong>Add a timer</strong>
								<div class="text-sm">Use the + button in the bottom-right or the button below.</div>
							</div>
						</div>
						<div class="d-flex gap-2 align-items-start">
							<i class="bi bi-gear-fill text-light mt-1"></i>
							<div>
								<strong>Adjust settings</strong>
								<div class="text-sm">Open Settings to configure the Web Panel and OSC controls.</div>
							</div>
						</div>
					</div>
					<div class="d-flex gap-2 flex-wrap">
						<button id="EMPTY_CREATE_BTN" class="btn btn-light">Create your first timer</button>
						<button id="EMPTY_SETTINGS_BTN" class="btn btn-outline-light">Open Settings</button>
					</div>
				</div>
			</div>
		</div>`;
}

window.API.SetTimers(async (NewTimers) => {
  const safe = Array.isArray(NewTimers) ? NewTimers : [];
  // Shallow stable check via JSON string (timers are small)
  const j = JSON.stringify(
    safe.map((t) => ({
      ID: t.ID,
      Type: t.Type,
      Name: t.Name,
      Duration: t.Duration,
      Status: t.Status,
      // include minimal state needed for UI
      E: t.State && t.State.ElapsedTime,
      TR: t.TotalTimeReadable,
    }))
  );
  if (j === _lastTimersJson) return; // no UI change needed
  _lastTimersJson = j;
  Timers = safe;
  const $host = $('#APPLICATION_CONTENT');
  if (Timers.length === 0) {
    // If empty state already present, skip DOM work
    if (!document.getElementById('EMPTY_STATE')) {
      $host.empty().append(renderEmptyStateHtml());
      $('#EMPTY_CREATE_BTN')
        .off('click')
        .on('click', async () => {
          await CreateTimerAndEdit();
        });
      $('#EMPTY_SETTINGS_BTN')
        .off('click')
        .on('click', async () => {
          await CloseAllModals();
          $('#SHOWTRAK_MODAL_SETTINGS').modal('show');
        });
    }
    return;
  }
  // Remove empty state if present and render/update cards
  if (document.getElementById('EMPTY_STATE')) {
    $('#EMPTY_STATE').remove();
  }

  // Reconcile: remove any timer cards that are no longer present
  try {
    const newIds = new Set(Timers.map((t) => String(t.ID)));
    $('#APPLICATION_CONTENT .SHOWTRAK_TIMER').each(function () {
      const el = this;
      const idAttr = el.getAttribute('data-timerid') || (el.id || '').replace('TIMER_', '');
      if (!newIds.has(String(idAttr))) {
        try {
          el.remove();
        } catch {}
      }
    });
  } catch {}
  for (const Timer of Timers) {
    await ProcessTimer(Timer);
  }
  return;
});

async function ProcessTimer(Timer) {
  let TimerElement = $(`#TIMER_${Timer.ID}`);
  if (TimerElement.length === 0) {
    $('#APPLICATION_CONTENT')
      .append(`<div class="SHOWTRAK_TIMER card p-2 ${Timer.Status}" id="TIMER_${Timer.ID}" data-timerid="${Timer.ID}" data-type="${Timer.Type}">
			<h5 class="card-title mb-0"></h5>
			<p class="card-text mb-0">-</p>
			<div class="progress mt-2">
				<div class="progress-bar bg-light" role="progressbar" style="width: 0%;" id="TIMER_PROGRESS_${Timer.ID}"></div>
			</div>
			<div class="timer-controls-overlay" aria-hidden="true">
				<div class="controls" id="TIMER_CTRL_CONTAINER_${Timer.ID}">
					<button type="button" class="overlay-btn" data-action="start" title="Start">
						<i class="bi bi-play-fill"></i>
					</button>
					<button type="button" class="overlay-btn" data-action="pause" title="Pause">
						<i class="bi bi-pause-fill"></i>
					</button>
					<button type="button" class="overlay-btn" data-action="stop" title="Stop">
						<i class="bi bi-stop-fill"></i>
					</button>
					<button type="button" class="overlay-btn edit-only" data-action="edit" title="Edit">
						<i class="bi bi-gear-fill"></i>
					</button>
				</div>
			</div>
			<span class="TIMER_CONTROLS"></span>
			<span class="TIMER_ID">
				${Timer.ID}
			<span>
		</div>`);
    TimerElement = $(`#TIMER_${Timer.ID}`);
    // Wire controls once
    const id = Timer.ID;
    const $ctr = $(`#TIMER_CTRL_CONTAINER_${id}`);
    $ctr.off('click').on('click', 'button.overlay-btn', async function (e) {
      e.stopPropagation();
      const action = $(this).attr('data-action');
      try {
        const $card = $(this).closest('.SHOWTRAK_TIMER');
        const status =
          ($card.hasClass('PAUSED') && 'PAUSED') ||
          ($card.hasClass('RUNNING') && 'RUNNING') ||
          ($card.hasClass('STANDBY') && 'STANDBY') ||
          ($card.hasClass('COMPLETE') && 'COMPLETE');
        if (action === 'start') {
          if (status === 'PAUSED') await Unpause(id);
          else await Start(id);
        } else if (action === 'pause') {
          await Pause(id);
        } else if (action === 'stop') {
          await Stop(id);
        } else if (action === 'edit') {
          await OpenTimerEditModal(id);
        }
      } catch {}
    });
  }

  if (Timer.Type === 'TIMER') {
    TimerElement.find('.card-title').text(Timer.Name);
    TimerElement.find('.card-text')
      .eq(0)
      .text(`${Timer.State.ElapsedTimeReadable} / ${Timer.TotalTimeReadable}`);
    let pct = 0;
    if (typeof Timer.Duration === 'number' && Timer.Duration > 0) {
      pct = Math.max(0, Math.min(100, (Timer.State.ElapsedTime / Timer.Duration) * 100));
    }
    const $bar = TimerElement.find('.progress').find('.progress-bar');
    const prev = $bar.data('w') || -1;
    const next = Math.round(pct);
    if (prev !== next) {
      $bar.css('width', `${next}%`).data('w', next);
    }
    TimerElement.find('.TIMER_ID').text(`ID: ${Timer.ID}`);
    TimerElement.find('.TIMER_CONTROLS').text(Timer.Status);
  }

  if (Timer.Type === 'STOPWATCH') {
    TimerElement.find('.card-title').text(Timer.Name);
    TimerElement.find('.card-text').eq(0).text(`${Timer.State.ElapsedTimeReadable}`);
    // Stopwatch has no duration target; keep the progress static
    TimerElement.find('.progress').find('.progress-bar').css('width', `0%`);
    TimerElement.find('.TIMER_ID').text(`ID: ${Timer.ID}`);
    TimerElement.find('.TIMER_CONTROLS').text(Timer.Status);
  }

  const $Card = $(`#TIMER_${Timer.ID}`);
  $Card.toggleClass('STANDBY', Timer.Status === 'STANDBY');
  $Card.toggleClass('RUNNING', Timer.Status === 'RUNNING');
  $Card.toggleClass('PAUSED', Timer.Status === 'PAUSED');
  $Card.toggleClass('COMPLETE', Timer.Status === 'COMPLETE');
  $Card.attr('data-status', Timer.Status);

  // Update visible controls based on state (no layout shift)
  const $buttons = $(`#TIMER_CTRL_CONTAINER_${Timer.ID} button.overlay-btn`);
  const showBtn = (act, show) =>
    $buttons.filter(`[data-action='${act}']`).toggleClass('d-none', !show);
  if (Timer.Status === 'RUNNING') {
    showBtn('start', false);
    showBtn('pause', true);
    showBtn('stop', true);
  } else if (Timer.Status === 'PAUSED') {
    showBtn('start', true); // resume
    showBtn('pause', false);
    showBtn('stop', true);
  } else if (Timer.Status === 'STANDBY') {
    showBtn('start', true);
    showBtn('pause', false);
    showBtn('stop', false);
  } else {
    // COMPLETE or other
    showBtn('start', true);
    showBtn('pause', false);
    showBtn('stop', true);
  }

  // Show edit cog only in EDIT application mode
  const showEdit = AppMode === 'EDIT';
  $(`#TIMER_CTRL_CONTAINER_${Timer.ID} button.overlay-btn[data-action='edit']`).toggleClass(
    'd-none',
    !showEdit
  );
}

async function Start(TimerID) {
  try {
    const [err] = await window.API.TimerStart(TimerID);
    if (err) throw new Error(err);
  } catch (e) {
    Notify(`Failed to start timer ${TimerID}: ${e.message || e}`, 'error');
  }
}

async function Stop(TimerID) {
  try {
    const [err] = await window.API.TimerStop(TimerID);
    if (err) throw new Error(err);
  } catch (e) {
    Notify(`Failed to stop timer ${TimerID}: ${e.message || e}`, 'error');
  }
}

async function Pause(TimerID) {
  try {
    const [err] = await window.API.TimerPause(TimerID);
    if (err) throw new Error(err);
  } catch (e) {
    Notify(`Failed to pause timer ${TimerID}: ${e.message || e}`, 'error');
  }
}

async function Unpause(TimerID) {
  try {
    const [err] = await window.API.TimerUnpause(TimerID);
    if (err) throw new Error(err);
  } catch (e) {
    Notify(`Failed to resume timer ${TimerID}: ${e.message || e}`, 'error');
  }
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
};

window.API.PlaySound(async (SoundName) => {
  let sound = Sounds[SoundName] || Sounds.Notification;
  sound.play();
});

window.API.UpdateSettings(async (NewSettings, NewSettingsGroups) => {
  Settings = NewSettings;
  SettingsGroups = NewSettingsGroups;

  $('#SETTINGS').html('');

  for (const Group of SettingsGroups) {
    $(`#SETTINGS`).append(`<div class="bg-ghost-light p-2 rounded">
			<strong class="text-start">
				${Group.Title}
			</strong>
		</div>`);
    let GroupSettings = Settings.filter((s) => s.Group == Group.Name);
    for (const Setting of GroupSettings) {
      if (Setting.Type === 'BOOLEAN') {
        $(`#SETTINGS`)
          .append(`<div class="bg-ghost p-2 rounded d-flex justify-content-between text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<div class="form-check form-switch">
						<input class="form-check-input" style="margin-top: 0.6em !important;" type="checkbox" id="SETTING_${Setting.Key}" ${Setting.Value ? 'checked' : ''}>
					</div>
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('change')
          .on('change', async function () {
            let NewValue = $(this).is(':checked');
            if (NewValue === Setting.Value) return;
            let Set = Settings.find((s) => s.Key === Setting.Key);
            Set.Value = NewValue;
            Setting.Value = NewValue;
            await window.API.SetSetting(Setting.Key, NewValue);
            Notify(
              `[${Setting.Title}] ${NewValue ? 'Enabled' : 'Disabled'}`,
              NewValue ? 'success' : 'error'
            );
          });
      } else if (Setting.Type === 'INTEGER') {
        const id = `SETTING_${Setting.Key}`;
        const saveId = `SAVE_${Setting.Key}`;
        const current = Number(Setting.Value) || 0;
        const requiresSave = !!Setting.RequiresSave;
        $(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid text-start gap-1">
					<div class="d-flex justify-content-between align-items-center gap-2 flex-wrap">
						<div class="d-grid flex-grow-1">
							<span>${Setting.Title}</span>
							<span class="text-sm mb-0">${Setting.Description}</span>
						</div>
						<div class="d-flex align-items-center gap-2">
							<input type="number" class="form-control form-control-sm" id="${id}" value="${current}" style="max-width: 140px;" />
							${requiresSave ? `<button class="btn btn-sm btn-primary" id="${saveId}" disabled>Save</button>` : ''}
						</div>
					</div>
				</div>`);
        let pendingVal = current;
        let dirty = false;
        let debounceTimer;
        const applyOrEnable = async () => {
          if (!requiresSave) {
            try {
              const [err] = await window.API.SetSetting(Setting.Key, pendingVal);
              if (err) {
                Notify(err, 'error');
                return;
              }
              Notify(`[${Setting.Title}] set to ${pendingVal}`, 'success');
            } catch (e) {
              Notify(String(e && e.message ? e.message : e), 'error');
            }
          } else {
            $(`#${saveId}`).prop('disabled', !dirty);
          }
        };
        $(`#${id}`)
          .off('input change')
          .on('input change', function () {
            clearTimeout(debounceTimer);
            const val = Number($(this).val());
            pendingVal = Number.isFinite(val) ? val : 0;
            dirty = pendingVal !== current;
            debounceTimer = setTimeout(applyOrEnable, 300);
          });
        if (requiresSave) {
          $(`#${saveId}`)
            .off('click')
            .on('click', async () => {
              try {
                const [err] = await window.API.SetSetting(Setting.Key, pendingVal);
                if (err) {
                  Notify(err, 'error');
                  return;
                }
                Setting.Value = pendingVal;
                Notify(`[${Setting.Title}] saved as ${pendingVal}`, 'success');
                $(`#${saveId}`).prop('disabled', true);
              } catch (e) {
                Notify(String(e && e.message ? e.message : e), 'error');
              }
            });
        }
      } else if (Setting.Type === 'TEXT') {
        const id = `SETTING_${Setting.Key}`;
        const saveId = `SAVE_${Setting.Key}`;
        const current = String(Setting.Value || '');
        const requiresSave = !!Setting.RequiresSave;
        $(`#SETTINGS`).append(`<div class="bg-ghost p-2 rounded d-grid text-start gap-1">
					<div class="d-flex justify-content-between align-items-center gap-2 flex-wrap">
						<div class="d-grid flex-grow-1">
							<span>${Setting.Title}</span>
							<span class="text-sm mb-0">${Setting.Description}</span>
						</div>
						<div class="d-flex align-items-center gap-2">
							<input type="text" class="form-control form-control-sm" id="${id}" value="${current}" style="max-width: 220px;" />
							${requiresSave ? `<button class="btn btn-sm btn-primary" id="${saveId}" disabled>Save</button>` : ''}
						</div>
					</div>
				</div>`);
        let pendingVal = current;
        let dirty = false;
        let debounceTimer;
        const applyOrEnable = async () => {
          if (!requiresSave) {
            try {
              const [err] = await window.API.SetSetting(Setting.Key, pendingVal);
              if (err) {
                Notify(err, 'error');
                return;
              }
              Notify(`[${Setting.Title}] updated`, 'success');
            } catch (e) {
              Notify(String(e && e.message ? e.message : e), 'error');
            }
          } else {
            $(`#${saveId}`).prop('disabled', !dirty);
          }
        };
        $(`#${id}`)
          .off('input change')
          .on('input change', function () {
            clearTimeout(debounceTimer);
            pendingVal = String($(this).val() || '').trim();
            dirty = pendingVal !== current;
            debounceTimer = setTimeout(applyOrEnable, 300);
          });
        if (requiresSave) {
          $(`#${saveId}`)
            .off('click')
            .on('click', async () => {
              try {
                const [err] = await window.API.SetSetting(Setting.Key, pendingVal);
                if (err) {
                  Notify(err, 'error');
                  return;
                }
                Setting.Value = pendingVal;
                Notify(`[${Setting.Title}] saved`, 'success');
                $(`#${saveId}`).prop('disabled', true);
              } catch (e) {
                Notify(String(e && e.message ? e.message : e), 'error');
              }
            });
        }
      }
    }
  }

  return;
});

function Safe(Input) {
  if (typeof Input === 'string') {
    return Input.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (typeof Input === 'number') {
    return Input.toString();
  }
  if (Array.isArray(Input)) {
    return Input.map(Safe);
  }
  return Input;
}

window.API.ShutdownRequested(async () => {
  await CloseAllModals();
  let Confirmation = await ConfirmationDialog('Are you sure you want to shutdown ShowTrak?');
  if (!Confirmation) return;
  await window.API.Shutdown();
});

async function OpenOSCDictionary() {
  await CloseAllModals();
  $('#OSC_ROUTE_LIST_MODAL').modal('show');
}

window.API.Notify(async (Message, Type, Duration) => {
  // Keep toast notifications only
  Notify(Message, Type, Duration);
});

window.API.SetOSCList(async (Routes) => {
  $('#OSC_ROUTE_LIST').html('');
  $('#OSC_ROUTE_LIST').append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost-light rounded-3">
			<span id="OSC_ROUTE_LIST_PORT_TEXT">The following OSC routes are accessible.</span>
		</div>
	`);
  // Try to reflect current OSC port if available from settings
  try {
    const Settings = await window.API.GetSettings();
    const oscPortSetting = Settings.find((s) => s.Key === 'OSC_PORT');
    const oscBindSetting = Settings.find((s) => s.Key === 'OSC_BIND');
    const port =
      oscPortSetting && Number(oscPortSetting.Value) ? Number(oscPortSetting.Value) : 3333;
    const bind =
      oscBindSetting && String(oscBindSetting.Value || '').trim()
        ? String(oscBindSetting.Value).trim()
        : '0.0.0.0';
    $('#OSC_ROUTE_LIST_PORT_TEXT').text(
      `The following OSC routes are accessible on ${bind}:${port}.`
    );
  } catch {
    /* ignore */
  }
  for (const Route of Routes) {
    let PathFiller = '';
    for (const Segment of Route.Path.split('/').filter((s) => s.length > 0)) {
      PathFiller += `<span class="">/</span>`;
      if (Segment.startsWith(':')) {
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
});

async function CloseAllModals() {
  $('.modal').modal('hide');
  await Wait(300);
  return;
}

async function ImportConfig() {
  console.log('Starting import');
  await window.API.ImportConfig();
  await Notify('Restored from backup.', 'success');
}

async function BackupConfig() {
  console.log('Starting backup');
  await window.API.BackupConfig();
  await Notify('Backup completed.', 'success');
}

async function Wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iconForType(type) {
  const t = String(type || 'info').toLowerCase();
  if (t === 'success') return '<i class="bi bi-check-circle-fill"></i>';
  if (t === 'warning') return '<i class="bi bi-exclamation-triangle-fill"></i>';
  if (t === 'error') return '<i class="bi bi-x-circle-fill"></i>';
  return '<i class="bi bi-info-circle-fill"></i>';
}

function ensureToastHost() {
  let host = document.getElementById('ALERTS_TOAST_HOST');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ALERTS_TOAST_HOST';
    host.className = 'alert-toast-host';
    document.body.appendChild(host);
  }
  return host;
}

async function Notify(Message, Type = 'info', Duration = 5000) {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = 'alert-item alert-toast single-line';
  el.innerHTML = `
		<div class="alert-icon">${iconForType(Type)}</div>
		<div class="alert-content"><div><strong>${Safe(String(Message || 'Notice'))}</strong></div></div>
		<div class="alert-dismiss"><button class="btn-dismiss" title="Dismiss" aria-label="Dismiss">✕</button></div>
	`;
  host.appendChild(el);
  const btn = el.querySelector('.btn-dismiss');
  if (btn)
    btn.addEventListener('click', () => {
      try {
        el.remove();
      } catch {}
    });
  if (Duration && Duration > 0) {
    let remaining = Duration;
    let timerId = null;
    let lastStart = Date.now();
    const clear = () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
    const tick = () => {
      clear();
      lastStart = Date.now();
      timerId = setTimeout(() => {
        try {
          el.remove();
        } catch {}
      }, remaining);
    };
    const onMouseEnter = () => {
      remaining -= Date.now() - lastStart;
      if (remaining < 0) remaining = 0;
      clear();
    };
    const onMouseLeave = () => {
      if (remaining === 0) {
        try {
          el.remove();
        } catch {}
      } else {
        tick();
      }
    };
    el.addEventListener('mouseenter', onMouseEnter);
    el.addEventListener('mouseleave', onMouseLeave);
    tick();
  }
}

// Alerts UI removed

function ShowShortcutsModal() {
  try {
    const list = document.getElementById('KEYBOARD_SHORTCUTS_LIST');
    if (list) {
      list.innerHTML = '';
      const rows = [
        { k: 'Ctrl+K', t: 'Open Keyboard Shortcuts' },
        { k: 'Ctrl+Y', t: 'Toggle Alerts Tray' },
        { k: 'Ctrl+U', t: 'Dismiss All Alerts' },
      ];
      for (const r of rows) {
        const div = document.createElement('div');
        div.className = 'd-flex justify-content-between bg-ghost rounded p-2';
        div.innerHTML = `<span>${r.t}</span><code class="bg-ghost-light rounded px-2">${r.k}</code>`;
        list.appendChild(div);
      }
    }
    $('#SHOWTRAK_MODAL_SHORTCUTS').modal('show');
  } catch {}
}

function parseDurationToMs(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null; // treat empty as null (stopwatch)
  const parts = s.split(':').map((v) => v.trim());
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return null;
  let h = 0,
    m = 0,
    sec = 0;
  if (parts.length === 1) {
    sec = Number(parts[0]);
  } else if (parts.length === 2) {
    m = Number(parts[0]);
    sec = Number(parts[1]);
  } else if (parts.length === 3) {
    h = Number(parts[0]);
    m = Number(parts[1]);
    sec = Number(parts[2]);
  } else {
    return null;
  }
  if (m < 0 || sec < 0 || h < 0) return null;
  return (h * 3600 + m * 60 + sec) * 1000;
}

function formatMsToHMS(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function OpenTimerEditModal(TimerID) {
  try {
    const [err, timer] = await window.API.TimerGet(TimerID);
    if (err || !timer) return Notify(err || 'Timer not found', 'error');
    // Prefill
    $('#TIMER_EDIT_NAME').val(timer.Name || '');
    const durationText =
      timer.Type === 'STOPWATCH' || timer.Duration == null ? '' : formatMsToHMS(timer.Duration);
    $('#TIMER_EDIT_TYPE').val(timer.Type === 'STOPWATCH' ? 'STOPWATCH' : 'TIMER');
    $('#TIMER_EDIT_DURATION').val(durationText);
    $('#TIMER_EDIT_SHOWONWEB').prop('checked', timer.ShowOnWeb == null ? true : !!timer.ShowOnWeb);
    const toggleDuration = () => {
      const t = $('#TIMER_EDIT_TYPE').val();
      const isStopwatch = t === 'STOPWATCH';
      $('#TIMER_EDIT_DURATION_GROUP').toggleClass('d-none', isStopwatch);
    };
    $('#TIMER_EDIT_TYPE').off('change').on('change', toggleDuration);
    toggleDuration();
    $('#TIMER_EDIT_SAVE')
      .off('click')
      .on('click', async () => {
        const name = String($('#TIMER_EDIT_NAME').val() || '').trim();
        const rawDur = String($('#TIMER_EDIT_DURATION').val() || '').trim();
        const ms = parseDurationToMs(rawDur); // null if empty or invalid
        if (rawDur && ms == null) {
          return Notify('Invalid duration. Use mm:ss or hh:mm:ss.', 'error');
        }
        const patch = { Name: name };
        const selectedType = $('#TIMER_EDIT_TYPE').val();
        patch.Type = selectedType;
        // For stopwatch, force Duration to null; otherwise use parsed duration (or null if empty)
        patch.Duration = selectedType === 'STOPWATCH' ? null : rawDur.length === 0 ? null : ms;
        patch.ShowOnWeb = $('#TIMER_EDIT_SHOWONWEB').is(':checked');
        const [uErr] = await window.API.TimerUpdate(TimerID, patch);
        if (uErr) return Notify(`Failed to save: ${uErr}`, 'error');
        $('#TIMER_EDIT_MODAL').modal('hide');
        Notify('Saved', 'success', 1200);
      });

    $('#TIMER_EDIT_DELETE')
      .off('click')
      .on('click', async () => {
        const confirm = await ConfirmationDialog('Delete this timer? This cannot be undone.');
        if (!confirm) return;
        const [dErr] = await window.API.TimerDelete(TimerID);
        if (dErr) return Notify(`Failed to delete: ${dErr}`, 'error');
        $('#TIMER_EDIT_MODAL').modal('hide');
        Notify('Deleted', 'success', 1200);
      });
    $('#TIMER_EDIT_MODAL').modal('show');
  } catch (e) {
    Notify(`Failed to open editor: ${e.message || e}`, 'error');
  }
}

async function ConfirmationDialog(Message) {
  return new Promise((resolve, reject) => {
    $('#SHOWTRAK_CONFIRMATION_MESSAGE').text(Message);

    $('#SHOWTRAK_CONFIRMATION_CANCEL')
      .off('click')
      .on('click', () => {
        $('#SHOWTRAL_MODAL_CONFIRMATION').modal('hide');
        resolve(false);
      });
    $('#SHOWTRAK_CONFIRMATION_CONFIRM')
      .off('click')
      .on('click', () => {
        $('#SHOWTRAL_MODAL_CONFIRMATION').modal('hide');
        resolve(true);
      });

    $('#SHOWTRAL_MODAL_CONFIRMATION').modal({
      backdrop: 'static',
      keyboard: false,
    });
    $('#SHOWTRAL_MODAL_CONFIRMATION').modal('show');
  });
}

function ToggleSelection(UUID) {
  if (Selected.includes(UUID)) {
    Selected = Selected.filter((id) => id !== UUID);
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass('SELECTED');
  } else {
    Selected.push(UUID);
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass('SELECTED');
  }
  UpdateSelectionCount();
}

async function Init() {
  Config = await window.API.GetConfig();
  $('#APPLICATION_NAVBAR_TITLE').text(`${Config.Application.Name}`);
  $('#APPLICATION_NAVBAR_STATUS').text(`v${Config.Application.Version}`);

  $('#NAVBAR_CORE_BUTTON').on('click', async () => {
    $('#SHOWTRAK_MODEL_CORE').modal('show');
  });

  $('#SHOWTRAK_MODEL_CORE_OPEN_SETTINGS').on('click', async () => {
    await CloseAllModals();
    $('#SHOWTRAK_MODAL_SETTINGS').modal('show');
  });

  $('#SHOWTRAK_MODEL_CORE_OSC_ROUTE_LIST_BUTTON').on('click', async () => {
    await OpenOSCDictionary();
  });

  $('#SHOWTRAK_MODEL_CORE_LOGSFOLDER').on('click', async () => {
    await window.API.OpenLogsFolder();
  });

  $('#SHOWTRAK_MODEL_CORE_BACKUPCONFIG').on('click', async () => {
    await BackupConfig();
  });

  $('#SHOWTRAK_MODEL_CORE_IMPORTCONFIG').on('click', async () => {
    await ImportConfig();
  });

  $('#SHOWTRAK_MODEL_CORE_SUPPORTDISCORD').on('click', async () => {
    await window.API.OpenDiscordInviteLinkInBrowser();
  });

  $('#SHOWTRAK_MODEL_CORE_SHUTDOWN_BUTTON').on('click', async () => {
    window.API.Shutdown();
  });

  await window.API.Loaded();
}

Init();
