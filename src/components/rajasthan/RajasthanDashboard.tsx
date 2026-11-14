"use client";

import { useEffect, useState } from "react";
import CameraPanel from "./CameraPanel";
import RajasthanDecorations from "./RajasthanDecorations";
import RajasthanHeader from "./RajasthanHeader";
import VisitorCounterCard from "./VisitorCounterCard";
import "./RajasthanDashboard.css";

// Displayed figures refresh every 30 s; camera event ingestion is unaffected.
const POLL_MS = 30_000;
const CAMERAS = ["A", "B"];

type Stats = {
  today: number;
  total: number;
  /** True when today/total are the projected figures (actual + hourly projection). */
  projected: boolean;
  /** Server time of this poll (ms). */
  serverTime: number;
  /** Camera names whose worker heartbeat is recent. */
  online: string[];
};

/**
 * Projected attendance (`projectedTodayVisitors`, `projectedTotalVisitors`: actual camera
 * counts plus the synthetic hourly projection) and camera heartbeat state
 * (`cameras[].online`) from GET /api/stats, refreshed every 30 s. If the projected fields
 * are missing it falls back to the actual counts and says so (`projected: false`). The last
 * good values stay on screen if a poll fails.
 */
function useDashboardStats(): Stats | null {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;

    async function poll() {
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch("/api/stats", { cache: "no-store", signal: controller.signal });
        if (!res.ok) return;
        const data: {
          todayVisitors?: unknown;
          totalVisitors?: unknown;
          projectedTodayVisitors?: unknown;
          projectedTotalVisitors?: unknown;
          serverTime?: unknown;
          cameras?: { name?: unknown; online?: unknown }[];
        } = await res.json();
        const projected = typeof data.projectedTodayVisitors === "number" && typeof data.projectedTotalVisitors === "number";
        const today = projected ? data.projectedTodayVisitors : data.todayVisitors;
        const total = projected ? data.projectedTotalVisitors : data.totalVisitors;
        if (cancelled || typeof today !== "number" || typeof total !== "number") return;
        const serverTime = typeof data.serverTime === "string" ? Date.parse(data.serverTime) : Date.now();
        const online = (Array.isArray(data.cameras) ? data.cameras : [])
          .filter((c) => c?.online === true && typeof c.name === "string")
          .map((c) => c.name as string);
        setStats({ today, total, projected, serverTime, online });
      } catch {
        // Network error or aborted poll: keep showing the last known values.
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

  return stats;
}

export default function RajasthanDashboard({ fontClassName }: { fontClassName?: string }) {
  const stats = useDashboardStats();

  return (
    <div className={`rj-root ${fontClassName ?? ""}`}>
      <RajasthanHeader />
      <RajasthanDecorations />
      {/* Two-column grid: counters on the first row, the two entrance cameras on the second. */}
      <main className="rj-main">
        <div className="rj-counters">
          {/* Synthetic projection is never shown without saying so. */}
          <VisitorCounterCard id="today" label="Today’s Visitors" value={stats?.today ?? null} caption={stats?.projected ? "Projected attendance" : undefined} />
          <VisitorCounterCard id="total" label="Total Visitors" value={stats?.total ?? null} caption={stats?.projected ? "Projected attendance" : undefined} />
        </div>
        {CAMERAS.map((name) => (
          <CameraPanel
            key={name}
            name={name}
            online={stats?.online.includes(name) ?? false}
            ready={stats !== null}
            now={stats?.serverTime ?? 0}
          />
        ))}
      </main>
    </div>
  );
}
