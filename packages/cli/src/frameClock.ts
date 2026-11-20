/** `unmounted` = no state or no renderer; `animating` = some node is running. */
export interface Frame {
  status(): "unmounted" | "still" | "animating";
  relayout(): void;
  paint(): void;
}

export class FrameClock {
  private frameIndex = 0;
  private dirty = false;
  private resized = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly frame: Frame,
    private readonly tickMs: number,
  ) {}

  arm(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => this.onTick(), this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  owed(): void {
    this.dirty = true;
    this.arm();
  }

  resize(): void {
    this.resized = true;
    this.owed();
  }

  painted(): void {
    this.dirty = false;
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  spin(): number {
    return this.frameIndex;
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private onTick(): void {
    const status = this.frame.status();
    if (status === "unmounted") return;
    if (status !== "animating" && !this.dirty) {
      this.disarm();
      return;
    }
    if (status === "animating") this.frameIndex += 1;
    this.dirty = false;
    if (this.resized) {
      this.resized = false;
      this.frame.relayout();
      return;
    }
    this.frame.paint();
  }
}
