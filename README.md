# Entrance counter

Counts people entering an event through one or two USB webcams (one per
entrance). A Python worker detects faces (OpenCV YuNet), tracks them
(ByteTrack) and counts each tracked face once when its centre crosses a
virtual line in the entry direction. Each entry is sent to the Next.js app,
stored in SQLite, and shown on a live dashboard.

```
camera A -> thread A \n                      worker/entry_counter.py --POST--> Next.js /api/events --> data/entries.db
camera B -> thread B /          |                                   ^
                                +-- MJPEG :8765/stream/<A|B> <-- dashboard -- GET /api/stats
```

No cloud services, auth, Docker or Redis. No video is recorded, no face images,
landmarks or embeddings are stored and no identities are recognised; the
database only stores an event ID, a timestamp, the camera name and a
temporary tracker ID.

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

Download the YuNet face model (~230 KB) once:

```powershell
curl.exe -L -o worker\modelsace_detection_yunet_2023mar.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
```

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

Useful flags: `--only A` runs a single camera, `--source A=1` overrides a
camera index for one run, `--show-window` opens local OpenCV windows.
Press `Ctrl+C` to stop the worker. A camera that is unplugged is retried every
2 seconds without affecting the other camera.

## Configuration – `worker/config.json`

Global keys: `api_url`, `preview_port`, `heartbeat_seconds`, `face_model`,
`black_frame_threshold`, `stalled_read_seconds`.

Each entry in `cameras` describes one entrance:

| Key | Meaning |
|---|---|
| `name` | Short label (`A`, `B`). Used in the database, API and dashboard. |
| `index` | Webcam index. Run `python camera_diag.py` (with the worker stopped) to see which index is which camera. |
| `capture_width`, `capture_height` | Requested capture size. The camera falls back to its nearest supported size. |
| `inference_width` | Frames wider than this are downscaled before face detection. Independent of capture size; 640 is a good CPU default, use more for a far-away camera. |
| `confidence` | Minimum face confidence (0–1) to start/keep a track. |
| `line` | Counting line as `[x1, y1, x2, y2]`, fractions of the frame. |
| `entry_side` | `"positive"` or `"negative"`. Flip if the green **ENTRY** arrow points the wrong way. |
| `line_margin_px` | Dead zone around the line so a face hovering on it does not flicker across. |
| `min_track_frames` | A face must be tracked this many frames before it can count. |
| `track_buffer` | Frames a lost face is kept alive (handles brief occlusions). |

Restart the worker after changing the config.

## Setting up the line

1. Start both processes and open the dashboard.
2. Look at the preview: the yellow line is the counting line, the green arrow
   shows the entry direction.
3. Place the line across the doorway so every face must cross it; the **centre
   of the face box** (red dot) is the point that is counted. For a face-level
   camera a horizontal line works; for a far camera looking along a corridor a
   line across the walking path works.
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

The ByteTrack implementation comes from the Ultralytics package, which is
**AGPL-3.0**. That is fine for internal use, but check
https://www.ultralytics.com/license before distributing this to third parties
or offering it as a commercial product. YuNet (OpenCV Zoo) is Apache-2.0.
