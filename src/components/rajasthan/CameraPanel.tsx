"use client";

import Image from "next/image";
import { useState } from "react";

// Same live preview source as the dashboard at "/": the Python worker serves an annotated
// MJPEG stream per camera on localhost at <base>/stream/<camera>.
const PREVIEW_BASE = process.env.NEXT_PUBLIC_PREVIEW_URL ?? "http://127.0.0.1:8765";
const PREVIEW_RETRY_MS = 10_000;

type Props = {
  name: string;
  /** Worker heartbeat for this camera is recent (from /api/stats). */
  online: boolean;
  /** Stats have loaded at least once; until then the frame stays empty instead of showing a fallback. */
  ready: boolean;
  /** Server time of the latest stats poll (ms); drives the retry after a stream error. */
  now: number;
};

export default function CameraPanel({ name, online, ready, now }: Props) {
  // After a stream error the <img> is hidden and retried once `now` has moved on by
  // PREVIEW_RETRY_MS, as on the original dashboard.
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const showStream = online && (failedAt === null || now - failedAt > PREVIEW_RETRY_MS);
  const titleId = `rj-camera-title-${name}`;

  return (
    <section className="rj-camera" aria-labelledby={titleId}>
      <div className="rj-camera-head">
        <Image className="rj-camera-icon" src="/rajasthan/camera-icon.svg" alt="" aria-hidden width={40} height={30} loading="eager" />
        <h2 id={titleId} className="rj-camera-title">
          Entrance {name}
        </h2>
      </div>
      <div className="rj-camera-frame" data-state={showStream ? "live" : "unavailable"}>
        {showStream ? (
          // Plain <img> is intentional: this is an MJPEG stream from the local worker.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="rj-camera-video"
            src={`${PREVIEW_BASE}/stream/${name}`}
            alt={`Live view of entrance ${name}`}
            onError={() => setFailedAt(now)}
          />
        ) : (
          ready && <p className="rj-camera-fallback">Camera feed unavailable</p>
        )}
      </div>
    </section>
  );
}
