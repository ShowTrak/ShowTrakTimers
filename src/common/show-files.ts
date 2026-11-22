// Show file names, as the main process and the renderer both handle them.

export const SHOW_FILE_EXTENSION = 'showtraktimers';

const EXTENSION_PATTERN = new RegExp(`\\.${SHOW_FILE_EXTENSION}$`, 'i');

/** A show file name without its folder or extension, as the title bar shows it. */
export function ShowFileDisplayName(FilePath: unknown): string {
  if (!FilePath) return '';
  const Base = String(FilePath).split(/[\\/]/).pop() || '';
  return Base.replace(EXTENSION_PATTERN, '');
}

/** Ensure a path picked in a save dialog ends with the show file extension. */
export function WithShowFileExtension(FilePath: string): string {
  return EXTENSION_PATTERN.test(FilePath) ? FilePath : `${FilePath}.${SHOW_FILE_EXTENSION}`;
}
