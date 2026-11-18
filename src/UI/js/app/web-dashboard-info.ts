// The Web Dashboard modal: whether it is on, the addresses to open it at, and a
// QR code for a phone (the QR generator is ShowTrak Server's).
import { QrToSvg } from './lib/qr-svg';
import { openModal } from './lib/modal';
import { CloseAllModals } from './modals';
import { Services, setServices } from './state';
import { HandleNonFatalError, Safe } from './utils';
import type { ServicesStatusView } from '../../../common/api';
import { RefreshBottomBar } from './timers';

function Render(): void {
  const Dash = Services?.WebDashboard;
  const $Info = $('#WEB_DASHBOARD_INFO').empty();
  if (!Dash || !Dash.Enabled) {
    $Info.append(
      `<div class="bg-ghost p-2 rounded text-muted">The Web Dashboard is turned off. Turn it on in Preferences, Web Dashboard.</div>`
    );
    return;
  }
  if (!Dash.Running) {
    $Info.append(
      `<div class="bg-ghost p-2 rounded text-muted">The Web Dashboard is not running. Check its port and bind address in Preferences.</div>`
    );
    return;
  }
  const URLs = Dash.URLs.length ? Dash.URLs : [`http://localhost:${Dash.Port}`];
  $Info.append(`<div class="bg-ghost p-2 rounded text-sm text-muted">
    A read-only view of the timers marked "Show on the Web Dashboard", for any browser on the
    network. ${Dash.Clients} viewer${Dash.Clients === 1 ? '' : 's'} connected.
  </div>`);
  try {
    $Info.append(
      `<div class="web-dashboard-qr d-flex justify-content-center">${QrToSvg(URLs[0]!, { border: 2, size: 200 })}</div>`
    );
  } catch (Err) {
    HandleNonFatalError('WebDashboard:QR', Err);
  }
  for (const URL of URLs) {
    $Info.append(`<div class="bg-ghost p-2 rounded d-flex justify-content-between align-items-center gap-2">
      <code class="SHOWTRAK_NET_ADDRESS">${Safe(URL)}</code>
    </div>`);
  }
}

export async function OpenWebDashboardInfo(): Promise<void> {
  await CloseAllModals();
  try {
    setServices(await window.API.GetServicesStatus());
  } catch (Err) {
    HandleNonFatalError('WebDashboard:Status', Err);
  }
  Render();
  openModal('SHOWTRAK_MODAL_WEB_DASHBOARD');
}

export function ApplyServices(Status: ServicesStatusView): void {
  setServices(Status);
  if ($('#SHOWTRAK_MODAL_WEB_DASHBOARD').hasClass('show')) Render();
  RefreshBottomBar();
}

export function InitServices(): void {
  window.API.OnServicesStatus((Status) => ApplyServices(Status));
}
