import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { OcCompactConfig, OcCompactRetry, PruneTrigger } from "./types";

export const SETTINGS_PATH_DEFAULT = join(homedir(), ".pi", "agent", "oc-compact-config.json");

const settingsPath = (): string => process.env.PI_OC_COMPACT_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT;

const DEFAULT_RETRY: OcCompactRetry = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
};

export const DEFAULT_CONFIG: OcCompactConfig = {
  enabled: true,
  prune: true,
  pruneTrigger: "pressure",
  prunePressureRatio: null,
  pruneProtectTokens: 40_000,
  pruneMinimumTokens: 20_000,
  pruneTailTurns: 2,
  pruneProtectedTools: ["skill"],
  tailTurns: 2,
  preserveRecentTokens: null,
  reserveTokens: 16_384,
  toolOutputMaxChars: 2000,
  stripMedia: true,
  autoContinue: true,
  summaryMaxTokens: 4096,
  retainedSuffixMaxChars: 24_000,
  retry: { ...DEFAULT_RETRY },
  debug: false,
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

const asNumber = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const asBool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

const asStringArray = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fallback;

const parsePruneTrigger = (v: unknown): PruneTrigger =>
  v === "always" || v === "pressure" ? v : DEFAULT_CONFIG.pruneTrigger;

const parsePrunePressureRatio = (v: unknown): number | null => {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return DEFAULT_CONFIG.prunePressureRatio;
  return Math.min(1, v);
};

const parseRetry = (raw: unknown): OcCompactRetry => {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_RETRY };
  const r = raw as Record<string, unknown>;
  return {
    enabled: asBool(r.enabled, DEFAULT_RETRY.enabled),
    maxRetries: Math.max(0, Math.floor(asNumber(r.maxRetries, DEFAULT_RETRY.maxRetries))),
    baseDelayMs: Math.max(0, Math.floor(asNumber(r.baseDelayMs, DEFAULT_RETRY.baseDelayMs))),
  };
};

export function loadConfig(): OcCompactConfig {
  const parsed = readJson(settingsPath());
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG, retry: { ...DEFAULT_RETRY } };

  const preserveRaw = parsed.preserveRecentTokens;
  const preserveRecentTokens =
    preserveRaw === null
      ? null
      : typeof preserveRaw === "number" && Number.isFinite(preserveRaw)
        ? Math.max(0, Math.floor(preserveRaw))
        : DEFAULT_CONFIG.preserveRecentTokens;

  return {
    enabled: asBool(parsed.enabled, DEFAULT_CONFIG.enabled),
    prune: asBool(parsed.prune, DEFAULT_CONFIG.prune),
    pruneTrigger: parsePruneTrigger(parsed.pruneTrigger),
    prunePressureRatio: parsePrunePressureRatio(parsed.prunePressureRatio),
    pruneProtectTokens: Math.max(0, Math.floor(asNumber(parsed.pruneProtectTokens, DEFAULT_CONFIG.pruneProtectTokens))),
    pruneMinimumTokens: Math.max(0, Math.floor(asNumber(parsed.pruneMinimumTokens, DEFAULT_CONFIG.pruneMinimumTokens))),
    pruneTailTurns: Math.max(0, Math.floor(asNumber(parsed.pruneTailTurns, DEFAULT_CONFIG.pruneTailTurns))),
    pruneProtectedTools: asStringArray(parsed.pruneProtectedTools, DEFAULT_CONFIG.pruneProtectedTools),
    tailTurns: Math.max(0, Math.floor(asNumber(parsed.tailTurns, DEFAULT_CONFIG.tailTurns))),
    preserveRecentTokens,
    reserveTokens: Math.max(0, Math.floor(asNumber(parsed.reserveTokens, DEFAULT_CONFIG.reserveTokens))),
    toolOutputMaxChars: Math.max(0, Math.floor(asNumber(parsed.toolOutputMaxChars, DEFAULT_CONFIG.toolOutputMaxChars))),
    stripMedia: asBool(parsed.stripMedia, DEFAULT_CONFIG.stripMedia),
    autoContinue: asBool(parsed.autoContinue, DEFAULT_CONFIG.autoContinue),
    summaryMaxTokens: Math.max(256, Math.floor(asNumber(parsed.summaryMaxTokens, DEFAULT_CONFIG.summaryMaxTokens))),
    retainedSuffixMaxChars: Math.max(
      0,
      Math.floor(asNumber(parsed.retainedSuffixMaxChars, DEFAULT_CONFIG.retainedSuffixMaxChars)),
    ),
    retry: parseRetry(parsed.retry),
    debug: asBool(parsed.debug, DEFAULT_CONFIG.debug),
  };
}

/** Ensure config file exists; fill missing keys without clobbering invalid JSON. */
export function scaffoldConfig(): void {
  try {
    const path = settingsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
      return;
    }

    const parsed = readJson(path);
    if (!parsed || typeof parsed !== "object") return;

    let changed = false;
    const next: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if (!(key in next)) {
        next[key] = value;
        changed = true;
      }
    }
    if (
      next.retry &&
      typeof next.retry === "object" &&
      !Array.isArray(next.retry)
    ) {
      const retry = next.retry as Record<string, unknown>;
      for (const [key, value] of Object.entries(DEFAULT_RETRY)) {
        if (!(key in retry)) {
          retry[key] = value;
          changed = true;
        }
      }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // best-effort
  }
}
