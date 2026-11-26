/**
 * Status-line controller.
 *
 * Owns the footer row: it observes assistant stream events, offers each of
 * them to every metric, throttles the writes so a fast stream does not ask the
 * TUI to re-render on every delta, and composes the segments into one line.
 *
 * The controller holds at most one timer: the repaint tick a metric can ask for
 * while an agent run lasts. The elapsed stopwatch needs it because no stream
 * event arrives while the model is thinking or a tool is running. The tick is
 * cleared on `agent_end`, on hide, and on `stop()`. It knows nothing about what a metric
 * measures; adding a segment means adding a metric module and appending it to
 * the metric list.
 */

import type {
  ExtensionContext,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";

import { joinSegments } from "./format.ts";
import { DurationMetric } from "./metrics/duration.ts";
import { TpsMetric } from "./metrics/tps.ts";
import { TtftMetric } from "./metrics/ttft.ts";
import type { Metric } from "./metrics/types.ts";

/** Footer row identifier. */
const STATUS_KEY = "token-rate";

/**
 * Minimum gap between footer writes while streaming. ~6 updates per second is
 * fast enough to look live, slow enough to stay off the render path of every
 * token delta.
 */
const WRITE_INTERVAL_MS = 150;

/**
 * Repaint cadence for metrics that move without stream events. Four ticks a
 * second keep a whole-second stopwatch within a quarter second of the clock
 * while the cached row suppresses all but the writes that actually changed.
 */
const TICK_INTERVAL_MS = 250;

export class MetricsLine {
  /** Segments in display order: TPS, TTFT, then elapsed time. */
  readonly #metrics: readonly Metric[] = [
    new TpsMetric(),
    new TtftMetric(),
    new DurationMetric(),
  ];
  #visible = true;
  #streaming = false;
  /** Between `agent_start` and `agent_end`; one user request, all its turns. */
  #inRun = false;
  #lastWriteAt = Number.NEGATIVE_INFINITY;
  #rendered: string | undefined;
  #tick: ReturnType<typeof setInterval> | undefined;
  readonly #now: () => number;

  /** `now` is injectable so tests can drive the throttle deterministically. */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Session start: forget everything, including a line a reload left behind. */
  start(ctx: ExtensionContext): void {
    this.#stopTick();
    for (const metric of this.#metrics) metric.reset();
    this.#visible = true;
    this.#streaming = false;
    this.#inRun = false;
    this.#lastWriteAt = Number.NEGATIVE_INFINITY;
    this.#rendered = undefined;
    this.#write(ctx, undefined);
  }

  /** A user request starts: run-scoped metrics anchor here, the tick starts. */
  onAgentStart(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    this.#inRun = true;
    const now = this.#now();
    for (const metric of this.#metrics) metric.onAgentStart?.(now);
    this.#lastWriteAt = Number.NEGATIVE_INFINITY;
    this.#startTick(ctx);
    this.#render(ctx, this.#streaming);
  }

  /** The run is over: freeze run-scoped readings and let the tick go. */
  onAgentEnd(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const now = this.#now();
    for (const metric of this.#metrics) metric.onAgentEnd?.(now);
    this.#inRun = false;
    if (!this.#streaming) this.#stopTick();
    this.#lastWriteAt = Number.NEGATIVE_INFINITY;
    this.#render(ctx, this.#streaming);
  }

  /** A new assistant message begins; every metric reopens its measurement. */
  onMessageStart(
    ctx: ExtensionContext,
    message: MessageStartEvent["message"],
  ): void {
    if (!ctx.hasUI || message.role !== "assistant") return;
    for (const metric of this.#metrics) metric.onMessageStart(message);
    this.#streaming = true;
    // The next delta writes immediately instead of waiting out an old throttle.
    this.#lastWriteAt = Number.NEGATIVE_INFINITY;
    this.#startTick(ctx);
  }

  /** Stream progress. Throttled: every metric still sees every observation. */
  onUpdate(ctx: ExtensionContext, event: MessageUpdateEvent): void {
    if (!ctx.hasUI || event.message.role !== "assistant") return;

    const now = this.#now();
    for (const metric of this.#metrics) metric.onUpdate(event, now);

    if (now - this.#lastWriteAt < WRITE_INTERVAL_MS) return;
    this.#lastWriteAt = now;
    this.#render(ctx, true);
  }

  /** The response is done: metrics freeze their last reading and the row dims. */
  onMessageEnd(
    ctx: ExtensionContext,
    message: MessageEndEvent["message"],
  ): void {
    if (!ctx.hasUI || message.role !== "assistant") return;

    const now = this.#now();
    for (const metric of this.#metrics) metric.onMessageEnd(message, now);
    this.#streaming = false;
    // A tool call may follow this response inside the same run, so the tick
    // only stops when the run is over too.
    if (!this.#inRun) this.#stopTick();
    this.#lastWriteAt = Number.NEGATIVE_INFINITY;
    this.#render(ctx, false);
  }

  /** Flip the row on or off. Returns the new visibility. */
  toggle(ctx: ExtensionContext): boolean {
    this.#visible = !this.#visible;
    if (this.#visible) {
      this.#startTick(ctx);
    } else {
      this.#stopTick();
    }
    this.#render(ctx, this.#streaming);
    return this.#visible;
  }

  /** Release the repaint tick, e.g. when the session ends mid-response. */
  stop(): void {
    this.#stopTick();
  }

  /**
   * Start the repaint tick if any metric needs it and the row can be seen. The
   * tick only repaints; it never touches metric state, so a late tick cannot
   * invent a reading.
   */
  #startTick(ctx: ExtensionContext): void {
    if (this.#tick !== undefined || !this.#visible) return;
    if (!this.#inRun && !this.#streaming) return;
    if (!ctx.hasUI) return;
    if (!this.#metrics.some((metric) => metric.ticksWhileStreaming)) return;
    const tickCtx = ctx;
    this.#tick = setInterval(() => {
      if (this.#inRun || this.#streaming) {
        this.#render(tickCtx, this.#streaming);
      }
    }, TICK_INTERVAL_MS);
  }

  #stopTick(): void {
    if (this.#tick === undefined) return;
    clearInterval(this.#tick);
    this.#tick = undefined;
  }

  /** Paint every metric's segment, or blank the row while hidden. */
  #render(ctx: ExtensionContext, streaming: boolean): void {
    if (!this.#visible) {
      // Forget the cached line so showing it again always repaints — but
      // don't re-clear a row that is already blank on every stream tick.
      if (this.#rendered === undefined) return;
      this.#rendered = undefined;
      this.#write(ctx, undefined);
      return;
    }

    const now = this.#now();
    const segments = this.#metrics.map((metric) =>
      metric.render(ctx.ui.theme, streaming, now),
    );
    const text = joinSegments(ctx.ui.theme, segments);
    if (text === this.#rendered) return;
    this.#rendered = text;
    this.#write(ctx, text);
  }

  #write(ctx: ExtensionContext, text: string | undefined): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, text);
  }
}
