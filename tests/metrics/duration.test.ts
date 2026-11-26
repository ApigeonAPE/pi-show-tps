/**
 * Duration metric in isolation: the request anchor, the whole-second reading,
 * the minute format, and the freeze/keep rules.
 */

import { describe, it } from "node:test";

import { DurationMetric } from "../../src/metrics/duration.ts";
import { expect } from "../helpers/expect.ts";
import {
  type AssistantMessage,
  makeAssistantMessage,
} from "../helpers/messages.ts";
import { theme } from "../helpers/theme.ts";

const START = 1_000;

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return makeAssistantMessage({ timestamp: START, ...overrides });
}

/** The segment as it is painted while a response streams. */
function live(metric: DurationMetric, now: number): string {
  return metric.render(theme, true, now);
}

/** The segment as it is painted once the response is over. */
function idle(metric: DurationMetric, now: number): string {
  return metric.render(theme, false, now);
}

describe("DurationMetric", () => {
  it("counts from the message's request stamp in whole seconds", () => {
    const metric = new DurationMetric();
    metric.onMessageStart(message());

    expect(live(metric, START)).toBe("[text]TIME[/] [text]0s[/]");
    expect(live(metric, START + 999)).toBe("[text]TIME[/] [text]0s[/]");
    expect(live(metric, START + 1_000)).toBe("[text]TIME[/] [text]1s[/]");
    // Floored, never rounded up: the second must have fully elapsed.
    expect(live(metric, START + 1_999)).toBe("[text]TIME[/] [text]1s[/]");
    expect(live(metric, START + 4_500)).toBe("[text]TIME[/] [text]4s[/]");
  });

  it("switches to minutes and seconds past the minute", () => {
    const metric = new DurationMetric();
    metric.onMessageStart(message());

    expect(live(metric, START + 60_000)).toBe("[text]TIME[/] [text]1m00s[/]");
    expect(live(metric, START + 72_400)).toBe("[text]TIME[/] [text]1m12s[/]");
    expect(live(metric, START + 3_661_000)).toBe(
      "[text]TIME[/] [text]61m01s[/]",
    );
  });

  it("freezes the final reading dimmed when the response ends", () => {
    const metric = new DurationMetric();
    const m = message();
    metric.onMessageStart(m);
    metric.onMessageEnd(m, START + 4_400);

    expect(idle(metric, START + 4_400)).toBe("[dim]TIME[/] [dim]4s[/]");
    // The clock moving after the end cannot change a frozen reading.
    expect(idle(metric, START + 90_000)).toBe("[dim]TIME[/] [dim]4s[/]");
  });

  it("shows a placeholder before anything was measured", () => {
    const metric = new DurationMetric();

    expect(live(metric, START)).toBe("[dim]TIME[/] [dim]— s[/]");
    expect(idle(metric, START)).toBe("[dim]TIME[/] [dim]— s[/]");
  });

  it("keeps the previous reading when a response is aborted", () => {
    const metric = new DurationMetric();
    const finished = message();
    metric.onMessageStart(finished);
    metric.onMessageEnd(finished, START + 3_000);

    const aborted = message({ timestamp: 10_000, stopReason: "aborted" });
    metric.onMessageStart(aborted);
    metric.onMessageEnd(aborted, 10_000 + 500);

    expect(idle(metric, 10_000 + 500)).toBe("[dim]TIME[/] [dim]3s[/]");
  });

  it("times a lone response from its own stamp when no run is open", () => {
    const metric = new DurationMetric();

    const first = message();
    metric.onMessageStart(first);
    metric.onMessageEnd(first, START + 2_000);

    const second = message({ timestamp: 10_000 });
    metric.onMessageStart(second);

    expect(live(metric, 10_000 + 1_200)).toBe("[text]TIME[/] [text]1s[/]");
  });

  it("spans a whole run instead of restarting at each response", () => {
    const metric = new DurationMetric();

    metric.onAgentStart(START);
    // The first request starts 4s into the run, and its response ends at 6s.
    const first = message({ timestamp: START + 4_000 });
    metric.onMessageStart(first);
    metric.onMessageEnd(first, START + 6_000);

    // A tool runs with no stream events; the run clock keeps going.
    expect(live(metric, START + 8_000)).toBe("[text]TIME[/] [text]8s[/]");

    // The follow-up request after the tool call does not restart the reading.
    const second = message({ timestamp: START + 9_000 });
    metric.onMessageStart(second);
    expect(live(metric, START + 10_500)).toBe("[text]TIME[/] [text]10s[/]");
  });

  it("freezes the run reading when the run ends", () => {
    const metric = new DurationMetric();
    const m = message();
    metric.onAgentStart(START);
    metric.onMessageStart(m);
    metric.onMessageEnd(m, START + 4_000);
    metric.onAgentEnd(START + 12_000);

    expect(idle(metric, START + 12_000)).toBe("[dim]TIME[/] [dim]12s[/]");
    // A later run cannot move a frozen reading in the meantime.
    expect(idle(metric, START + 40_000)).toBe("[dim]TIME[/] [dim]12s[/]");
  });

  it("restarts from zero for the next run", () => {
    const metric = new DurationMetric();
    const m = message();
    metric.onAgentStart(START);
    metric.onMessageStart(m);
    metric.onAgentEnd(START + 9_000);

    metric.onAgentStart(START + 20_000);

    expect(live(metric, START + 20_000)).toBe("[text]TIME[/] [text]0s[/]");
  });

  it("forgets everything on reset", () => {
    const metric = new DurationMetric();
    const m = message();
    metric.onMessageStart(m);
    metric.onMessageEnd(m, START + 5_000);

    metric.reset();

    expect(idle(metric, START + 5_000)).toBe("[dim]TIME[/] [dim]— s[/]");
  });
});
