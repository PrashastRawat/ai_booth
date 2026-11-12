"""People entrance counter worker.

Pipeline: webcam (OpenCV) -> YOLO nano person detection -> ByteTrack tracking
-> virtual counting line (entry direction only) -> POST each entry to the
Next.js API. Also serves a local annotated MJPEG preview for the dashboard.

Run from the worker folder:
    python entry_counter.py                 # uses config.json
    python entry_counter.py --source 1      # override camera index
    python entry_counter.py --show-window   # also open a local OpenCV window

No raw video is written to disk and no face recognition is performed.
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
from typing import Optional

import cv2
from ultralytics import YOLO

from line_counter import LineCounter

WORKER_DIR = Path(__file__).resolve().parent
CONFIG_PATH = WORKER_DIR / "config.json"
PERSON_CLASS_ID = 0  # COCO class 0 = person

DEFAULTS = {
    "camera_index": 0,
    "camera_width": 1280,
    "camera_height": 720,
    "model": "yolo11n.pt",
    "confidence": 0.4,
    "imgsz": 640,
    "tracker": "bytetrack.yaml",
    "line": [0.1, 0.6, 0.9, 0.6],
    "entry_side": "positive",
    "line_margin_px": 8,
    "min_track_frames": 3,
    "api_url": "http://localhost:3000/api",
    "preview_port": 8765,
    "preview_fps": 10,
    "preview_jpeg_quality": 70,
    "heartbeat_seconds": 1.0,
    "black_frame_threshold": 8.0,
    "stalled_read_seconds": 1.5,
}

log = logging.getLogger("entry_counter")


def load_config(path: Path) -> dict:
    cfg = dict(DEFAULTS)
    if path.exists():
        cfg.update(json.loads(path.read_text(encoding="utf-8")))
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
class WorkerState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.camera_connected = False
        self.feed_available = False   # False while frames are black or stalled
        self.fps = 0.0
        self.session_entries = 0
        self.latest_jpeg: Optional[bytes] = None


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

    def post_json(self, path: str, payload: dict) -> int:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
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


def heartbeat_loop(api: ApiClient, state: WorkerState, interval: float) -> None:
    while True:
        with state.lock:
            payload = {
                "cameraConnected": state.camera_connected,
                "feedAvailable": state.feed_available,
                "fps": round(state.fps, 1),
                "sessionEntries": state.session_entries,
            }
        try:
            api.post_json("/heartbeat", payload)
        except (urllib.error.URLError, OSError, TimeoutError):
            pass  # dashboard will show the worker as offline
        time.sleep(interval)


# --------------------------------------------------------------------------- preview server
def start_preview_server(state: WorkerState, port: int, fps: float) -> None:
    frame_delay = 1.0 / max(fps, 1.0)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):  # keep the console quiet
            return

        def do_GET(self):  # noqa: N802
            if self.path.startswith("/snapshot"):
                with state.lock:
                    jpg = state.latest_jpeg
                if jpg is None:
                    self.send_error(503, "No frame yet")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(jpg)
                return

            if self.path.startswith("/stream"):
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
                                + f"Content-Length: {len(jpg)}\r\n\r\n".encode()
                                + jpg
                                + b"\r\n"
                            )
                        time.sleep(frame_delay)
                except (BrokenPipeError, ConnectionResetError):
                    return  # viewer closed the page
                return

            self.send_error(404)

    # Bound to localhost only: the preview is for the dashboard on this computer.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, name="preview-server", daemon=True).start()
    log.info("Preview available at http://127.0.0.1:%s/stream", port)


# --------------------------------------------------------------------------- camera
def open_camera(source, width: int, height: int):
    if isinstance(source, int) and os.name == "nt":
        cap = cv2.VideoCapture(source, cv2.CAP_DSHOW)  # faster open on Windows
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


def build_counter(cfg: dict, frame_w: int, frame_h: int) -> LineCounter:
    x1, y1, x2, y2 = cfg["line"]
    return LineCounter(
        (x1 * frame_w, y1 * frame_h),
        (x2 * frame_w, y2 * frame_h),
        entry_side=cfg["entry_side"],
        margin_px=cfg["line_margin_px"],
        min_track_frames=cfg["min_track_frames"],
    )


def annotate(frame, counter: LineCounter, boxes, ids, session_entries: int, fps: float):
    p1 = tuple(int(v) for v in counter.p1)
    p2 = tuple(int(v) for v in counter.p2)
    cv2.line(frame, p1, p2, (0, 255, 255), 2)
    (mx, my), (ax, ay) = counter.label_anchor(offset_px=60)
    cv2.arrowedLine(frame, (int(mx), int(my)), (int(ax), int(ay)), (0, 255, 0), 2, tipLength=0.3)
    cv2.putText(frame, "ENTRY", (int(ax) + 6, int(ay)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

    for (x1, y1, x2, y2), tid in zip(boxes, ids):
        color = (255, 200, 0) if counter.has_counted(tid) else (200, 200, 200)
        cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
        cv2.circle(frame, (int((x1 + x2) / 2), int(y2)), 4, (0, 0, 255), -1)
        cv2.putText(frame, f"ID {tid}", (int(x1), int(y1) - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

    cv2.putText(
        frame,
        f"Session entries: {session_entries}   FPS: {fps:.1f}",
        (12, 30),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (255, 255, 255),
        2,
    )
    return frame


# --------------------------------------------------------------------------- main loop
def run(cfg: dict, source, show_window: bool) -> None:
    api = ApiClient(cfg["api_url"])
    state = WorkerState()
    threading.Thread(
        target=heartbeat_loop, args=(api, state, float(cfg["heartbeat_seconds"])), name="heartbeat", daemon=True
    ).start()
    start_preview_server(state, int(cfg["preview_port"]), float(cfg["preview_fps"]))

    log.info("Loading model %s", cfg["model"])
    model = YOLO(cfg["model"])
    is_file = isinstance(source, str)

    cap = None
    counter: Optional[LineCounter] = None
    last_open_attempt = 0.0
    frame_index = 0
    fps_ema = 0.0
    quality = int(cfg["preview_jpeg_quality"])

    try:
        while True:
            if cap is None:
                now = time.monotonic()
                if now - last_open_attempt >= 2.0:
                    last_open_attempt = now
                    cap = open_camera(source, int(cfg["camera_width"]), int(cfg["camera_height"]))
                    if cap is None:
                        log.warning("Camera %s not available; retrying", source)
                        with state.lock:
                            state.camera_connected = False
                            state.feed_available = False
                        time.sleep(0.5)
                        continue
                    log.info("Camera %s opened", source)
                    with state.lock:
                        state.camera_connected = True
                else:
                    time.sleep(0.1)
                    continue

            read_started = time.perf_counter()
            ok, frame = cap.read()
            read_seconds = time.perf_counter() - read_started
            if not ok:
                if is_file:
                    log.info("End of video file reached")
                    break
                log.warning("Camera read failed; reconnecting")
                cap.release()
                cap = None
                with state.lock:
                    state.camera_connected = False
                    state.feed_available = False
                continue

            frame_h, frame_w = frame.shape[:2]
            if counter is None:
                counter = build_counter(cfg, frame_w, frame_h)

            problem = frame_problem(frame, read_seconds, cfg)
            with state.lock:
                was_available = state.feed_available
                state.feed_available = problem is None
            if problem is not None:
                # Invalid frame: no detection, no counting. Show the reason on the preview.
                if was_available or frame_index == 0:
                    log.warning("Camera feed unavailable: %s", problem)
                banner = frame.copy()
                cv2.putText(banner, "CAMERA FEED UNAVAILABLE", (12, 70), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 3)
                cv2.putText(banner, problem, (12, 105), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                ok_jpg, buf = cv2.imencode(".jpg", banner, [cv2.IMWRITE_JPEG_QUALITY, quality])
                if ok_jpg:
                    with state.lock:
                        state.latest_jpeg = buf.tobytes()
                frame_index += 1
                time.sleep(0.2)
                continue
            if not was_available:
                log.info("Camera feed restored")

            started = time.perf_counter()
            results = model.track(
                frame,
                persist=True,
                tracker=cfg["tracker"],
                classes=[PERSON_CLASS_ID],
                conf=float(cfg["confidence"]),
                imgsz=int(cfg["imgsz"]),
                verbose=False,
            )
            boxes = results[0].boxes
            xyxy = boxes.xyxy.tolist() if boxes is not None and len(boxes) else []
            ids = boxes.id.int().tolist() if boxes is not None and boxes.id is not None else []

            for (x1, _y1, x2, y2), tid in zip(xyxy, ids):
                foot = ((x1 + x2) / 2, y2)  # bottom-centre of the box = where the person stands
                if counter.update(tid, foot, frame_index):
                    event = {"id": str(uuid.uuid4()), "occurredAt": utc_now_iso(), "trackId": tid}
                    api.send_entry(event)
                    with state.lock:
                        state.session_entries += 1
                    log.info("ENTRY counted (track %s, total this session %s)", tid, state.session_entries)

            elapsed = time.perf_counter() - started
            fps_ema = 0.9 * fps_ema + 0.1 * (1.0 / elapsed) if elapsed > 0 else fps_ema

            with state.lock:
                session_entries = state.session_entries
                state.fps = fps_ema

            annotated = annotate(frame.copy(), counter, xyxy, ids, session_entries, fps_ema)
            ok_jpg, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, quality])
            if ok_jpg:
                with state.lock:
                    state.latest_jpeg = buf.tobytes()

            if show_window:
                cv2.imshow("entry_counter", annotated)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            frame_index += 1
    except KeyboardInterrupt:
        log.info("Stopping")
    finally:
        if cap is not None:
            cap.release()
        if show_window:
            cv2.destroyAllWindows()
        # Give the sender thread a brief moment to deliver anything still queued.
        for _ in range(30):
            if api._queue.empty():
                break
            time.sleep(0.1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Entrance people counter worker")
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument("--source", help="Override camera index (e.g. 1) or a video file path")
    parser.add_argument("--api-url", help="Override API base URL")
    parser.add_argument("--show-window", action="store_true", help="Show a local OpenCV preview window")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(args.config)
    if args.api_url:
        cfg["api_url"] = args.api_url
    source = parse_source(args.source if args.source is not None else cfg["camera_index"])
    run(cfg, source, args.show_window)


if __name__ == "__main__":
    main()
