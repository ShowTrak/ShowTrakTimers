// The OSC Reference modal: every OSC address, grouped like ShowTrak Server's
// OSC/API Reference, with where the listener is bound.
import { FormatRoutePath, ROUTE_SECTION_ORDER, RouteSection } from './lib/osc-format';
import { openModal } from './lib/modal';
import { CloseAllModals } from './modals';
import { Groups, Services } from './state';
import { DEFAULT_GROUP_SLUG } from '../../../common/groups';
import { Safe } from './utils';

export async function OpenOscReference(): Promise<void> {
  await CloseAllModals();
  const Routes = await window.API.GetOscRoutes();
  const Osc = Services?.OSC;
  const Where = !Osc?.Enabled
    ? 'The OSC server is turned off (Preferences, OSC).'
    : Osc.Running
      ? `Listening for OSC over UDP on ${Safe(Osc.Host)}:${Safe(Osc.Port)}.`
      : 'The OSC server is not running; check the port in Preferences.';
  const $List = $('#OSC_ROUTE_LIST').empty();
  $List.append(`
    <div class="d-grid gap-2 p-2 rounded bg-ghost-light rounded-3">
      <div class="fw-semibold">OSC Reference</div>
      <div class="text-muted small">${Where} Timer IDs are shown on each tile in Edit mode. A
      trailing value, such as a new name, can also be sent as the message's first argument.</div>
    </div>`);
  for (const Section of ROUTE_SECTION_ORDER) {
    const InSection = Routes.filter((Route) => RouteSection(Route.Path) === Section);
    if (!InSection.length) continue;
    $List.append(`<div class="osc-route-section-header">${Safe(Section)}</div>`);
    if (Section === 'Groups') {
      // The [Slug] each group answers to, set in its editor (Edit mode).
      const Slugs = [
        ...Groups.map((G) => `<code>${Safe(G.Slug)}</code> ${Safe(G.Title)}`),
        `<code>${Safe(DEFAULT_GROUP_SLUG)}</code> the Default group`,
      ];
      $List.append(`
        <div class="d-grid gap-1 p-2 rounded bg-ghost rounded-3 text-muted small">
          <div>A group is addressed by its slug, any case:</div>
          ${Slugs.map((Line) => `<div>${Line}</div>`).join('')}
        </div>`);
    }
    for (const Route of InSection) {
      $List.append(`
        <div class="d-grid gap-2 p-2 rounded bg-ghost rounded-3 osc-action-card">
          <div class="fw-semibold osc-action-title">${Safe(Route.Title)}</div>
          <code class="osc-route-path">${FormatRoutePath(Route.Path)}</code>
        </div>`);
    }
  }
  openModal('OSC_ROUTE_LIST_MODAL');
}
