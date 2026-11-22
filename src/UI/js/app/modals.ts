// Modal plumbing shared by every panel: the titlebar headers, closing whatever
// is open, and the About modal (all as in ShowTrak Server).
import { closeAllModals, closeModal, openModal } from './lib/modal';
import { CancelConfirmation } from './lib/toasts';
import { buildModalHeader } from './lib/modal-header';
import { Config } from './state';
import { Wait } from './utils';
import type { DependencyView } from '@showtrak/protocol/timers';

// Build the shared header (title + close) for each modal. Runs once at boot:
// the placeholders are static markup.
export function InitModalHeaders(): void {
  const Build = (PlaceholderID: string, Title: string, ModalID: string) =>
    $('#' + PlaceholderID)
      .empty()
      .append(buildModalHeader({ title: Title, onClose: () => closeModal(ModalID) }).$el);
  Build('SHORTCUTS_HEADER', 'Keyboard Shortcuts', 'SHOWTRAK_MODAL_SHORTCUTS');
  Build('ABOUT_HEADER', 'About', 'SHOWTRAK_MODAL_ABOUT');
  Build('APP_UPDATE_HEADER', 'Software Update', 'SHOWTRAK_MODAL_APP_UPDATE');
  Build('SETTINGS_HEADER', 'Preferences', 'SHOWTRAK_MODAL_SETTINGS');
  Build('OSC_ROUTE_LIST_HEADER', 'OSC Reference', 'OSC_ROUTE_LIST_MODAL');
  Build('WEB_DASHBOARD_HEADER', 'Web Dashboard', 'SHOWTRAK_MODAL_WEB_DASHBOARD');
  Build('SOUND_LIBRARY_HEADER', 'Sound Library', 'SHOWTRAK_MODAL_SOUND_LIBRARY');
  Build('GROUP_MANAGER_HEADER', 'Groups', 'SHOWTRAK_MODAL_GROUPMANAGER');
  Build('GROUP_EDITOR_HEADER', 'Edit Group', 'SHOWTRAK_MODAL_GROUP_EDITOR');
}

// The longest a close is waited for (Bootstrap's fade is about 300 ms).
const MODAL_HIDE_WAIT_MS = 700;

/**
 * Close every modal (but the prompts that need an answer) and any confirmation
 * waiting in one, and resolve once they have finished closing. It waits for
 * Bootstrap's 'hidden' event, not a fixed time: a modal reopened while its own
 * close was still finishing would otherwise get that late event, and reset the
 * editor it had just opened. Resolves at once when nothing was open.
 */
export async function CloseAllModals(): Promise<void> {
  CancelConfirmation();
  const Closing = Array.from(document.querySelectorAll<HTMLElement>('.modal')).filter(
    (El) => El.style.display === 'block' && El.getAttribute('data-bs-backdrop') !== 'static'
  );
  const Hidden = Closing.map(
    (El) => new Promise<void>((resolve) => $(El).one('hidden.bs.modal', () => resolve()))
  );
  closeAllModals();
  if (Hidden.length) await Promise.race([Promise.all(Hidden), Wait(MODAL_HIDE_WAIT_MS)]);
}

// "^1.2.3" -> "1.2", as Server's About modal lists them.
export function FormatDependencyVersion(Version: unknown): string {
  const Raw = Version ? String(Version) : '';
  const Match = Raw.match(/(\d+)\.(\d+)/);
  if (Match) return `${Match[1]}.${Match[2]}`;
  return Raw.replace(/^[~^<>=\s]+/, '') || '-';
}

function RenderDependencyList(Dependencies: DependencyView[]): JQuery<HTMLElement> {
  const Group = $('<div class="SHOWTRAK_ABOUT_DEPENDENCY_GROUP"></div>');
  if (!Dependencies.length) {
    Group.append($('<div class="text-muted"></div>').text('None'));
    return Group;
  }
  for (const Dependency of Dependencies) {
    const Item = $('<div class="SHOWTRAK_ABOUT_DEPENDENCY_ITEM"></div>');
    Item.append($('<span class="SHOWTRAK_ABOUT_DEPENDENCY_NAME"></span>').text(Dependency.name));
    Item.append(
      $('<span class="SHOWTRAK_ABOUT_DEPENDENCY_VERSION"></span>').text(
        FormatDependencyVersion(Dependency.version)
      )
    );
    Group.append(Item);
  }
  return Group;
}

export async function OpenAboutModal(): Promise<void> {
  await CloseAllModals();
  const Version = Config?.Application?.Version;
  $('#SHOWTRAK_ABOUT_VERSION').text(Version ? `Version ${Version}` : '');

  const $Dependencies = $('#SHOWTRAK_ABOUT_DEPENDENCIES');
  const $Count = $('#SHOWTRAK_ABOUT_DEPENDENCY_COUNT');
  $Dependencies.empty().text('Loading dependencies...');
  $Count.text('');
  try {
    const [Err, Payload] = await window.API.GetDependencies();
    if (Err || !Payload) throw new Error(Err || 'No dependencies');
    $Dependencies.empty().append(RenderDependencyList(Payload.dependencies));
    $Count.text(`${Payload.dependencies.length} total`);
  } catch {
    $Dependencies.empty().text('Failed to load dependencies.');
    $Count.text('Unavailable');
  }

  const $License = $('#SHOWTRAK_ABOUT_LICENSE');
  const $Toggle = $('#SHOWTRAK_ABOUT_LICENSE_TOGGLE');
  $License.addClass('d-none').text('Loading licence...');
  $Toggle.text('Show full licence');
  $Toggle.off('click').on('click', () => {
    const Hidden = $License.hasClass('d-none');
    $License.toggleClass('d-none', !Hidden);
    $Toggle.text(Hidden ? 'Hide full licence' : 'Show full licence');
  });
  try {
    const [Err, Payload] = await window.API.GetLicense();
    if (Err || !Payload || !Payload.license.trim()) throw new Error(Err || 'Empty licence');
    $License.text(Payload.license);
  } catch {
    $License.text('Failed to load the licence text.');
  }

  openModal('SHOWTRAK_MODAL_ABOUT');
}

export function WireAboutModal(): void {
  $('#SHOWTRAK_ABOUT_WEBSITE').on('click', () => void window.API.OpenExternal('website'));
  $('#SHOWTRAK_ABOUT_GITHUB').on('click', () => void window.API.OpenExternal('github'));
  $('#SHOWTRAK_ABOUT_DISCORD').on('click', () => void window.API.OpenExternal('discord'));
}
