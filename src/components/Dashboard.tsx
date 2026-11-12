"use client";

import { useEffect, useState } from "react";

type Stats = {
  total: number;
  last5Minutes: number;
  lastEntryAt: string | null;
  serverTime: string;
  worker: {
    online: boolean;
    cameraConnected: boolean;
    feedAvailable: boolean;
    fps: number;
    sessionEntries: number;
    lastSeenAt: string | null;
  };
};

const POLL_MS = 1500;
// The worker serves its annotated preview on localhost only.
const PREVIEW_URL =
  process.env.NEXT_PUBLIC_PREVIEW_URL ?? "http://127.0.0.1:8765/stream";

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

function StatCard({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{title}</p>
      <p className="mt-2 text-4xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50 sm:text-5xl">{value}</p>
      {hint && <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;

    async function poll() {
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch("/api/stats", { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Stats = await res.json();
        if (!cancelled) {
          setStats(data);
          setError(null);
          // Retry the preview whenever the worker is (back) online.
          if (data.worker.online) setPreviewFailed(false);
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

  const cameraTone = !stats ? "warn" : stats.worker.feedAvailable ? "good" : "bad";
  const cameraLabel = !stats
    ? "Connecting…"
    : !stats.worker.online
      ? "Worker offline"
      : !stats.worker.cameraConnected
        ? "Camera disconnected"
        : stats.worker.feedAvailable
          ? "Camera connected"
          : "Camera feed unavailable";

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 font-sans text-zinc-950 dark:bg-black dark:text-zinc-50 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Entrance counter</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Live people entering through the virtual line · updates every 1.5 s
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill label={cameraLabel} tone={cameraTone} />
            {error && <StatusPill label="API unreachable" tone="bad" />}
          </div>
        </header>

        {error && (
          <div role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900">
            {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <StatCard title="Total people entered" value={stats ? stats.total.toLocaleString() : "—"} hint={`Last entry: ${formatTime(stats?.lastEntryAt ?? null)}`} />
          <StatCard title="Entered in the last 5 minutes" value={stats ? stats.last5Minutes.toLocaleString() : "—"} />
        </section>

        <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h2 className="text-sm font-medium">Live camera preview</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {stats?.worker.online ? `${stats.worker.fps} FPS · ${stats.worker.sessionEntries} counted this session` : "Worker not running"}
            </p>
          </div>
          <div className="flex aspect-video items-center justify-center bg-zinc-100 dark:bg-zinc-950">
            {previewFailed ? (
              <p className="px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                Preview unavailable. Start the Python worker (see README) to see the live camera feed.
              </p>
            ) : (
              // Plain <img> is intentional: this is an MJPEG stream from the local worker.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={PREVIEW_URL}
                alt="Live annotated camera preview"
                className="size-full object-contain"
                onError={() => setPreviewFailed(true)}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
