// Thin wrappers over the Bootstrap modal show/hide calls (from ShowTrak
// Server), so there is one place to evolve modal handling.

/** Show the modal with the given element id. No-op if it isn't in the DOM. */
export function openModal(id: string): void {
  $('#' + id).modal('show');
}

/** Hide the modal with the given element id. */
export function closeModal(id: string): void {
  $('#' + id).modal('hide');
}

/** Hide every open modal (matches the legacy `$('.modal').modal('hide')`). */
export function closeAllModals(): void {
  $('.modal').modal('hide');
}

/** Run `fn` once, the next time the given modal finishes hiding. */
export function onceHidden(id: string, fn: () => void): void {
  $('#' + id).one('hidden.bs.modal', fn);
}
