// An imported alert sound that plays the default sound instead when its file
// will not load or play.
//
// A Sound Library file can be on disk and still unplayable: an encoding
// Chromium cannot decode, or a file damaged after it was imported. Howler
// reports that through its loaderror/playerror callbacks and otherwise stays
// silent, so without this a timer's completion would make no sound at all.
// sounds.ts makes the real Howler player; the tests pass a stand-in.

/** The part of a Howler player this uses. */
export interface AlertPlayer {
  play(): number;
  load(): unknown;
  state(): 'unloaded' | 'loading' | 'loaded';
  volume(Value: number): unknown;
  unload(): void;
}

/** The callbacks the player must call when its file will not load or play. */
export interface AlertPlayerEvents {
  onloaderror: () => void;
  onplayerror: () => void;
}

export class AlertSound {
  readonly Player: AlertPlayer;
  private Failed = false;
  private Requested = false;

  /**
   * @param Create makes the player, wiring its error callbacks to `Events`.
   * @param Volume the sound's own volume, 0-1 (the Sound Library setting).
   * @param PlayFallback plays the default sound in its place.
   * @param OnBroken called once when the file turns out to be unplayable, so the
   *   caller can forget this player and try the file afresh next time.
   */
  constructor(
    Create: (Events: AlertPlayerEvents) => AlertPlayer,
    readonly Volume: number,
    private readonly PlayFallback: () => void,
    private readonly OnBroken: () => void
  ) {
    this.Player = Create({
      onloaderror: () => this.Fail(),
      onplayerror: () => this.Fail(),
    });
  }

  /** Whether the file has failed to load or play. */
  get Broken(): boolean {
    return this.Failed;
  }

  /** Play at the app's alert volume (0-1), or the default sound if broken. */
  Play(AlertVolume: number): void {
    if (this.Failed) {
      this.PlayFallback();
      return;
    }
    if (this.Player.state() === 'unloaded') this.Player.load();
    this.Player.volume(Math.min(1, AlertVolume * this.Volume));
    this.Requested = true;
    this.Player.play();
  }

  private Fail(): void {
    if (this.Failed) return;
    this.Failed = true;
    this.OnBroken();
    // Howler drops a play queued behind a load that fails, so the alert that
    // was asked for is played here. A file that fails to load before anyone
    // plays it (it preloads) waits for the first Play to fall back.
    if (this.Requested) this.PlayFallback();
  }
}
