"use client";

import { useEffect, useState } from "react";

type CameraStats = {
  name: string;
  todayVisitors: number;
  totalVisitors: number;
  entries: number;
  last5Minutes: number;
  online: boolean;
  connected: boolean;
  feedAvailable: boolean;
  fps: number;
  sessionEntries: number;
  lastSeenAt: string | null;
};

type Stats = {
  todayVisitors: number;
  totalVisitors: number;
  /** Hourly-adjusted estimates (see README "Estimated (hourly-adjusted) counts"). */
  estimatedTodayVisitors?: number;
  estimatedTotalVisitors?: number;
  timezone: string;
  date: string;
  event: { startDate: string | null; endDate: string | null };
  total: number;
  last5Minutes: number;
  lastEntryAt: string | null;
  serverTime: string;
  workerOnline: boolean;
  cameras: CameraStats[];
};

// Response of GET /api/stats/estimate (audit breakdown for today).
type EstimateWindow = {
  start: string;
  end: string;
  complete: boolean;
  rawEntries: number;
  adjustmentPercent: number;
  deduction: number;
  adjustedEntries: number;
};

type EstimateAudit = {
  timezone: string;
  date: string;
  threshold: number;
  rawVisitors: number;
  estimatedVisitors: number;
  activatedAt: string | null;
  windows: EstimateWindow[];
};

const POLL_MS = 1500;
// The hourly breakdown changes slowly; it is refreshed far less often than the counters.
const AUDIT_POLL_MS = 30_000;
const PREVIEW_RETRY_MS = 10_000;
// The worker serves its annotated previews on localhost only: <base>/stream/<camera>.
const PREVIEW_BASE = process.env.NEXT_PUBLIC_PREVIEW_URL ?? "http://127.0.0.1:8765";
// Entrances shown even before the worker has reported them.
const EXPECTED_CAMERAS = ["A", "B"];

// Times and dates are shown in the event timezone reported by the API, not the browser's.
function formatTime(iso: string | null, timeZone: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone });
}

function formatDay(date: string | null | undefined): string {
  if (!date) return "—";
  // A bare "YYYY-MM-DD" is a calendar day; format it at UTC noon so no timezone shifts it.
  return new Date(`${date}T12:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function cameraStatus(cam: CameraStats | undefined, haveStats: boolean): { label: string; tone: "good" | "bad" | "warn" } {
  if (!haveStats) return { label: "Connecting…", tone: "warn" };
  if (!cam || !cam.online) return { label: "Worker offline", tone: "bad" };
  if (!cam.connected) return { label: "Camera disconnected", tone: "bad" };
  if (!cam.feedAvailable) return { label: "Camera feed unavailable", tone: "bad" };
  return { label: "Camera connected", tone: "good" };
}

function StatusPill({ label, tone }: { label: string; tone: "good" | "bad" | "warn" }) {
  const styles = {
    good: "bg-emerald-100 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300",
    bad: "bg-rose-100 text-rose-800 ring-rose-600/20 dark:bg-rose-950 dark:text-rose-300",
    warn: "bg-amber-100 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300",
  };
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${styles[tone]}`}>
      <span className={`size-2 rounded-full ${tone === "good" ? "bg-emerald-500" : tone === "bad" ? "bg-rose-500" : "bg-amber-500"}`} />
      {label}
    </span>
  );
}

function StatCard({ title, value, hint, estimate }: { title: string; value: string; hint?: string; estimate?: boolean }) {
  return (
    <div
      className={`rounded-2xl p-5 shadow-sm ring-1 ${
        estimate
          ? "bg-amber-50/60 ring-amber-200 dark:bg-amber-950/20 dark:ring-amber-900/60"
          : "bg-white ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800"
      }`}
    >
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{title}</p>
      <p className="mt-2 text-4xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50 sm:text-5xl">{value}</p>
      {hint && <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

/**
 * Today's hourly adjustment breakdown from GET /api/stats/estimate, refreshed every
 * AUDIT_POLL_MS, whenever the IST date changes, and on demand. The last good result
 * stays visible if a refresh fails, with the error shown next to it.
 */
function useEstimateAudit(date: string | undefined) {
  const [audit, setAudit] = useState<EstimateAudit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/stats/estimate", { cache: "no-store", signal: controller.signal });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body || !Array.isArray(body.windows)) {
          setError(body?.error ?? `The estimate API returned HTTP ${res.status}.`);
        } else {
          setAudit(body as EstimateAudit);
          setError(null);
        }
      } catch (err) {
        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
          setError("Cannot reach the estimate API.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const timer = setInterval(load, AUDIT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [date, refreshKey]);

  return { audit, error, loading, refresh: () => setRefreshKey((k) => k + 1) };
}

function HourlyBreakdown({ date }: { date: string | undefined }) {
  const { audit, error, loading, refresh } = useEstimateAudit(date);
  const tz = audit?.timezone;
  const hasProvisional = audit?.windows.some((w) => !w.complete) ?? false;

  return (
    <section className="rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div>
          <h2 className="text-sm font-medium">Hourly adjustment · {audit ? `${formatDay(audit.date)} (IST)` : "today"}</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Estimate only. Raw counts are never changed. Refreshes every 30 s.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-50 dark:ring-zinc-700 dark:hover:bg-zinc-800"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p role="alert" className="border-b border-zinc-200 px-5 py-2 text-sm text-rose-700 dark:border-zinc-800 dark:text-rose-300">
          {error}
          {audit ? " Showing the last loaded breakdown." : ""}
        </p>
      )}

      {!audit ? (
        <p className="px-5 py-6 text-sm text-zinc-500 dark:text-zinc-400">{error ? "No breakdown available." : "Loading…"}</p>
      ) : audit.activatedAt === null ? (
        <p className="px-5 py-6 text-sm text-zinc-500 dark:text-zinc-400">
          Adjustment not active yet: {audit.rawVisitors.toLocaleString()} of the first {audit.threshold.toLocaleString()} entries
          today. Until the threshold is reached the estimate equals the raw count.
        </p>
      ) : (
        <>
          <p className="px-5 pt-4 text-sm text-zinc-600 dark:text-zinc-300">
            Activated at {formatTime(audit.activatedAt, tz)} IST by the {audit.threshold.toLocaleString()}th entry. Raw{" "}
            {audit.rawVisitors.toLocaleString()} → estimated {audit.estimatedVisitors.toLocaleString()} (the first{" "}
            {audit.threshold.toLocaleString()} entries are never adjusted).
          </p>
          <div className="overflow-x-auto px-5 py-4">
            <table className="w-full min-w-[640px] text-left text-sm tabular-nums">
              <thead className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="py-2 pr-4 font-medium">Window (IST)</th>
                  <th className="py-2 pr-4 text-right font-medium">Raw entries</th>
                  <th className="py-2 pr-4 text-right font-medium">Adjustment</th>
                  <th className="py-2 pr-4 text-right font-medium">Deducted</th>
                  <th className="py-2 pr-4 text-right font-medium">Estimated</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {audit.windows.map((w) => (
                  <tr key={w.start} className={w.complete ? "" : "bg-amber-50/70 dark:bg-amber-950/20"}>
                    <td className="py-2 pr-4">
                      {formatTime(w.start, tz)} – {formatTime(w.end, tz)}
                    </td>
                    <td className="py-2 pr-4 text-right">{w.rawEntries.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right">{w.adjustmentPercent}%</td>
                    <td className="py-2 pr-4 text-right">{w.complete ? w.deduction.toLocaleString() : "—"}</td>
                    <td className="py-2 pr-4 text-right">{w.adjustedEntries.toLocaleString()}</td>
                    <td className="py-2">
                      {w.complete ? (
                        <span className="text-zinc-600 dark:text-zinc-300">Completed</span>
                      ) : (
                        <span className="font-medium text-amber-800 dark:text-amber-300">In progress · provisional</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hasProvisional && (
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                The window in progress counts unadjusted. Its deduction is applied only when the hour closes, so the estimate can
                drop at that moment.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function CameraPanel({ name, cam, haveStats, now }: { name: string; cam: CameraStats | undefined; haveStats: boolean; now: number }) {
  // When the <img> stream errors we hide it for a while; `now` (the API's server
  // time) advances on every poll, so the stream is retried after PREVIEW_RETRY_MS.
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const status = cameraStatus(cam, haveStats);
  const live = cam?.online ?? false;
  const showStream = live && (failedAt === null || now - failedAt > PREVIEW_RETRY_MS);

  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-medium">Entrance {name} · live preview</h2>
        <div className="flex items-center gap-3">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {live ? `${cam?.fps ?? 0} FPS · ${cam?.sessionEntries ?? 0} this session` : "—"}
          </p>
          <StatusPill label={status.label} tone={status.tone} />
        </div>
      </div>
      <div className="flex aspect-video items-center justify-center bg-zinc-100 dark:bg-zinc-950">
        {showStream ? (
          // Plain <img> is intentional: this is an MJPEG stream from the local worker.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${PREVIEW_BASE}/stream/${name}`}
            alt={`Live annotated preview of entrance ${name}`}
            className="size-full object-contain"
            onError={() => setFailedAt(now)}
          />
        ) : (
          <p className="px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            {live
              ? "Preview stream unreachable, retrying…"
              : `Preview unavailable. Start the Python worker (see README) to see camera ${name}.`}
          </p>
        )}
      </div>
    </section>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;

    async function poll() {
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch("/api/stats", { cache: "no-store", signal: controller.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          if (!cancelled) setError(body?.error ?? `The API returned HTTP ${res.status}.`);
          return;
        }
        const data: Stats = await res.json();
        if (!cancelled) {
          setStats(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
          setError("Cannot reach the API. Is the Next.js server running?");
        }
      }
    }

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, []);

  const cameraNames = [...new Set([...EXPECTED_CAMERAS, ...(stats?.cameras.map((c) => c.name) ?? [])])].sort();
  const byName = (name: string) => stats?.cameras.find((c) => c.name === name);
  const haveStats = stats !== null;
  const now = stats ? Date.parse(stats.serverTime) : 0;

  // Estimates from /api/stats; null when unavailable, so nothing is ever made up.
  const estToday = typeof stats?.estimatedTodayVisitors === "number" ? stats.estimatedTodayVisitors : null;
  const estTotal = typeof stats?.estimatedTotalVisitors === "number" ? stats.estimatedTotalVisitors : null;
  // Effective deduction across all of today's entries (not the latest window's rate).
  const todayDeduction = stats && estToday !== null ? stats.todayVisitors - estToday : null;
  const deductionPct =
    stats && todayDeduction !== null ? (stats.todayVisitors > 0 ? (todayDeduction / stats.todayVisitors) * 100 : 0) : null;

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 font-sans text-zinc-950 dark:bg-black dark:text-zinc-50 sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Entrance counter</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Live entries across all entrances · updates every 1.5 s
              {stats ? ` · ${stats.last5Minutes.toLocaleString()} in the last 5 minutes` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {haveStats && !stats.workerOnline && <StatusPill label="Worker offline" tone="bad" />}
            {error && <StatusPill label="API unreachable" tone="bad" />}
          </div>
        </header>

        {error && (
          <div role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900">
            {error}
          </div>
        )}

        <section aria-labelledby="actual-heading" className="flex flex-col gap-3">
          <h2 id="actual-heading" className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300">
            Actual counts <span className="font-normal normal-case tracking-normal text-zinc-500">· raw entries, unadjusted</span>
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Today's Visitors (actual)"
              value={stats ? stats.todayVisitors.toLocaleString() : "—"}
              hint={stats ? `${formatDay(stats.date)} (IST) · last entry ${formatTime(stats.lastEntryAt, stats.timezone)}` : undefined}
            />
            <StatCard
              title="Total Visitors (actual)"
              value={stats ? stats.totalVisitors.toLocaleString() : "—"}
              hint={
                stats?.event.startDate
                  ? `Since ${formatDay(stats.event.startDate)}${stats.event.endDate ? ` · until ${formatDay(stats.event.endDate)}` : ""}`
                  : "All recorded entries"
              }
            />
            {cameraNames.map((name) => (
              <StatCard
                key={name}
                title={`Entrance ${name} · today`}
                value={stats ? (byName(name)?.todayVisitors ?? 0).toLocaleString() : "—"}
                hint={
                  stats
                    ? `Total ${(byName(name)?.totalVisitors ?? 0).toLocaleString()} · ${(byName(name)?.last5Minutes ?? 0).toLocaleString()} in last 5 min`
                    : undefined
                }
              />
            ))}
          </div>
        </section>

        <section aria-labelledby="estimate-heading" className="flex flex-col gap-3">
          <h2 id="estimate-heading" className="text-sm font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
            Estimated counts{" "}
            <span className="font-normal normal-case tracking-normal text-zinc-500">
              · hourly-adjusted estimate, not verified unique visitors
            </span>
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard estimate title="Estimated Today's Visitors" value={estToday !== null ? estToday.toLocaleString() : "—"} />
            <StatCard estimate title="Estimated Total Visitors" value={estTotal !== null ? estTotal.toLocaleString() : "—"} />
            <StatCard
              estimate
              title="Today's deduction"
              value={todayDeduction !== null ? todayDeduction.toLocaleString() : "—"}
              hint="Actual today − estimated today"
            />
            <StatCard
              estimate
              title="Effective deduction %"
              value={deductionPct !== null ? `${deductionPct.toFixed(1)}%` : "—"}
              hint="Of all of today's entries (not the latest window's rate)"
            />
          </div>
        </section>

        <HourlyBreakdown date={stats?.date} />

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {cameraNames.map((name) => (
            <CameraPanel key={name} name={name} cam={byName(name)} haveStats={haveStats} now={now} />
          ))}
        </section>
      </div>
    </div>
  );
}
