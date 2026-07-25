import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Armed by the hotkey; consumed by agent_settled. Module-scoped so it survives
// across the idle handler and the event handler within one process lifetime.
let armed = false;

const STATUS_KEY = "suspend";

const clearStatus = (ctx: { ui: { setStatus: (k: string, t: string | undefined) => void } }) =>
  ctx.ui.setStatus(STATUS_KEY, undefined);

const runSuspend = (
  ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } },
) => {
  // Detached + unref'd so the process outlives pi if pi exits before suspend takes effect.
  const child = spawn("systemctl", ["suspend"], { detached: true, stdio: "ignore" });
  child.unref();
  child.on("error", () => {
    ctx.ui.notify("Suspend failed: systemctl unavailable (non-Linux or not installed).", "error");
  });
};

export default (pi: ExtensionAPI) => {
  pi.registerShortcut("alt+s", {
    description: "Queue system suspend when the agent finishes (press again to cancel)",
    handler: async (ctx) => {
      if (ctx.isIdle()) {
        ctx.ui.notify("Suspending now...", "info");
        runSuspend(ctx);
        return;
      }
      if (!armed) {
        armed = true;
        ctx.ui.setStatus(STATUS_KEY, "suspend queued");
        ctx.ui.notify("Suspend queued — runs when agent settles. alt+s again to cancel.", "info");
        return;
      }
      armed = false;
      clearStatus(ctx);
      ctx.ui.notify("Suspend cancelled.", "info");
    },
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!armed) return;
    armed = false;
    clearStatus(ctx);
    runSuspend(ctx);
  });

  // Clear a stale arm if the session switches before the agent settles.
  pi.on("session_start", () => {
    armed = false;
  });
};
