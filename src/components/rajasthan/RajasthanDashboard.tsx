"use client";

import { useEffect, useState } from "react";
import RajasthanDecorations from "./RajasthanDecorations";
import RajasthanHeader from "./RajasthanHeader";
import VisitorCounterCard from "./VisitorCounterCard";
import "./RajasthanDashboard.css";

const POLL_MS = 1500;

type Counts = { today: number; total: number };

/**
 * Today's and total visitors from GET /api/stats (`todayVisitors`, `totalVisitors`),
 * refreshed every 1.5 s. The last good values stay on screen if a poll fails, so a
 * brief API hiccup never blanks or zeroes the counters.
 */
function useVisitorCounts(): Counts | null {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;

    async function poll() {
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch("/api/stats", { cache: "no-store", signal: controller.signal });
        if (!res.ok) return;
        const data: { todayVisitors?: unknown; totalVisitors?: unknown } = await res.json();
        const { todayVisitors: today, totalVisitors: total } = data;
        if (cancelled || typeof today !== "number" || typeof total !== "number") return;
        // Keep the same object when nothing changed so React skips the re-render.
        setCounts((prev) => (prev && prev.today === today && prev.total === total ? prev : { today, total }));
      } catch {
        // Network error or aborted poll: keep showing the last known counts.
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

  return counts;
}

export default function RajasthanDashboard({ fontClassName }: { fontClassName?: string }) {
  const counts = useVisitorCounts();

  return (
    <div className={`rj-root ${fontClassName ?? ""}`}>
      <RajasthanHeader />
      <RajasthanDecorations />
      <main className="rj-cards">
        <VisitorCounterCard id="today" label="Today’s Visitors" value={counts?.today ?? null} />
        <VisitorCounterCard id="total" label="Total Visitors" value={counts?.total ?? null} />
      </main>
    </div>
  );
}
