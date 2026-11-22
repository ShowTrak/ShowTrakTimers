// Toasts and the confirmation dialog: the renderer kit's (shared with ShowTrak
// Server), in Timers' filled icons, with an open question recorded in the
// state so the keyboard shortcuts stand down while it waits.
//   - `Notify`: a top-centre, hover-pausable toast.
//   - `ConfirmationDialog`: one promise-based, keyboard-driven question at a
//     time; `CancelConfirmation` answers a waiting one with Cancel.
import { CreateToasts } from '@showtrak/protocol/ui/toasts';
import { CreateConfirmationDialog } from '@showtrak/protocol/ui/confirm-dialog';
import { setConfirmDialogActive } from '../state';

export { CancelConfirmation } from '@showtrak/protocol/ui/confirm-dialog';

export const { Notify } = CreateToasts({ IconStyle: 'fill' });

export const ConfirmationDialog = CreateConfirmationDialog({
  OnActiveChange: (Active) => setConfirmDialogActive(Active),
});
