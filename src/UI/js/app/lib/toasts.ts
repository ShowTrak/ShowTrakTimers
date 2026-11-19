// Toasts and the confirmation dialog, from ShowTrak Server's lib/toasts.ts:
//   1. Alert-style toasts: top-centre, stacked, hover-pausable auto-dismiss
//      (`showAlertStyleToast` / `Notify`).
//   2. Confirmation dialog: one promise-based, keyboard-driven toast
//      (`ConfirmationDialog`).
import { setConfirmDialogActive } from '../state';
import { HandleNonFatalError, Safe, WithFullStop } from '../utils';

/** Options accepted by {@link showAlertStyleToast}. */
interface AlertStyleToastOptions {
  id?: string | null;
  title?: unknown;
  message?: unknown;
  type?: string;
  duration?: number;
  linkAlert?: boolean;
  iconHtml?: string | null;
}

// --- Shared helpers ---------------------------------------------------------

export function iconForType(type: unknown) {
  const t = String(type || 'info').toLowerCase();
  if (t === 'success') return '<i class="bi bi-check-circle-fill"></i>';
  if (t === 'warning') return '<i class="bi bi-exclamation-triangle-fill"></i>';
  if (t === 'error') return '<i class="bi bi-x-circle-fill"></i>';
  return '<i class="bi bi-info-circle-fill"></i>';
}

// Auto-remove `el` after `duration` ms, pausing the countdown while the pointer
// hovers it. Shared by the alert-style toasts; no-op for duration <= 0.
function attachHoverPauseDismiss(el: HTMLElement, duration: number) {
  if (!duration || duration <= 0) return;
  let remaining = duration;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastStart = Date.now();
  const clear = () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  };
  const remove = (context: string) => {
    try {
      el.remove();
    } catch (e) {
      HandleNonFatalError(context, e);
    }
  };
  const tick = () => {
    clear();
    lastStart = Date.now();
    timerId = setTimeout(() => remove('showAlertStyleToast:AutoRemove'), remaining);
  };
  el.addEventListener('mouseenter', () => {
    remaining -= Date.now() - lastStart;
    if (remaining < 0) remaining = 0;
    clear();
  });
  el.addEventListener('mouseleave', () => {
    if (remaining === 0) remove('showAlertStyleToast:MouseLeaveRemove');
    else tick();
  });
  tick();
}

// --- 1. Alert-style toasts (top center) -------------------------------------

export function ensureToastHost() {
  let host = document.getElementById('ALERTS_TOAST_HOST');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ALERTS_TOAST_HOST';
    document.body.appendChild(host);
  }
  return host;
}

export function RemoveAlertToastById(id: unknown) {
  try {
    const host = document.getElementById('ALERTS_TOAST_HOST');
    if (!host) return;
    const node = host.querySelector(`.alert-toast[data-alert-id="${CSS.escape(String(id))}"]`);
    if (node) node.remove();
  } catch (e) {
    HandleNonFatalError('RemoveAlertToastById', e);
  }
}

export function showAlertStyleToast({
  id = null,
  title = '',
  message = '',
  type = 'info',
  duration = 5000,
  linkAlert = false,
  iconHtml = null,
}: AlertStyleToastOptions) {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = 'alert-item alert-toast';
  el.setAttribute('data-severity', String(type || 'info').toLowerCase());
  if (id && linkAlert) el.setAttribute('data-alert-id', id);
  const hasMessage = Boolean(message && String(message).trim().length > 0);
  if (!hasMessage) el.classList.add('single-line');
  el.innerHTML = `
		<div class="alert-icon">${iconHtml ? iconHtml : iconForType(type)}</div>
		<div class="alert-content">
			<div><strong>${Safe(title || 'Notice')}</strong></div>
			${message ? `<div class="alert-meta">${Safe(message)}</div>` : ''}
		</div>
		<div class="alert-dismiss">
			<button class="btn-dismiss" title="Dismiss" aria-label="Dismiss">✕</button>
		</div>`;
  host.appendChild(el);

  // Dismiss interaction
  const btn = el.querySelector('.btn-dismiss');
  if (btn) btn.addEventListener('click', () => el.remove());

  // Auto-remove after duration with hover pause
  attachHoverPauseDismiss(el, duration);
}

// Every toast reads as a sentence: dynamic messages (errors handed back by the
// server, labels joined at runtime) get the full stop literals carry already.
export async function Notify(Message: unknown, Type = 'info', Duration = 5000) {
  showAlertStyleToast({
    title: WithFullStop(Message),
    message: '',
    type: Type,
    duration: Duration,
    linkAlert: false,
  });
}

// --- 2. Confirmation dialog -------------------------------------------------

/** Options accepted by {@link ConfirmationDialog}. */
export interface ConfirmationDialogOptions {
  /**
   * The confirm button's label, naming the action in Title Case ("Delete Tag",
   * "Run Script"). Required so no dialog falls back to a vague "Confirm".
   */
  ConfirmLabel: string;
  /**
   * A second, non-destructive choice between Cancel and Confirm ("Don't
   * Save"). Chosen, the dialog resolves to 'alt' rather than true or false.
   */
  AltLabel?: string;
}

// The confirmation waiting for an answer, if any: only one at a time.
let ActiveConfirmation: { Finish: (Answer: ConfirmationAnswer) => void } | null = null;

export type ConfirmationAnswer = boolean | 'alt';

/**
 * Close a confirmation that is waiting, as if Cancel was chosen. Called when
 * whatever it was asked about goes away: its modal closes, another show is
 * opened, every modal is closed for something else.
 */
export function CancelConfirmation(): void {
  ActiveConfirmation?.Finish(false);
}

/**
 * Ask a question with Cancel and a named confirm button (and optionally a
 * third choice). Resolves true, false or 'alt'.
 *
 * Keys go to the dialog's own buttons, as to any button: Enter or Space on the
 * focused one (Confirm, to start with), Tab and the arrow keys to move between
 * them, Escape to cancel. A key pressed anywhere else (typing in a field behind
 * the dialog) never answers it, and neither does a key held down from before
 * it opened. Inside an open modal the dialog is placed in that modal, which is
 * where Bootstrap keeps the focus, and closing the modal cancels it. Opening a
 * second dialog cancels the first.
 */
export async function ConfirmationDialog(
  Message: unknown,
  Options: ConfirmationDialogOptions
): Promise<ConfirmationAnswer> {
  CancelConfirmation();
  return new Promise<ConfirmationAnswer>((resolve) => {
    const existing = document.getElementById('SHOWTRAK_CONFIRM_TOAST');
    if (existing) {
      try {
        existing.remove();
      } catch (err) {
        HandleNonFatalError('Toasts:NonFatal', err);
      }
    }

    const toastHtml = `
			<div id="SHOWTRAK_CONFIRM_TOAST" role="alertdialog" aria-modal="true" aria-labelledby="CONFIRM_TOAST_MESSAGE" class="confirm-toast no-drag">
				<div class="confirm-toast-body">
					<div class="confirm-toast-msg" id="CONFIRM_TOAST_MESSAGE">${Safe(Message)}</div>
					<div class="confirm-toast-actions">
						<button type="button" class="btn btn-sm btn-secondary" id="CONFIRM_TOAST_CANCEL">Cancel</button>
						${
              Options.AltLabel
                ? `<button type="button" class="btn btn-sm btn-secondary" id="CONFIRM_TOAST_ALT">${Safe(Options.AltLabel)}</button>`
                : ''
            }
						<button type="button" class="btn btn-sm btn-danger" id="CONFIRM_TOAST_CONFIRM">${Safe(
              Options.ConfirmLabel
            )}</button>
					</div>
				</div>
			</div>`;

    // In the open modal, if there is one: Bootstrap pulls the focus back into
    // an open modal, so a dialog outside it could never hold the focus.
    const HostModal = document.querySelector<HTMLElement>('.modal.show');
    $(HostModal ?? document.body).append(toastHtml);
    const $toast = $('#SHOWTRAK_CONFIRM_TOAST');
    const $btnCancel = $('#CONFIRM_TOAST_CANCEL');
    const $btnConfirm = $('#CONFIRM_TOAST_CONFIRM');
    const $btnAlt = $('#CONFIRM_TOAST_ALT');
    const Buttons = () => $toast.find('button').toArray() as HTMLElement[];
    const Previous = document.activeElement as HTMLElement | null;

    setConfirmDialogActive(true);

    let Done = false;
    const OnEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Before the modal behind sees it: Escape cancels the question, not the modal.
      e.preventDefault();
      e.stopPropagation();
      Finish(false);
    };
    const Finish = (Answer: ConfirmationAnswer) => {
      if (Done) return;
      Done = true;
      ActiveConfirmation = null;
      document.removeEventListener('keydown', OnEscape, true);
      if (HostModal) $(HostModal).off('hide.bs.modal.confirmToast');
      try {
        $toast.remove();
      } catch (err) {
        HandleNonFatalError('Toasts:NonFatal', err);
      }
      setConfirmDialogActive(false);
      // Back to where the focus was, if that is still on the page.
      if (Previous && Previous.isConnected) {
        try {
          Previous.focus();
        } catch {
          /* intentional: best-effort */
        }
      }
      resolve(Answer);
    };
    ActiveConfirmation = { Finish };

    $btnCancel.on('click', () => Finish(false));
    $btnConfirm.on('click', () => Finish(true));
    $btnAlt.on('click', () => Finish('alt'));

    document.addEventListener('keydown', OnEscape, true);
    if (HostModal) $(HostModal).one('hide.bs.modal.confirmToast', () => Finish(false));

    $toast.on('keydown', (e) => {
      const Native = e.originalEvent as KeyboardEvent | undefined;
      // A key held down (from the button that opened the dialog) repeats into
      // it: never let a repeat answer it.
      if ((e.key === 'Enter' || e.key === ' ') && Native?.repeat) {
        e.preventDefault();
        return;
      }
      const List = Buttons();
      const Index = List.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const Step = e.key === 'ArrowLeft' ? -1 : 1;
        const Next = Index === -1 ? List.length - 1 : (Index + Step + List.length) % List.length;
        List[Next]?.focus();
        return;
      }
      // Tab stays among the dialog's buttons while it is open.
      if (e.key === 'Tab') {
        e.preventDefault();
        const Step = e.shiftKey ? -1 : 1;
        const Next = Index === -1 ? 0 : (Index + Step + List.length) % List.length;
        List[Next]?.focus();
      }
    });

    // Confirm starts with the focus, so Enter (on it) confirms.
    setTimeout(() => {
      try {
        if (!Done) $btnConfirm.trigger('focus');
      } catch (err) {
        HandleNonFatalError('Toasts:NonFatal', err);
      }
    }, 0);
  });
}
