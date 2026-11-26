/**
 * Token rate for the pi TUI footer.
 *
 * Watches the assistant message stream and shows how fast the active model is
 * producing output tokens, how long it took to start, and how long the response
 * has been running:
 *
 *   TPS 62 tok/s · TTFT 1.2s · TIME 4s
 *
 * The rate is measured over a trailing window while tokens arrive, so it stays
 * readable between bursty deltas; there is no session history and no settled
 * average. TTFT is the gap from the request to the first token of the current
 * response, and elapsed time is the whole user request: it starts when the
 * agent run starts and spans every request and tool call in the run, counting
 * up once a second (the tick that keeps it moving is owned by the controller). This file only
 * wires events to the controller in `./line.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MetricsLine } from "./line.ts";

const USAGE = "tps: /tps";

export default function (pi: ExtensionAPI) {
  const line = new MetricsLine();

  pi.on("session_start", (_event, ctx) => {
    line.start(ctx);
  });

  pi.on("session_shutdown", () => {
    line.stop();
  });

  pi.on("agent_start", (_event, ctx) => {
    line.onAgentStart(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    line.onAgentEnd(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    line.onMessageStart(ctx, event.message);
  });

  pi.on("message_update", (event, ctx) => {
    line.onUpdate(ctx, event);
  });

  pi.on("message_end", (event, ctx) => {
    line.onMessageEnd(ctx, event.message);
  });

  pi.registerCommand("tps", {
    description: "Show or hide the TPS/TTFT/TIME status line",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("tps: no UI in this mode", "warning");
        return;
      }
      if (args.trim() !== "") {
        ctx.ui.notify(USAGE, "warning");
        return;
      }

      ctx.ui.notify(
        line.toggle(ctx) ? "tps: status line on" : "tps: status line off",
        "info",
      );
    },
  });
}
