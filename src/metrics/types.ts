/**
 * The contract every status-row segment implements.
 *
 * A metric owns one number and its display state. It receives the assistant
 * stream, keeps whatever history it needs, and renders its own segment; the
 * controller in `../line.ts` only orders the segments and throttles writes.
 * TPS and TTFT are deliberately independent — they share no state and are
 * never derived from each other — so a new indicator is a new module plus one
 * entry in the controller's metric list.
 */

import type {
  ExtensionContext,
  MessageEndEvent,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";

export type Theme = ExtensionContext["ui"]["theme"];

/** The assistant message shape the stream events carry. */
export type AssistantMessage = Extract<
  MessageEndEvent["message"],
  { role: "assistant" }
>;

export interface Metric {
  /**
   * Whether this segment keeps changing without new stream events. A stopwatch
   * does, so the controller repaints it on a tick while a response streams.
   */
  readonly ticksWhileStreaming?: boolean;
  /** Forget everything, e.g. at session start. */
  reset(): void;
  /**
   * A user request starts the agent run, before the first request of the run.
   * A metric that measures the whole run rather than one response anchors here.
   */
  onAgentStart?(now: number): void;
  /** The run is over; a run-scoped metric freezes its reading here. */
  onAgentEnd?(now: number): void;
  /** A new assistant response begins; per-response state resets here. */
  onMessageStart(message: AssistantMessage): void;
  /**
   * Stream progress. Every event is offered — including content-block starts
   * — and the metric decides what it needs; `now` is the controller's clock.
   */
  onUpdate(event: MessageUpdateEvent, now: number): void;
  /** The response ended; freeze or drop the reading per the metric's rules. */
  onMessageEnd(message: AssistantMessage, now: number): void;
  /** Render this metric's segment for the current state. */
  render(theme: Theme, streaming: boolean, now: number): string;
}
