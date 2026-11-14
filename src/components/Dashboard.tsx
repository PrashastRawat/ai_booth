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
  /** Actual + synthetic hourly projection (see README "Projected attendance"). Not camera-detected. */
  projectedTodayVisitors?: number;
  projectedTotalVisitors?: number;
  projection?: {
    active: boolean;
    activeSince: string | null;
    activeTodaySeconds: number;
    additionalToday: number;
    additionalTotal: number;
    perHour: number;
  };
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

// Displayed statistics refresh every 30 s. Ingestion of camera events is unaffected.
const POLL_MS = 30_000;
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

function StatCard({ title, value, hint, projected }: { title: string; value: string; hint?: string; projected?: boolean }) {
  return (
    <div
      className={`rounded-2xl p-5 shadow-sm ring-1 ${
        projected
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

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Start / stop the projection session (POST /api/projection), with a confirmation. */
function ProjectionControl({ active, onChanged }: { active: boolean | undefined; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(action: "start" | "stop") {
    const question =
      action === "start"
        ? "Start the projection session? Projected attendance will grow by 1,000 per active hour on top of actual counts."
        : "Stop the projection session? Projected visitors added so far are kept; no more are added.";
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `HTTP ${res.status}`);
      }
    } catch {
      setError("Cannot reach the API.");
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={busy || active === undefined}
        onClick={() => send(active ? "stop" : "start")}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium ring-1 disabled:opacity-50 ${
          active
            ? "text-rose-700 ring-rose-300 hover:bg-rose-50 dark:text-rose-300 dark:ring-rose-800 dark:hover:bg-rose-950"
            : "text-emerald-700 ring-emerald-300 hover:bg-emerald-50 dark:text-emerald-300 dark:ring-emerald-800 dark:hover:bg-emerald-950"
        }`}
      >
        {busy ? "Working…" : active ? "Stop projection" : "Start projection"}
      </button>
      {error && <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
    </div>
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
  // Bumped after a projection start/stop to refresh immediately instead of in up to 30 s.
  const [pollKey, setPollKey] = useState(0);

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
  }, [pollKey]);

  const cameraNames = [...new Set([...EXPECTED_CAMERAS, ...(stats?.cameras.map((c) => c.name) ?? [])])].sort();
  const byName = (name: string) => stats?.cameras.find((c) => c.name === name);
  const haveStats = stats !== null;
  const now = stats ? Date.parse(stats.serverTime) : 0;

  // Projection from /api/stats; null when unavailable, so nothing is ever made up.
  const projection = stats?.projection;
  const projToday = typeof stats?.projectedTodayVisitors === "number" ? stats.projectedTodayVisitors : null;
  const projTotal = typeof stats?.projectedTotalVisitors === "number" ? stats.projectedTotalVisitors : null;

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 font-sans text-zinc-950 dark:bg-black dark:text-zinc-50 sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Entrance counter</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Live entries across all entrances · display refreshes every 30 s
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

        <section aria-labelledby="projection-heading" className="flex flex-col gap-3">
          <h2 id="projection-heading" className="text-sm font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
            Projected attendance{" "}
            <span className="font-normal normal-case tracking-normal text-zinc-500">
              · actual counts + 1,000 synthetic visitors per active session hour; not camera-detected
            </span>
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              projected
              title="Projected Today's Visitors"
              value={projToday !== null ? projToday.toLocaleString() : "—"}
              hint="Shown on /rajasthan, labelled as projected"
            />
            <StatCard projected title="Projected Total Visitors" value={projTotal !== null ? projTotal.toLocaleString() : "—"} />
            <StatCard
              projected
              title="Additional projected visitors"
              value={projection ? projection.additionalToday.toLocaleString() : "—"}
              hint={projection ? `Today · ${projection.additionalTotal.toLocaleString()} in total` : undefined}
            />
            <div className="rounded-2xl bg-amber-50/60 p-5 shadow-sm ring-1 ring-amber-200 dark:bg-amber-950/20 dark:ring-amber-900/60">
              <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Projection session</p>
              <div className="mt-2 flex items-center gap-2">
                {projection ? (
                  <StatusPill label={projection.active ? "Active" : "Stopped"} tone={projection.active ? "good" : "warn"} />
                ) : (
                  <span className="text-2xl font-semibold">—</span>
                )}
              </div>
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                {projection
                  ? `${projection.active && projection.activeSince ? `Running since ${formatTime(projection.activeSince, stats?.timezone)} · ` : ""}${formatDuration(projection.activeTodaySeconds)} active today`
                  : "Status unavailable"}
              </p>
              <div className="mt-3">
                <ProjectionControl active={projection?.active} onChanged={() => setPollKey((k) => k + 1)} />
              </div>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {cameraNames.map((name) => (
            <CameraPanel key={name} name={name} cam={byName(name)} haveStats={haveStats} now={now} />
          ))}
        </section>
      </div>
    </div>
  );
}
