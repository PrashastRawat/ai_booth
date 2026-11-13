"use client";

import { useEffect, useState } from "react";
import CameraPanel from "./CameraPanel";
import RajasthanDecorations from "./RajasthanDecorations";
import RajasthanHeader from "./RajasthanHeader";
import VisitorCounterCard from "./VisitorCounterCard";
import "./RajasthanDashboard.css";

const POLL_MS = 1500;
const CAMERAS = ["A", "B"];

type Stats = {
  today: number;
  total: number;
  /** Server time of this poll (ms). */
  serverTime: number;
  /** Camera names whose worker heartbeat is recent. */
  online: string[];
};

/**
 * Today's and total visitors (`todayVisitors`, `totalVisitors`) and camera heartbeat state
 * (`cameras[].online`) from GET /api/stats, refreshed every 1.5 s. The last good values stay
 * on screen if a poll fails, so a brief API hiccup never blanks or zeroes the counters.
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
          serverTime?: unknown;
          cameras?: { name?: unknown; online?: unknown }[];
        } = await res.json();
        const { todayVisitors: today, totalVisitors: total } = data;
        if (cancelled || typeof today !== "number" || typeof total !== "number") return;
        const serverTime = typeof data.serverTime === "string" ? Date.parse(data.serverTime) : Date.now();
        const online = (Array.isArray(data.cameras) ? data.cameras : [])
          .filter((c) => c?.online === true && typeof c.name === "string")
          .map((c) => c.name as string);
        setStats({ today, total, serverTime, online });
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
          <VisitorCounterCard id="today" label="Today’s Visitors" value={stats?.today ?? null} />
          <VisitorCounterCard id="total" label="Total Visitors" value={stats?.total ?? null} />
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
