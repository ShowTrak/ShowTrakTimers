// The Preferences modal: one tab per settings group, each setting drawn by type.
// A port of ShowTrak Server's settings renderer (same markup, same behaviour:
// controls are rebuilt only when the set of settings changes, values are synced
// in place otherwise so focus and scroll survive a save, ShowWhen hides
// dependent rows), plus RequiresSave: network settings get a Save button rather
// than rebinding a socket on every keystroke.
import {
  SettingDebounceTimers,
  Settings,
  SettingsGroups,
  setSettings,
  setSettingsGroups,
  SettingValue as CurrentValue,
} from './state';
import { Notify } from './lib/toasts';
import { FormatSettingValue, ResolveSettingsTab } from './lib/settings-tabs';
import { Safe } from './utils';
import type { SettingGroupView, SettingView } from '../../../common/api';

// An OPTION whose every choice is at most this long sits beside its label.
const SHORT_OPTION_LENGTH = 20;

let RenderedStructure: string | null = null;
const RenderedSettings = new Map<string, SettingView>();
let ActiveSettingsTab: string | null = null;

// A toast for a saved setting, unless NOTIFY_SETTINGS_CHANGES is off.
function NotifySaved(Message: string): void {
  if (CurrentValue('NOTIFY_SETTINGS_CHANGES') === false) return;
  void Notify(Message, 'success', 2000);
}

export function ComputeSettingsStructure(
  SettingsList: SettingView[],
  GroupsList: SettingGroupView[]
): string {
  return JSON.stringify([
    GroupsList.map((G) => [G?.Name, G?.Title]),
    SettingsList.map((S) => [
      S?.ShowWhen,
      S?.Group,
      S?.Key,
      S?.Title,
      S?.Description,
      S?.Type,
      S?.Min,
      S?.Max,
      S?.Unit,
      S?.Options,
      S?.RequiresSave,
    ]),
  ]);
}

function DescriptionLine(Description: string | null | undefined): string {
  return Description ? `<span class="text-sm mb-0">${Safe(Description)}</span>` : '';
}

function DependenciesMet(ShowWhen: string[] | null | undefined): boolean {
  if (!ShowWhen || !ShowWhen.length) return true;
  return ShowWhen.every((Key) => !!Settings.find((S) => S && S.Key === Key)?.Value);
}

function ApplySettingDependencies(): void {
  $('#SETTINGS [data-setting-key]').each(function () {
    const Setting = RenderedSettings.get(this.getAttribute('data-setting-key') || '');
    $(this).toggleClass('d-none', !DependenciesMet(Setting?.ShowWhen));
  });
}

// Optimistically record a value locally (the push that follows confirms it).
function Remember(Setting: SettingView, Value: SettingView['Value']): void {
  const Cached = Settings.find((S) => S.Key === Setting.Key);
  if (Cached) Cached.Value = Value;
  Setting.Value = Value;
}

async function Save(Setting: SettingView, Value: SettingView['Value']): Promise<boolean> {
  const Previous = Setting.Value;
  Remember(Setting, Value);
  ApplySettingDependencies();
  const [Err] = await window.API.SetSetting(Setting.Key, Value);
  if (Err) {
    Remember(Setting, Previous);
    ApplySettingDependencies();
    void Notify(`[${Setting.Title}] ${Err}`, 'error', 3500);
    return false;
  }
  return true;
}

function Debounce(Key: string, Ms: number, Fn: () => void): void {
  const Pending = SettingDebounceTimers.get(Key);
  if (Pending) clearTimeout(Pending);
  SettingDebounceTimers.set(
    Key,
    setTimeout(() => {
      // Clear first: a live timer means "mid-edit, leave this field alone".
      SettingDebounceTimers.delete(Key);
      Fn();
    }, Ms)
  );
}

function RenderBoolean($Target: JQuery<HTMLElement>, Setting: SettingView): void {
  $Target.append(`<div class="bg-ghost p-2 rounded d-flex justify-content-between text-start${
    Setting.Description ? '' : ' align-items-center'
  }">
    <div class="d-grid">
      <span>${Safe(Setting.Title)}</span>
      ${DescriptionLine(Setting.Description)}
    </div>
    <div class="form-check form-switch">
      <input class="form-check-input" type="checkbox" id="SETTING_${Setting.Key}" ${
        Setting.Value ? 'checked' : ''
      }>
    </div>
  </div>`);
  $(`#SETTING_${Setting.Key}`).on('change', async function () {
    const Value = $(this).is(':checked');
    if (Value === Setting.Value) return;
    if (await Save(Setting, Value)) {
      NotifySaved(`${Setting.Title} ${Value ? 'enabled' : 'disabled'}.`);
    } else {
      $(this).prop('checked', !Value);
    }
  });
}

// STRING and INTEGER share one layout: label beside the field, plus a Save
// button when the setting RequiresSave.
function RenderField($Target: JQuery<HTMLElement>, Setting: SettingView): void {
  const IsNumber = Setting.Type === 'INTEGER';
  const HasMin = typeof Setting.Min === 'number';
  const HasMax = typeof Setting.Max === 'number';
  const Unit = Setting.Unit ? Safe(Setting.Unit) : '';
  const RangeHint =
    IsNumber && HasMin && HasMax
      ? ` <span class="text-sm text-muted">(${Setting.Min}–${FormatSettingValue(Setting.Max, Unit)})</span>`
      : '';
  const InputHtml = IsNumber
    ? `<input type="number" class="form-control form-control-sm bg-ghost-light text-light border-0" id="SETTING_${
        Setting.Key
      }" value="${Safe(Setting.Value)}" step="1" ${HasMin ? `min="${Setting.Min}"` : ''} ${
        HasMax ? `max="${Setting.Max}"` : ''
      } />`
    : `<input type="text" class="form-control form-control-sm bg-ghost-light text-light border-0" id="SETTING_${
        Setting.Key
      }" value="${Safe(Setting.Value)}" autocomplete="off" spellcheck="false" />`;
  const SaveHtml = Setting.RequiresSave
    ? `<button type="button" class="btn btn-sm btn-success" id="SETTING_${Setting.Key}_SAVE" disabled>Save</button>`
    : '';
  $Target.append(`<div class="bg-ghost p-2 rounded setting-inline text-start">
    <div class="d-grid setting-inline-label">
      <span>${Safe(Setting.Title)}${RangeHint}</span>
      ${DescriptionLine(Setting.Description)}
    </div>
    <div class="setting-inline-control">${InputHtml}${
      Unit ? `<span class="text-sm text-muted text-nowrap">${Unit}</span>` : ''
    }${SaveHtml}</div>
  </div>`);

  const $Input = $(`#SETTING_${Setting.Key}`);
  const $Save = $(`#SETTING_${Setting.Key}_SAVE`);
  const ReadValue = (): SettingView['Value'] | null => {
    const Raw = String($Input.val() ?? '').trim();
    if (!IsNumber) return Raw;
    const Num = parseInt(Raw, 10);
    if (Number.isNaN(Num)) return null;
    if (HasMin && Num < Setting.Min!) return Setting.Min!;
    if (HasMax && Num > Setting.Max!) return Setting.Max!;
    return Num;
  };

  const Commit = async () => {
    const Value = ReadValue();
    if (Value === null || Value === Setting.Value) {
      $Save.prop('disabled', true);
      return;
    }
    $Save.prop('disabled', true);
    if (await Save(Setting, Value)) {
      NotifySaved(`${Setting.Title} saved as ${FormatSettingValue(Value, Setting.Unit)}.`);
    } else if (Setting.RequiresSave) {
      $Save.prop('disabled', false);
    }
  };

  if (Setting.RequiresSave) {
    $Input.on('input', () => {
      const Value = ReadValue();
      $Save.prop('disabled', Value === null || Value === Setting.Value);
    });
    $Input.on('keydown', (Event) => {
      if (Event.key === 'Enter') void Commit();
    });
    $Save.on('click', () => void Commit());
  } else {
    $Input.on('input', () => Debounce(Setting.Key, 600, () => void Commit()));
  }
}

function RenderSlider($Target: JQuery<HTMLElement>, Setting: SettingView): void {
  const Min = typeof Setting.Min === 'number' ? Setting.Min : 0;
  const Max = typeof Setting.Max === 'number' ? Setting.Max : 100;
  $Target.append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
    <div class="d-flex justify-content-between align-items-center">
      <span>${Safe(Setting.Title)}</span>
      <span class="text-sm text-muted" id="SETTING_${Setting.Key}_VALUE">${Safe(
        FormatSettingValue(Setting.Value, Setting.Unit)
      )}</span>
    </div>
    ${DescriptionLine(Setting.Description)}
    <input type="range" class="form-range" id="SETTING_${Setting.Key}" min="${Min}" max="${Max}" step="1" value="${Safe(
      Setting.Value
    )}" />
  </div>`);
  $(`#SETTING_${Setting.Key}`).on('input', function () {
    let Value = parseInt(String($(this).val()), 10);
    if (Number.isNaN(Value)) Value = Number(Setting.Value);
    Value = Math.min(Max, Math.max(Min, Value));
    $(`#SETTING_${Setting.Key}_VALUE`).text(FormatSettingValue(Value, Setting.Unit));
    Debounce(Setting.Key, 400, () => {
      if (Value !== Setting.Value) void Save(Setting, Value);
    });
  });
}

function RenderOption($Target: JQuery<HTMLElement>, Setting: SettingView): void {
  const Options = Array.isArray(Setting.Options) ? Setting.Options : [];
  const OptionsHtml = Options.map(
    (Opt) =>
      `<option value="${Safe(Opt)}" ${Setting.Value === Opt ? 'selected' : ''}>${Safe(Opt)}</option>`
  ).join('');
  const IsShort = Options.every((Opt) => String(Opt).length <= SHORT_OPTION_LENGTH);
  const SelectHtml = `<select class="form-select form-select-sm bg-ghost-light text-light border-0" id="SETTING_${Setting.Key}">${OptionsHtml}</select>`;
  $Target.append(`<div class="bg-ghost p-2 rounded text-start ${IsShort ? 'setting-inline' : 'd-grid gap-1'}">
    <div class="d-grid${IsShort ? ' setting-inline-label' : ''}">
      <span>${Safe(Setting.Title)}</span>
      ${DescriptionLine(Setting.Description)}
    </div>
    ${IsShort ? `<div class="setting-inline-control">${SelectHtml}</div>` : SelectHtml}
  </div>`);
  $(`#SETTING_${Setting.Key}`).on('change', async function () {
    const Value = String($(this).val() ?? '');
    if (Value === Setting.Value) return;
    if (await Save(Setting, Value)) NotifySaved(`${Setting.Title} set to ${Value}.`);
    else $(this).val(String(Setting.Value));
  });
}

function RenderSettingsSections(Structure: string): void {
  $('#SETTINGS').html('');
  RenderedSettings.clear();
  RenderedStructure = Structure;
  for (const Group of SettingsGroups) {
    const GroupSettings = Settings.filter((S) => S.Group === Group.Name);
    if (!GroupSettings.length) continue;
    const $Section = $(
      `<div class="settings-section d-grid gap-2" id="SETTINGS_SECTION_${Safe(Group.Name)}" data-nav-key="${Safe(
        Group.Name
      )}" data-nav-title="${Safe(Group.Title)}"></div>`
    );
    $Section.append(`<div class="bg-ghost-light p-2 rounded">
      <strong class="text-start">${Safe(Group.Title)}</strong>
    </div>`);
    $('#SETTINGS').append($Section);
    for (const Setting of GroupSettings) {
      RenderedSettings.set(Setting.Key, Setting);
      const Before = $Section.children().length;
      if (Setting.Type === 'BOOLEAN') RenderBoolean($Section, Setting);
      else if (Setting.Type === 'STRING' || Setting.Type === 'INTEGER')
        RenderField($Section, Setting);
      else if (Setting.Type === 'SLIDER') RenderSlider($Section, Setting);
      else if (Setting.Type === 'OPTION') RenderOption($Section, Setting);
      if ($Section.children().length > Before) {
        $Section.children().last().attr('data-setting-key', Setting.Key);
      }
    }
  }
}

// Push new values into the rendered controls, leaving alone whatever is being
// edited (the focused control, a pending debounced save, an unsaved field).
function SyncRenderedSettingValues(SettingsList: SettingView[]): void {
  const ActiveID = document.activeElement ? document.activeElement.id : '';
  for (const Incoming of SettingsList) {
    const Rendered = RenderedSettings.get(Incoming.Key);
    if (!Rendered) continue;
    const Previous = Rendered.Value;
    Rendered.Value = Incoming.Value;
    if (Previous === Incoming.Value) continue;
    const ElementID = `SETTING_${Incoming.Key}`;
    if (ActiveID === ElementID || SettingDebounceTimers.has(Incoming.Key)) continue;
    const $El = $(`#${ElementID}`);
    if (!$El.length) continue;
    if (Incoming.Type === 'BOOLEAN') $El.prop('checked', !!Incoming.Value);
    else {
      $El.val(String(Incoming.Value ?? ''));
      $(`#${ElementID}_SAVE`).prop('disabled', true);
      if (Incoming.Type === 'SLIDER') {
        $(`#${ElementID}_VALUE`).text(FormatSettingValue(Incoming.Value, Incoming.Unit));
      }
    }
  }
}

function ApplySettingsTab(): void {
  $('#SETTINGS_NAV .settings-nav-item').each(function () {
    const IsActive = this.getAttribute('data-nav-target') === ActiveSettingsTab;
    $(this)
      .toggleClass('active', IsActive)
      .attr('aria-selected', IsActive ? 'true' : 'false');
  });
  $('#SETTINGS_CONTENT .settings-section[data-nav-title]').each(function () {
    $(this).toggleClass('is-inactive-tab', this.getAttribute('data-nav-key') !== ActiveSettingsTab);
  });
}

function BuildSettingsNav(): void {
  const $Content = $('#SETTINGS_CONTENT');
  const $Nav = $('#SETTINGS_NAV');
  const Sections = $Content.find('.settings-section[data-nav-title]:not(.d-none)').toArray();
  $Nav.empty();
  const Tabbed = Sections.length > 1;
  $('#SHOWTRAK_MODAL_SETTINGS .modal-body').toggleClass('is-tabbed', Tabbed);
  if (!Tabbed) {
    $Nav.hide();
    $Content.find('.settings-section').removeClass('is-inactive-tab');
    return;
  }
  $Nav.show();
  for (const Section of Sections) {
    $Nav.append(
      `<button type="button" class="settings-nav-item" role="tab" aria-selected="false" data-nav-target="${Safe(
        Section.getAttribute('data-nav-key')
      )}">${Safe(Section.getAttribute('data-nav-title'))}</button>`
    );
  }
  ActiveSettingsTab = ResolveSettingsTab(
    ActiveSettingsTab,
    Sections.map((Section) => Section.getAttribute('data-nav-key') || '')
  );
  ApplySettingsTab();
  $Nav.off('click.settingstabs').on('click.settingstabs', '.settings-nav-item', function () {
    const Key = this.getAttribute('data-nav-target');
    if (Key === ActiveSettingsTab) return;
    ActiveSettingsTab = Key;
    ApplySettingsTab();
    $Content.scrollTop(0);
  });
}

// Each open of Preferences starts on the first category.
function ResetSettingsTab(): void {
  ActiveSettingsTab = $('#SETTINGS_NAV .settings-nav-item').first().attr('data-nav-target') ?? null;
  ApplySettingsTab();
  $('#SETTINGS_CONTENT').scrollTop(0);
}

export function ApplySettings(Incoming: SettingView[], IncomingGroups: SettingGroupView[]): void {
  const List = Array.isArray(Incoming) ? Incoming : [];
  const GroupList = Array.isArray(IncomingGroups) ? IncomingGroups : [];
  const Structure = ComputeSettingsStructure(List, GroupList);
  const CanReuse = Structure === RenderedStructure && $('#SETTINGS').children().length > 0;
  setSettings(List);
  setSettingsGroups(GroupList);
  if (CanReuse) SyncRenderedSettingValues(List);
  else {
    RenderSettingsSections(Structure);
    BuildSettingsNav();
  }
  ApplySettingDependencies();
}

export function InitSettings(): void {
  window.API.OnSettings((Incoming, Groups) => ApplySettings(Incoming, Groups));
  $('#SHOWTRAK_MODAL_SETTINGS').on('show.bs.modal', ResetSettingsTab);
}
