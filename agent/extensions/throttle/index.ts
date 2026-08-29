import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ThrottleConfig {
  enabled: boolean;
  delaySec: number;
}

export default function (pi: ExtensionAPI) {
  const config: ThrottleConfig = { enabled: false, delaySec: 8 };
  let nextAllowedAt = 0;

  function updateStatus(ctx: ExtensionContext): void {
    if (!config.enabled) {
      ctx.ui.setStatus("throttle", undefined);
      return;
    }
    const label = `throttle:${config.delaySec}s`;
    try {
      ctx.ui.setStatus("throttle", ctx.ui.theme.fg("warning", label));
    } catch {
      ctx.ui.setStatus("throttle", label);
    }
  }

  function parseDelay(input: string): number | null {
    const t = input.trim().toLowerCase();
    const m = t.match(/^(\d+(?:\.\d+)?)\s*s?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!isFinite(n) || n <= 0) return null;
    return Math.min(120, Math.max(1, n));
  }

  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0 || signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      const onAbort = () => done();
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function showSelector(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      const state = config.enabled ? `enabled ${config.delaySec}s` : "disabled";
      ctx.ui.notify(`Throttle ${state}. Use /throttle 8 or /throttle off`, "info");
      return;
    }

    const items = [
      "OFF (disabled)",
      "3s  - 20/min",
      "5s  - 12/min",
      "8s  - 7.5/min",
      "10s - 6/min",
      "15s - 4/min",
      "Custom...",
    ];

    const choice = await ctx.ui.select("Throttle delay (interval between requests)", items);
    if (choice === undefined) return;

    if (choice.startsWith("OFF")) {
      config.enabled = false;
      updateStatus(ctx);
      ctx.ui.notify("Throttle disabled", "info");
      return;
    }

    if (choice === "Custom...") {
      const input = await ctx.ui.input("Custom delay in seconds (1-120):", String(config.delaySec));
      if (input === undefined) return;
      const parsed = parseDelay(input);
      if (parsed === null) {
        ctx.ui.notify(`Invalid delay "${input}". Use 1-120`, "warning");
        return;
      }
      config.delaySec = parsed;
      config.enabled = true;
      updateStatus(ctx);
      ctx.ui.notify(`Throttle enabled: ${config.delaySec}s interval`, "info");
      return;
    }

    const parsed = parseDelay(choice);
    if (parsed === null) return;
    config.delaySec = parsed;
    config.enabled = true;
    updateStatus(ctx);
    ctx.ui.notify(`Throttle enabled: ${config.delaySec}s interval`, "info");
  }

  // Enforce minimum interval between provider request starts.
  // Remainder wait so natural spacing (typing, tool time) is not penalized.
  pi.on("before_provider_request", async (_event, ctx) => {
    if (!config.enabled) return;

    const waitMs = Math.max(0, nextAllowedAt - Date.now());
    if (waitMs > 0) {
      try {
        ctx.ui.setWorkingMessage(`throttle: waiting ${Math.ceil(waitMs / 1000)}s (${config.delaySec}s interval)`);
      } catch {
        // setWorkingMessage may be unavailable in some modes
      }
      await sleep(waitMs, ctx.signal);
      try {
        ctx.ui.setWorkingMessage(undefined);
      } catch {
        // ignore
      }
      if (ctx.signal?.aborted) return;
    }

    nextAllowedAt = Date.now() + config.delaySec * 1000;
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.registerCommand("throttle", {
    description: "Configure per-request throttle (e.g. /throttle 8, /throttle off, /throttle status)",
    getArgumentCompletions: (prefix: string) => {
      const candidates = ["off", "on", "status", "3", "5", "8", "10", "15", "3s", "5s", "8s", "10s", "15s"];
      const filtered = candidates.filter((c) => c.startsWith(prefix));
      return filtered.map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      if (!raw) {
        await showSelector(ctx);
        return;
      }

      const lower = raw.toLowerCase();

      if (lower === "off" || lower === "disable" || lower === "0") {
        config.enabled = false;
        updateStatus(ctx);
        ctx.ui.notify("Throttle disabled", "info");
        return;
      }

      if (lower === "on" || lower === "enable") {
        config.enabled = true;
        updateStatus(ctx);
        ctx.ui.notify(`Throttle enabled: ${config.delaySec}s interval`, "info");
        return;
      }

      if (lower === "status") {
        if (config.enabled) {
          const remaining = Math.max(0, Math.ceil((nextAllowedAt - Date.now()) / 1000));
          const extra = remaining > 0 ? ` (next slot in ${remaining}s)` : "";
          ctx.ui.notify(`Throttle enabled: ${config.delaySec}s interval${extra}`, "info");
        } else {
          ctx.ui.notify("Throttle disabled", "info");
        }
        return;
      }

      const parsed = parseDelay(raw);
      if (parsed !== null) {
        config.delaySec = parsed;
        config.enabled = true;
        updateStatus(ctx);
        ctx.ui.notify(`Throttle enabled: ${config.delaySec}s interval`, "info");
        return;
      }

      ctx.ui.notify(`Unknown argument "${raw}". Use: /throttle 8, /throttle off, /throttle status`, "warning");
    },
  });
}
