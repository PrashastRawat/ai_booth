"""Webcam diagnostic: enumerates camera indices on DirectShow and MSMF, grabs real
frames, reports resolution / frame rate / brightness, and saves one snapshot per
working camera to worker/diagnostics/.

Run:  python camera_diag.py            (stop entry_counter.py first)
"""
import os, sys, time, cv2

os.environ.setdefault("OPENCV_LOG_LEVEL", "OFF")  # silence per-frame driver warnings
try:
    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_SILENT)
except AttributeError:
    pass

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "diagnostics")
os.makedirs(OUT, exist_ok=True)
BACKENDS = [("DSHOW", cv2.CAP_DSHOW), ("MSMF", cv2.CAP_MSMF)]
RESOLUTIONS = [(640, 480), (1280, 720), (1920, 1080)]
BLACK_THRESHOLD = 8.0   # mean pixel value below this = effectively black


def grab(cap, seconds=3.0):
    t0 = time.time(); frames = []; fails = 0
    while time.time() - t0 < seconds:
        ok, f = cap.read()
        if ok and f is not None: frames.append(f)
        else:
            fails += 1
            if fails >= 200: break          # stalled backend: stop early
    return frames, fails


def test(index, name, api):
    cap = cv2.VideoCapture(index, api)
    if not cap.isOpened():
        cap.release(); return None
    rows = []; best = None
    for w, h in RESOLUTIONS:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, w); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
        grab(cap, 1.0)                                  # warm-up / auto-exposure
        frames, fails = grab(cap, 3.0)
        if not frames:
            rows.append(f"    {w}x{h}: NO FRAMES ({fails} failed reads)"); continue
        last = frames[-1]; ah, aw = last.shape[:2]
        mean = float(last.mean()); std = float(last.std())
        fps = len(frames) / 3.0
        black = mean < BLACK_THRESHOLD and std < 3.0
        rows.append(f"    requested {w}x{h} -> got {aw}x{ah}  {fps:.1f} FPS  "
                    f"brightness={mean:.1f} contrast={std:.1f}  {'BLACK' if black else 'OK image'}")
        if best is None or (not black and best[1]): best = (last, black, aw, ah)
    cap.release()
    if best is not None:
        path = os.path.join(OUT, f"cam{index}_{name}_{best[2]}x{best[3]}.jpg")
        cv2.imwrite(path, best[0]); rows.append(f"    snapshot: {path}")
    return rows


def main():
    found = False
    for index in range(5):
        for name, api in BACKENDS:
            try:
                rows = test(index, name, api)
            except cv2.error as exc:
                print(f"index {index} [{name}]: OpenCV error while reading ({str(exc).splitlines()[-1][:90]})"); continue
            if rows is None:
                print(f"index {index} [{name}]: cannot open"); continue
            found = True
            print(f"index {index} [{name}]: OPENED"); print("\n".join(rows))
    if not found:
        print("No camera could be opened on any index/backend.")


if __name__ == "__main__":
    main()
