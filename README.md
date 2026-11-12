# Entrance counter

Counts people entering an event through a single USB webcam. A Python worker
detects people (YOLO11 nano), tracks them (ByteTrack) and counts each one once
when they cross a virtual line in the entry direction. Each entry is sent to
the Next.js app, stored in SQLite, and shown on a live dashboard.

```
webcam -> worker/entry_counter.py --POST--> Next.js /api/events --> data/entries.db
                 |                                   ^
                 +-- MJPEG preview :8765 <-- browser dashboard -- GET /api/stats
```

No cloud services, auth, Docker or Redis. No video is recorded and no faces are
identified; the database only stores an event ID, a timestamp and a tracker ID.

## Requirements

- Windows, Node.js 22+ (uses the built-in `node:sqlite`), Python 3.10+
- A USB webcam

## One-time setup (PowerShell, from the project folder)

```powershell
npm install

cd worker
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..
```

The YOLO weights (`yolo11n.pt`, ~5 MB) download automatically the first time the
worker runs.

## Running (two terminals)

**Terminal 1 – Next.js app**

```powershell
npm run build
npm run start
```

Dashboard: http://localhost:3000

(`npm run dev` also works during development, but `build` + `start` is faster.)

**Terminal 2 – Python worker**

```powershell
cd worker
.\.venv\Scripts\Activate.ps1
python entry_counter.py
```

Add `--show-window` to also open a local OpenCV window (press `q` to quit).
Press `Ctrl+C` to stop the worker.

## Configuration – `worker/config.json`

| Key | Meaning |
|---|---|
| `camera_index` | Webcam index (`0` is usually the first USB camera). Override once with `--source 1`. |
| `camera_width`, `camera_height` | Requested capture size. |
| `confidence` | Minimum detection confidence (0–1). Raise to reduce false detections. |
| `imgsz` | Inference input size. Smaller is faster, larger detects smaller/further people. 480 is a good CPU default. |
| `line` | Counting line as `[x1, y1, x2, y2]`, each a fraction of the frame (0–1). `[0.1, 0.6, 0.9, 0.6]` is a horizontal line at 60 % of the height. |
| `entry_side` | `"positive"` or `"negative"`. Flip this if the green **ENTRY** arrow on the preview points the wrong way. |
| `line_margin_px` | Dead zone around the line so someone standing on it does not flicker across. |
| `min_track_frames` | A track must be seen this many frames before it can count. |
| `api_url` | Next.js API base URL. |
| `preview_port` | Port of the local MJPEG preview used by the dashboard. |

Restart the worker after changing the config.

## Setting up the line

1. Start both processes and open the dashboard.
2. Look at the preview: the yellow line is the counting line, the green arrow
   shows the entry direction.
3. Place the line across the doorway so people must cross it fully, and so
   their **feet** (red dot under each box) cross it — the foot point is what is
   counted, not the head.
4. If the arrow points out of the venue instead of in, set `entry_side` to the
   other value.
5. Walk through a few times and check that *Total people entered* goes up once
   per person, and not when someone stands on the line or walks back out.

## Resetting counts

Stop the Next.js app and delete the `data/` folder. It is recreated empty on
the next start.

## Tests

```powershell
cd worker
.\.venv\Scripts\python -m unittest test_line_counter -v
```

These test the line-crossing rules only. Real-world accuracy depends on camera
placement, lighting and crowd density; dense crowds will be undercounted.

## Licensing

Ultralytics (YOLO11, ByteTrack implementation) is **AGPL-3.0**. That is fine for
internal use, but check https://www.ultralytics.com/license before distributing
this to third parties or offering it as a commercial product.
