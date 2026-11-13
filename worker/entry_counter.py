"""Multi-camera entrance counter worker.

Per camera (own thread): webcam (OpenCV) -> YOLO nano person detection ->
ByteTrack -> virtual counting line (entry direction only, centre of the
person box as the crossing point) -> POST each entry to the Next.js API. One local MJPEG preview server exposes
/stream/<camera> and /snapshot/<camera> for the dashboard.

    python entry_counter.py                      # all cameras in config.json
    python entry_counter.py --only A             # just one camera
    python entry_counter.py --source A=video.mp4 # replace camera A's input with a file (testing)
    python entry_counter.py --show-window        # also open local OpenCV windows

No video is recorded, no images or biometric data are stored, no identities
are recognised.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Optional

import cv2
import numpy as np

from line_counter import LineCounter, box_centre
from person_tracker import PersonTracker

WORKER_DIR = Path(__file__).resolve().parent
CONFIG_PATH = WORKER_DIR / "config.json"

GLOBAL_DEFAULTS = {
    "api_url": "http://localhost:3000/api",
    "preview_port": 8765,
    "preview_fps": 10,
    "preview_jpeg_quality": 70,
    "heartbeat_seconds": 1.0,
    "model": "yolo11n.pt",
    "tracker": "bytetrack_event.yaml",
    "black_frame_threshold": 8.0,
    "stalled_read_seconds": 1.5,
}
CAMERA_DEFAULTS = {
    "capture_width": 1280,
    "capture_height": 720,
    "inference_size": 480,
    "confidence": 0.4,
    "line": [0.1, 0.6, 0.9, 0.6],
    "entry_side": "positive",
    "line_margin_px": 8,
    "min_track_frames": 3,
    "min_outside_frames": 2,
    "roi": None,
}

log = logging.getLogger("entry_counter")


def load_config(path: Path) -> dict:
    cfg = dict(GLOBAL_DEFAULTS)
    cfg.update(json.loads(path.read_text(encoding="utf-8")))
    if not cfg.get("cameras"):
        raise SystemExit("config.json must define at least one camera in 'cameras'")
    cfg["cameras"] = [{**CAMERA_DEFAULTS, **c} for c in cfg["cameras"]]
    names = [c["name"] for c in cfg["cameras"]]
    if len(set(names)) != len(names):
        raise SystemExit("camera names must be unique")
    return cfg


def parse_source(value):
    """Camera index as int, or a video file path (used for testing without a webcam)."""
    if isinstance(value, int):
        return value
    text = str(value).strip()
    return int(text) if text.isdigit() else text


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# --------------------------------------------------------------------------- shared state
class CameraState:
    def __init__(self, name: str) -> None:
        self.name = name
        self.lock = threading.Lock()
        self.connected = False
        self.feed_available = False   # False while frames are black or stalled
        self.fps = 0.0
        self.session_entries = 0
        self.latest_jpeg: Optional[bytes] = None

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "connected": self.connected,
                "feedAvailable": self.feed_available,
                "fps": round(self.fps, 1),
                "sessionEntries": self.session_entries,
            }


# --------------------------------------------------------------------------- API client
class ApiClient:
    """Sends entry events from a background thread, retrying until the API accepts them.

    Event IDs are generated once per crossing, so a retry after a timeout cannot
    create a duplicate row (the API uses INSERT OR IGNORE on the ID).
    """

    def __init__(self, base_url: str, timeout: float = 3.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._queue: "queue.Queue[dict]" = queue.Queue()
        threading.Thread(target=self._run, name="event-sender", daemon=True).start()

    def send_entry(self, event: dict) -> None:
        self._queue.put(event)

    def pending(self) -> int:
        return self._queue.qsize()

    def post_json(self, path: str, payload: dict) -> int:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}", data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return resp.status

    def _run(self) -> None:
        while True:
            event = self._queue.get()
            attempt = 0
            while True:
                try:
                    self.post_json("/events", event)
                    break
                except urllib.error.HTTPError as exc:
                    if 400 <= exc.code < 500 and exc.code != 429:
                        log.error("API rejected event %s (HTTP %s); dropping it", event["id"], exc.code)
                        break
                except (urllib.error.URLError, OSError, TimeoutError):
                    pass  # API not reachable yet; retry below
                attempt += 1
                delay = min(2 ** attempt, 10)
                log.warning("API unreachable, retrying event %s in %ss", event["id"], delay)
                time.sleep(delay)


def heartbeat_loop(api: ApiClient, states: Dict[str, CameraState], interval: float) -> None:
    while True:
        payload = {"cameras": {name: st.snapshot() for name, st in states.items()}}
        try:
            api.post_json("/heartbeat", payload)
        except (urllib.error.URLError, OSError, TimeoutError):
            pass  # dashboard will show the worker as offline
        time.sleep(interval)


# --------------------------------------------------------------------------- preview server
def start_preview_server(states: Dict[str, CameraState], port: int, fps: float) -> None:
    frame_delay = 1.0 / max(fps, 1.0)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):  # keep the console quiet
            return

        def _state(self, prefix: str) -> Optional[CameraState]:
            name = self.path[len(prefix):].split("?")[0].strip("/")
            return states.get(name)

        def do_GET(self):  # noqa: N802
            if self.path.startswith("/snapshot/"):
                state = self._state("/snapshot/")
                if state is None:
                    self.send_error(404, "Unknown camera"); return
                with state.lock:
                    jpg = state.latest_jpeg
                if jpg is None:
                    self.send_error(503, "No frame yet"); return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(jpg)
                return

            if self.path.startswith("/stream/"):
                state = self._state("/stream/")
                if state is None:
                    self.send_error(404, "Unknown camera"); return
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    while True:
                        with state.lock:
                            jpg = state.latest_jpeg
                        if jpg is not None:
                            self.wfile.write(
                                b"--frame\r\nContent-Type: image/jpeg\r\n"
                                + f"Content-Length: {len(jpg)}\r\n\r\n".encode() + jpg + b"\r\n"
                            )
                        time.sleep(frame_delay)
                except (BrokenPipeError, ConnectionResetError):
                    return  # viewer closed the page
                return

            self.send_error(404)

    # Bound to localhost only: the preview is for the dashboard on this computer.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, name="preview-server", daemon=True).start()
    log.info("Preview: http://127.0.0.1:%s/stream/<camera>  cameras=%s", port, list(states))


# --------------------------------------------------------------------------- camera helpers
def open_camera(source, width: int, height: int):
    if isinstance(source, int) and os.name == "nt":
        cap = cv2.VideoCapture(source, cv2.CAP_DSHOW)  # DirectShow works best for UVC webcams on Windows
    else:
        cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        cap.release()
        return None
    if isinstance(source, int):
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # always work on the freshest frame
    return cap


def frame_problem(frame, read_seconds: float, cfg: dict) -> Optional[str]:
    """Return a reason string if the frame is unusable, else None.

    A camera that is covered, disabled or wedged in the driver often still
    returns "successful" reads that are all black or arrive at ~1 FPS.
    """
    if read_seconds > float(cfg["stalled_read_seconds"]):
        return f"stalled ({read_seconds:.1f}s per frame)"
    mean = float(frame.mean())
    if mean < float(cfg["black_frame_threshold"]) and float(frame.std()) < 3.0:
        return f"black frame (brightness {mean:.1f})"
    return None


def build_counter(cam: dict, frame_w: int, frame_h: int) -> LineCounter:
    x1, y1, x2, y2 = cam["line"]
    return LineCounter(
        (x1 * frame_w, y1 * frame_h), (x2 * frame_w, y2 * frame_h),
        entry_side=cam["entry_side"], margin_px=cam["line_margin_px"],
        min_track_frames=cam["min_track_frames"], min_outside_frames=cam["min_outside_frames"],
    )


def build_roi(cam: dict, frame_w: int, frame_h: int):
    """Optional polygon (fractions of the frame) that a crossing point must be inside to count."""
    roi = cam.get("roi")
    if not roi:
        return None
    if len(roi) < 3:
        raise SystemExit(f"camera {cam['name']}: roi needs at least 3 points")
    return np.array([[int(x * frame_w), int(y * frame_h)] for x, y in roi], dtype=np.int32)


def in_roi(roi, point) -> bool:
    return roi is None or cv2.pointPolygonTest(roi, (float(point[0]), float(point[1])), False) >= 0


def annotate(frame, name: str, counter: LineCounter, roi, tracks, session_entries: int, fps: float):
    if roi is not None:
        cv2.polylines(frame, [roi], isClosed=True, color=(255, 128, 0), thickness=2)
    p1 = tuple(int(v) for v in counter.p1)
    p2 = tuple(int(v) for v in counter.p2)
    cv2.line(frame, p1, p2, (0, 255, 255), 2)
    (mx, my), (ax, ay) = counter.label_anchor(offset_px=60)
    cv2.arrowedLine(frame, (int(mx), int(my)), (int(ax), int(ay)), (0, 255, 0), 2, tipLength=0.3)
    cv2.putText(frame, "ENTRY", (int(ax) + 6, int(ay)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

    for x1, y1, x2, y2, tid in tracks:
        cx, cy = box_centre(x1, y1, x2, y2)
        centre = (int(cx), int(cy))
        counted = counter.has_counted(tid)
        color = (255, 200, 0) if counted else ((200, 200, 200) if in_roi(roi, centre) else (90, 90, 90))
        cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
        cv2.circle(frame, centre, 5, (0, 0, 255), -1)  # body centre = crossing point
        cv2.putText(frame, f"ID {tid}", (int(x1), int(y1) - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

    cv2.putText(frame, f"Camera {name}   entries: {session_entries}   FPS: {fps:.1f}", (12, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    return frame


# --------------------------------------------------------------------------- per-camera worker
class CameraWorker(threading.Thread):
    def __init__(self, cam: dict, cfg: dict, source, api: ApiClient, state: CameraState, show_window: bool) -> None:
        super().__init__(name=f"camera-{cam['name']}", daemon=True)
        self.cam, self.cfg, self.source, self.api, self.state, self.show_window = cam, cfg, source, api, state, show_window
        self.finished = threading.Event()   # set when a video file ends

    def _publish(self, frame) -> None:
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, int(self.cfg["preview_jpeg_quality"])])
        if ok:
            with self.state.lock:
                self.state.latest_jpeg = buf.tobytes()

    def _set_health(self, connected: bool, feed: bool) -> None:
        with self.state.lock:
            self.state.connected, self.state.feed_available = connected, feed

    def run(self) -> None:
        name, cam, cfg, state = self.cam["name"], self.cam, self.cfg, self.state
        tracker = PersonTracker(str(WORKER_DIR / cfg["model"]), str(WORKER_DIR / cfg["tracker"]),
                                cam["confidence"], cam["inference_size"])
        is_file = isinstance(self.source, str)
        cap = None
        counter: Optional[LineCounter] = None
        roi = None
        last_open_attempt = 0.0
        frame_index = 0
        fps_ema = 0.0
        window = f"camera {name}"

        try:
            while True:
                if cap is None:
                    now = time.monotonic()
                    if now - last_open_attempt < 2.0:
                        time.sleep(0.1); continue
                    last_open_attempt = now
                    cap = open_camera(self.source, int(cam["capture_width"]), int(cam["capture_height"]))
                    if cap is None:
                        log.warning("[%s] camera %s not available; retrying", name, self.source)
                        self._set_health(False, False)
                        continue
                    log.info("[%s] camera %s opened (%dx%d)", name, self.source,
                             cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                    self._set_health(True, False)

                read_started = time.perf_counter()
                ok, frame = cap.read()
                read_seconds = time.perf_counter() - read_started
                # Entry timestamp = when this frame arrived (UTC, explicit offset), not when
                # inference finished. The API attributes it to an IST day from this value.
                captured_at = utc_now_iso()
                if not ok:
                    if is_file:
                        log.info("[%s] end of video file reached", name); break
                    log.warning("[%s] camera read failed; reconnecting", name)
                    cap.release(); cap = None
                    self._set_health(False, False)
                    continue

                frame_h, frame_w = frame.shape[:2]
                if counter is None:
                    counter = build_counter(cam, frame_w, frame_h)
                    roi = build_roi(cam, frame_w, frame_h)

                problem = frame_problem(frame, read_seconds, cfg)
                with state.lock:
                    was_available = state.feed_available
                    state.feed_available = problem is None
                if problem is not None:
                    # Invalid frame: no detection, no counting. Show the reason on the preview.
                    if was_available or frame_index == 0:
                        log.warning("[%s] camera feed unavailable: %s", name, problem)
                    banner = frame.copy()
                    cv2.putText(banner, f"CAMERA {name}: FEED UNAVAILABLE", (12, 70), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 3)
                    cv2.putText(banner, problem, (12, 105), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                    self._publish(banner)
                    frame_index += 1
                    time.sleep(0.2)
                    continue
                if not was_available:
                    log.info("[%s] camera feed restored", name)

                started = time.perf_counter()
                tracks = tracker.update(frame)
                for x1, y1, x2, y2, tid in tracks:
                    centre = box_centre(x1, y1, x2, y2)   # body centre = crossing point
                    if not in_roi(roi, centre):
                        continue                         # unrelated foot traffic outside the entrance area
                    if counter.update(tid, centre, frame_index):
                        self.api.send_entry({"id": str(uuid.uuid4()), "occurredAt": captured_at, "camera": name, "trackId": tid})
                        with state.lock:
                            state.session_entries += 1
                            total = state.session_entries
                        log.info("[%s] ENTRY counted (track %s, total this session %s)", name, tid, total)

                elapsed = time.perf_counter() - started
                fps_ema = 0.9 * fps_ema + 0.1 * (1.0 / elapsed) if elapsed > 0 else fps_ema
                with state.lock:
                    state.fps = fps_ema
                    session_entries = state.session_entries

                annotated = annotate(frame.copy(), name, counter, roi, tracks, session_entries, fps_ema)
                self._publish(annotated)
                if self.show_window:
                    cv2.imshow(window, annotated)
                    cv2.waitKey(1)
                frame_index += 1
        finally:
            if cap is not None:
                cap.release()
            self._set_health(False, False)
            self.finished.set()


# --------------------------------------------------------------------------- main
def main() -> None:
    parser = argparse.ArgumentParser(description="Multi-camera entrance people counter worker")
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument("--only", help="Run only the named camera (e.g. A)")
    parser.add_argument("--source", action="append", default=[], metavar="NAME=INDEX_OR_FILE",
                        help="Override a camera's input, e.g. A=1 or A=clip.mp4 (repeatable)")
    parser.add_argument("--api-url", help="Override API base URL")
    parser.add_argument("--show-window", action="store_true", help="Show local OpenCV preview windows")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(args.config)
    if args.api_url:
        cfg["api_url"] = args.api_url
    overrides = dict(s.split("=", 1) for s in args.source)
    cameras = [c for c in cfg["cameras"] if not args.only or c["name"] == args.only]
    if not cameras:
        raise SystemExit(f"no camera named {args.only!r} in config")

    api = ApiClient(cfg["api_url"])
    states = {c["name"]: CameraState(c["name"]) for c in cameras}
    start_preview_server(states, int(cfg["preview_port"]), float(cfg["preview_fps"]))
    threading.Thread(target=heartbeat_loop, args=(api, states, float(cfg["heartbeat_seconds"])),
                     name="heartbeat", daemon=True).start()

    workers = [
        CameraWorker(c, cfg, parse_source(overrides.get(c["name"], c["index"])), api, states[c["name"]], args.show_window)
        for c in cameras
    ]
    for w in workers:
        w.start()
    try:
        while not all(w.finished.is_set() for w in workers):
            time.sleep(0.5)
        log.info("All inputs finished")
    except KeyboardInterrupt:
        log.info("Stopping")
    finally:
        for _ in range(30):                      # let queued events drain
            if api.pending() == 0:
                break
            time.sleep(0.1)
        if args.show_window:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
