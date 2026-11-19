// Writes a tile model into a tile's DOM, shared by the desktop grid and the
// Web Dashboard. A running show repaints tiles many times a second, so each
// tile's parts are looked up once (not queried on every paint) and every value
// written is remembered: a paint that changes nothing touches nothing.
import type { TileModel } from './timer-tile';

type ControlKey = keyof TileModel['Controls'];

// Which control decides whether a run button shows; null for always shown.
const BUTTON_CONTROL: Readonly<Record<string, ControlKey>> = {
  Start: 'Start',
  Unpause: 'Resume',
  Pause: 'Pause',
  Stop: 'Stop',
};

interface TileParts {
  Name: HTMLElement | null;
  Status: HTMLElement | null;
  Primary: HTMLElement | null;
  Secondary: HTMLElement | null;
  Progress: HTMLElement | null;
  Bar: HTMLElement | null;
  Buttons: Array<{ El: HTMLElement; Control: ControlKey; Hidden: boolean | null }>;
  // What was last written, so an unchanged value is not written again.
  Text: Record<string, string>;
  Scale: string | null;
  NoBar: boolean | null;
}

const Parts = new WeakMap<HTMLElement, TileParts>();

function PartsOf(El: HTMLElement): TileParts {
  let Found = Parts.get(El);
  if (Found) return Found;
  const Role = (Name: string) => El.querySelector<HTMLElement>(`[data-role="${Name}"]`);
  const Progress = Role('progress');
  const Buttons: TileParts['Buttons'] = [];
  for (const Button of Array.from(El.querySelectorAll<HTMLElement>('[data-action]'))) {
    const Control = BUTTON_CONTROL[Button.getAttribute('data-action') ?? ''];
    if (Control) Buttons.push({ El: Button, Control, Hidden: null });
  }
  Found = {
    Name: Role('name'),
    Status: Role('status'),
    Primary: Role('primary'),
    Secondary: Role('secondary'),
    Progress,
    Bar: (Progress?.firstElementChild as HTMLElement | null) ?? null,
    Buttons,
    Text: {},
    Scale: null,
    NoBar: null,
  };
  Parts.set(El, Found);
  return Found;
}

function SetText(P: TileParts, Key: keyof TileParts, Text: string): void {
  if (P.Text[Key] === Text) return;
  const Node = P[Key] as HTMLElement | null;
  if (!Node) return;
  P.Text[Key] = Text;
  if (Node.textContent !== Text) Node.textContent = Text;
}

/**
 * Bring a tile up to date with its model. `Extra` are classes the page adds
 * besides the model's own (selection, drag state).
 */
export function PaintTileElement(
  El: HTMLElement,
  Model: TileModel,
  Extra: readonly string[] = []
): void {
  let ClassName = 'SHOWTRAK_TIMER';
  for (const Name of Model.Classes) ClassName += ` ${Name}`;
  for (const Name of Extra) ClassName += ` ${Name}`;
  if (El.className !== ClassName) El.className = ClassName;

  const P = PartsOf(El);
  SetText(P, 'Name', Model.Name);
  SetText(P, 'Status', Model.StatusText);
  SetText(P, 'Primary', Model.Primary);
  SetText(P, 'Secondary', Model.Secondary ? `/ ${Model.Secondary}` : '');

  const NoBar = Model.Progress === null;
  if (P.Progress && P.NoBar !== NoBar) {
    P.NoBar = NoBar;
    P.Progress.classList.toggle('invisible', NoBar);
  }
  // Scaled rather than resized, as Server's tile bars are: no layout per paint.
  const Scale = `scaleX(${(Model.Progress ?? 0) / 100})`;
  if (P.Bar && P.Scale !== Scale) {
    P.Scale = Scale;
    P.Bar.style.transform = Scale;
  }

  for (const Button of P.Buttons) {
    const Hidden = !Model.Controls[Button.Control];
    if (Button.Hidden === Hidden) continue;
    Button.Hidden = Hidden;
    Button.El.classList.toggle('d-none', Hidden);
  }
}
