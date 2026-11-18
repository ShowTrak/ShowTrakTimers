// The network services (OSC listener, Web Dashboard): starting them, restarting
// them when their settings change, and reporting where they are listening.
import os from 'os';
import { CreateLogger } from '../Modules/Logger';
import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { Manager as SettingsManager } from '../Modules/SettingsManager';
import { Manager as OSC } from '../Modules/OSC';
import { Manager as WebDashboard } from '../Modules/WebDashboard';
import type { ServicesStatusView } from '../common/api';
import { PushToRenderers } from './renderer-bus';

const Logger = CreateLogger('Services');

// Settings saves arrive in bursts (the port and the bind address saved one
// after the other); restart once they settle.
const RESTART_DEBOUNCE_MS = 500;

// The http:// URLs another device could open the dashboard at. A dashboard
// bound to one address is only reachable there; one on 0.0.0.0 is reachable on
// every external IPv4 address this machine has.
export function DashboardURLs(
  Host: string | null,
  Port: number | null,
  Interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string[] {
  if (!Host || !Port) return [];
  if (Host !== '0.0.0.0') return [`http://${Host}:${Port}`];
  const Addresses = new Set<string>();
  for (const List of Object.values(Interfaces)) {
    for (const Info of List || []) {
      if (Info.family === 'IPv4' && !Info.internal) Addresses.add(Info.address);
    }
  }
  return [...Addresses].sort().map((Address) => `http://${Address}:${Port}`);
}

export async function GetServicesStatus(): Promise<ServicesStatusView> {
  const OscAddress = OSC.Address();
  const DashAddress = WebDashboard.Address();
  return {
    OSC: {
      Enabled: !!(await SettingsManager.GetValue('OSC_ENABLE')),
      Running: OSC.IsRunning(),
      Host: OscAddress?.Host ?? null,
      Port: OscAddress?.Port ?? null,
    },
    WebDashboard: {
      Enabled: !!(await SettingsManager.GetValue('WEB_ENABLE_DASHBOARD')),
      Running: WebDashboard.IsRunning(),
      Host: DashAddress?.Host ?? null,
      Port: DashAddress?.Port ?? null,
      URLs: DashboardURLs(DashAddress?.Host ?? null, DashAddress?.Port ?? null),
      Clients: WebDashboard.ClientCount(),
    },
  };
}

async function PushStatus(): Promise<void> {
  try {
    PushToRenderers('Services:Status', await GetServicesStatus());
  } catch (Err) {
    Logger.warn('Failed to push service status:', Err);
  }
}

function Debounced(Fn: () => Promise<void>): () => void {
  let Timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (Timer) clearTimeout(Timer);
    Timer = setTimeout(() => {
      Timer = null;
      Fn().catch((Err) => Logger.error('Service restart failed:', Err));
    }, RESTART_DEBOUNCE_MS);
  };
}

async function RestartOSC(): Promise<void> {
  const [Err, Started] = await OSC.Start();
  if (Err) Logger.error('OSC start error:', Err);
  else if (Started) {
    const Address = OSC.Address();
    if (Address) {
      BroadcastManager.emit(
        'Notify',
        `OSC listening on ${Address.Host}:${Address.Port}`,
        'success',
        2500,
        {
          category: 'osc-debug',
        }
      );
    }
  }
  await PushStatus();
}

async function RestartWebDashboard(): Promise<void> {
  const [Err, Started] = await WebDashboard.Start();
  if (Err) Logger.error('Web Dashboard start error:', Err);
  else if (Started) {
    const Address = WebDashboard.Address();
    if (Address) {
      BroadcastManager.emit('Notify', `Web Dashboard on port ${Address.Port}`, 'success', 2500, {
        category: 'settings-change',
      });
    }
  }
  await PushStatus();
}

// Start both services and keep them in line with their settings.
export async function StartServices(): Promise<void> {
  BroadcastManager.on('OSC:Restart', Debounced(RestartOSC));
  BroadcastManager.on('WebDashboard:Restart', Debounced(RestartWebDashboard));
  BroadcastManager.on('WebDashboard:ClientCount', () => void PushStatus());
  const [OscErr] = await OSC.Start();
  if (OscErr) Logger.error('OSC failed to start:', OscErr);
  const [DashErr] = await WebDashboard.Start();
  if (DashErr) Logger.error('Web Dashboard failed to start:', DashErr);
  await PushStatus();
}

export async function StopServices(): Promise<void> {
  await Promise.allSettled([OSC.Stop(), WebDashboard.Stop()]);
}
