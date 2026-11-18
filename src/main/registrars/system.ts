// IPC: app information, links, folders, the initial-state handshake and quit.
import fs from 'fs';
import path from 'path';
import { RPC } from '../rpc';
import { Config } from '../../Modules/Config';
import { DISCORD_INVITE_URL, GITHUB_URL, WEBSITE_URL } from '../../Modules/Config/constants';
import { Manager as AppData } from '../../Modules/AppData';
import { CreateLogger } from '../../Modules/Logger';
import type { AppConfigView, ExternalLink } from '../../common/api';

const Logger = CreateLogger('System');

const EXTERNAL_LINKS: Readonly<Record<ExternalLink, string>> = {
  discord: DISCORD_INVITE_URL,
  website: WEBSITE_URL,
  github: GITHUB_URL,
};

export interface SystemDeps {
  /** Push the full initial state to the renderer (settings, timers, ...). */
  DeliverInitialState(): Promise<void>;
  RequestShutdown(Confirmed: boolean): void;
}

function ElectronApp(): { isPackaged: boolean; getAppPath(): string } {
  return (require('electron/main') as typeof import('electron/main')).app;
}

// package.json / LICENSE sit at the app root: beside dist/ in a checkout, at the
// root of the asar in a packaged build.
function FindAppFile(Name: string): string | null {
  const Root = ElectronApp().getAppPath();
  for (const Candidate of [path.join(Root, Name), path.resolve(Root, '..', Name)]) {
    if (fs.existsSync(Candidate)) return Candidate;
  }
  return null;
}

export function register(Deps: SystemDeps): void {
  RPC.handle('Config:Get', async (): Promise<AppConfigView> => ({
    Application: { ...Config.Application },
    Platform: process.platform,
    IsPackaged: ElectronApp().isPackaged,
  }));

  RPC.handle('Loaded', async () => {
    Logger.log('Renderer loaded; delivering initial state');
    await Deps.DeliverInitialState();
  });

  RPC.handle('App:OpenLogsFolder', async () => {
    AppData.OpenFolder(AppData.GetLogsDirectory());
  });

  RPC.handle('App:OpenExternal', async (_E, Link) => {
    const Name = String(Link);
    // Own keys only: "constructor" and friends are inherited, not links.
    if (!Object.prototype.hasOwnProperty.call(EXTERNAL_LINKS, Name)) return;
    const Url = EXTERNAL_LINKS[Name as ExternalLink];
    const { shell } = require('electron') as typeof import('electron');
    await shell.openExternal(Url);
  });

  RPC.handle('App:GetDependencies', async () => {
    try {
      const PackagePath = FindAppFile('package.json');
      if (!PackagePath) return ['Failed to locate package.json', null];
      const Package = JSON.parse(fs.readFileSync(PackagePath, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const Hidden = new Set(['electron-squirrel-startup', '@showtrak/protocol']);
      const Dependencies = Object.entries(Package.dependencies || {})
        .filter(([Name]) => !Hidden.has(Name))
        .map(([name, version]) => ({ name, version }))
        .sort((A, B) => A.name.localeCompare(B.name));
      return [null, { dependencies: Dependencies }];
    } catch (Err) {
      Logger.error('GetDependencies failed', Err);
      return [String(Err), null];
    }
  });

  RPC.handle('App:GetLicense', async () => {
    try {
      const LicensePath = FindAppFile('LICENSE');
      if (!LicensePath) return ['Failed to locate the LICENSE file', null];
      return [null, { license: fs.readFileSync(LicensePath, 'utf8') }];
    } catch (Err) {
      Logger.error('GetLicense failed', Err);
      return [String(Err), null];
    }
  });

  RPC.handle('Shutdown', async (_E, Confirmed) => {
    Deps.RequestShutdown(Confirmed === true);
  });
}
