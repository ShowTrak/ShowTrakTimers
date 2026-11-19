// The repaint loop for running timers, shared by the desktop grid and the Web
// Dashboard. It sleeps until a tile would next show something different (see
// NextPaintDelay), then paints in the next animation frame, so DOM writes land
// with the frame that draws them and cost one style and layout pass. Nothing
// runs between those points, and nothing at all while the page is hidden.
export interface PaintLoop {
  /** Re-plan the next paint from the timers as they are now. */
  Schedule(): void;
  /** Drop any planned paint. */
  Cancel(): void;
}

export function CreatePaintLoop(Options: {
  /** Ms until the next paint is due, or null when nothing ticks. */
  Delay: () => number | null;
  /** Repaint whatever ticks. */
  Paint: () => void;
  /** Extra condition for running at all (the dashboard pauses while offline). */
  Active?: () => boolean;
}): PaintLoop {
  let Timer: ReturnType<typeof setTimeout> | null = null;
  let Frame: number | null = null;

  function Cancel(): void {
    if (Timer !== null) clearTimeout(Timer);
    if (Frame !== null) cancelAnimationFrame(Frame);
    Timer = null;
    Frame = null;
  }

  function Schedule(): void {
    Cancel();
    if (document.hidden || (Options.Active && !Options.Active())) return;
    const Delay = Options.Delay();
    if (Delay === null) return;
    Timer = setTimeout(() => {
      Timer = null;
      Frame = requestAnimationFrame(() => {
        Frame = null;
        Options.Paint();
        Schedule();
      });
    }, Delay);
  }

  return { Schedule, Cancel };
}
