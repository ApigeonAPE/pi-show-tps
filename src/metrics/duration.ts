/**
 * Duration metric — wall-clock time spent on the current user request.
 *
 * The anchor is the agent run's start, so one reading spans everything the user
 * waits for: every model request in the run, the tool calls between them, and
 * the final answer. A tool-using request therefore does not restart at each
 * assistant message or at each `turn_start` (pi emits one of those per model
 * request), and the reading keeps growing while a tool runs.
 *
 * A response that arrives with no run around it still gets timed from its own
 * `timestamp`, so the segment works when the controller sees only messages.
 *
 * This is the one segment that keeps moving without stream events, so it asks
 * the controller for a repaint tick for as long as the run lasts; the value
 * then counts up even while the model is thinking or a tool is running.
 */

import { formatDuration } from "../format.ts";
import { isDroppedResponse } from "./message.ts";
import type { AssistantMessage, Metric, Theme } from "./types.ts";

export class DurationMetric implements Metric {
  readonly ticksWhileStreaming = true;
  /** Start stamp of the run currently being timed. */
  #anchor: number | undefined;
  /** Last measured reading; what the idle row shows. */
  #frozen: number | undefined;
  /** Whether the clock is currently running. */
  #running = false;
  /** Whether the anchor belongs to a run rather than to a lone response. */
  #runOwned = false;

  reset(): void {
    this.#anchor = undefined;
    this.#frozen = undefined;
    this.#running = false;
    this.#runOwned = false;
  }

  onAgentStart(now: number): void {
    this.#anchor = now;
    this.#frozen = undefined;
    this.#running = true;
    this.#runOwned = true;
  }

  onAgentEnd(now: number): void {
    // Without an agent start there is nothing run-scoped to close; the response
    // hooks below freeze the lone response instead.
    if (!this.#runOwned) return;
    this.#freeze(now);
    this.#running = false;
    this.#runOwned = false;
  }

  onMessageStart(message: AssistantMessage): void {
    // The run owns the clock: a follow-up request after a tool call continues
    // the same reading instead of restarting it.
    if (this.#runOwned) {
      this.#running = true;
      return;
    }
    this.#anchor = message.timestamp;
    this.#running = true;
  }

  onUpdate(): void {
    // Nothing to collect: the reading is derived from the clock in `render`,
    // so it counts up between events without holding a timer in the metric.
  }

  onMessageEnd(message: AssistantMessage, now: number): void {
    // A run outlives its responses: a tool call follows, and the clock keeps
    // running until `onAgentEnd` freezes it.
    if (this.#runOwned) return;
    this.#running = false;
    // Interrupted or failed: keep the previous reading rather than freezing a
    // time that describes a response which never finished.
    if (isDroppedResponse(message)) return;
    this.#freeze(now);
  }

  render(theme: Theme, _streaming: boolean, now: number): string {
    const anchor = this.#anchor;
    const ms =
      this.#running && anchor !== undefined
        ? Math.max(0, now - anchor)
        : this.#frozen;
    return formatDuration(theme, { ms, active: this.#running });
  }

  #freeze(now: number): void {
    const anchor = this.#anchor;
    if (anchor === undefined) return;
    const ms = now - anchor;
    if (Number.isFinite(ms) && ms >= 0) this.#frozen = ms;
  }
}
