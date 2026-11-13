# Entrance counter

Counts people entering an event through one or two USB webcams (one per
entrance). A Python worker detects people (YOLO11 nano, person class only),
tracks them (ByteTrack) and counts each tracked person once when the
centre of their bounding box crosses a virtual line in the entry direction. Each entry is sent to the Next.js app,
stored in SQLite, and shown on a live dashboard.

```
camera A -> thread A \
                      worker/entry_counter.py --POST--> Next.js /api/events --> data/entries.db
camera B -> thread B /          |                                   ^
                                +-- MJPEG :8765/stream/<A|B> <-- dashboard -- GET /api/stats
```

No cloud services, auth, Docker or Redis. No video is recorded, no images or
biometric data are stored and no identities are recognised; the database only
stores an event ID, a timestamp, the camera name and a temporary tracker ID.

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

The YOLO weights (`yolo11n.pt`, ~5 MB) download automatically the first time
the worker runs.

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

Global keys: `api_url`, `preview_port`, `heartbeat_seconds`, `model`,
`tracker` (ByteTrack settings file), `black_frame_threshold`,
`stalled_read_seconds`.

Each entry in `cameras` describes one entrance:

| Key | Meaning |
|---|---|
| `name` | Short label (`A`, `B`). Used in the database, API and dashboard. |
| `index` | Webcam index. Run `python camera_diag.py` (with the worker stopped) to see which index is which camera. |
| `capture_width`, `capture_height` | Requested capture size. The camera falls back to its nearest supported size. |
| `inference_size` | YOLO input size, independent of capture size. 480 is a good CPU default; 640 detects smaller/further people at lower FPS. |
| `confidence` | Minimum person-detection confidence (0–1). |
| `line` | Counting line as `[x1, y1, x2, y2]`, fractions of the frame. |
| `entry_side` | `"positive"` or `"negative"`. Flip if the green **ENTRY** arrow points the wrong way. |
| `line_margin_px` | Dead zone around the line so a person standing on it does not flicker across. |
| `min_track_frames` | A person must be tracked this many frames before they can count. |
| `min_outside_frames` | A person must be seen clearly on the outside side this many frames before a crossing counts (rejects IDs that appear on the line). |
| `roi` | Optional polygon of `[x, y]` fractions, e.g. `[[0.2,0.3],[0.8,0.3],[0.9,1],[0.1,1]]`. Only people whose crossing point is inside it are considered; use it to ignore foot traffic that walks past the entrance. `null` = whole frame. |

Restart the worker after changing the config.

## Event period – `.env.local`

Total Visitors counts entries inside the event period. Create `.env.local` in
the project folder (next to `package.json`):

```
EVENT_START_DATE=2026-11-14
EVENT_END_DATE=2026-11-25
```

Both are IST calendar days and both are inclusive. Either one can be left out
to leave that end open. With neither set, Total Visitors counts every stored
entry, including test walk-throughs from setup days. Restart the Next.js app
after changing the file. A malformed date makes `/api/stats` return an error
(shown on the dashboard) rather than a wrong total.

## Visitor counts

Every count is a query over the stored entries. Nothing is reset or deleted
at midnight, and restarting either process does not change any number.

- **Today's Visitors**: entries whose timestamp falls on the current calendar
  day in India Standard Time (`Asia/Kolkata`). The day's start and the next
  day's start are converted to UTC and counted as
  `occurred_at >= start AND occurred_at < nextStart`. This is recomputed on every
  request, so the number goes back to 0 at 00:00 IST without a restart. The
  Windows machine's own timezone setting is never used.
- **Total Visitors**: entries inside the event period above. It never resets.

`GET /api/stats` returns (values are examples):

```json
{
  "todayVisitors": 25000,
  "totalVisitors": 83000,
  "timezone": "Asia/Kolkata",
  "date": "2026-11-13",
  "event": { "startDate": "2026-11-14", "endDate": "2026-11-25" },
  "total": 83000,
  "last5Minutes": 140,
  "lastEntryAt": "2026-11-13T12:41:07.512Z",
  "serverTime": "2026-11-13T12:41:09.004Z",
  "workerOnline": true,
  "cameras": [
    { "name": "A", "todayVisitors": 12000, "totalVisitors": 41000, "entries": 41000, "last5Minutes": 70, "online": true, "...": "..." }
  ]
}
```

`total` and `cameras[].entries` are kept for older consumers and equal
`totalVisitors`. All counts are 0 when the database is empty.

`GET /api/stats/daily` returns visitors per IST day, split by camera:

- With no parameters it covers the event period, or just today if none is set.
- `?date=2026-11-13` returns one day.
- `?from=2026-11-14&to=2026-11-25` returns a range of at most 366 days.

### Timestamps and clock skew

The worker stamps each entry with the time its camera frame arrived, as
ISO 8601 UTC with an explicit offset (`2026-11-13T18:29:59.123+00:00`). The
database stores it as `occurred_at`, in UTC epoch milliseconds, and the IST day
is derived from that value. The server's own receive time is also stored, as
`received_at`, for auditing.

`POST /api/events` checks the timestamp:

| Check | Result |
|---|---|
| Not ISO 8601, no `Z`/`+hh:mm` offset, or an impossible date/time (e.g. `2026-02-30`) | `400`, not stored |
| More than **60 s ahead** of the server clock | `422`, not stored |
| More than **24 h older** than the server clock | `422`, not stored |
| Event ID already stored | `200` with `inserted: false`, counted once (checked before the age limit, so a late retry is still acknowledged) |
| Otherwise | `201`, stored under its own timestamp |

Why these limits:

- The worker and the API run on the same PC with the same clock, so a
  timestamp that is meaningfully in the future means a bug or a foreign client.
- 24 h comfortably covers the worker's retry queue if the API is down for a while.
- A late but valid event keeps its own timestamp. An entry at 23:59 IST that
  reaches the API at 00:01 counts for the previous day: yesterday's figure goes
  up by one and today's does not.

The worker drops events the API rejects with `4xx` and logs an error.

Keep Windows time synchronisation on, so the PC clock stays correct.

## Setting up the line

1. Start both processes and open the dashboard.
2. Look at the preview: the yellow line is the counting line, the green arrow
   shows the entry direction.
3. Place the line across the doorway so people must cross it fully, and so
   their **body centre** (red dot in the middle of each box) crosses it — the
   centre of the box is what is counted, not the feet, head or box edge. Boxes
   drawn grey are outside the ROI and ignored.
4. If the arrow points out of the venue instead of in, set `entry_side` to the
   other value.
5. Walk through a few times and check that *Total people entered* goes up once
   per person, and not when someone stands on the line or walks back out.

## Resetting counts

Today's Visitors resets at midnight IST on its own. To leave out setup-day
test entries, set `EVENT_START_DATE` (see above) rather than deleting data.

To wipe everything: stop the Next.js app and delete the `data/` folder. It is
recreated empty on the next start. **This permanently deletes all recorded
entries.**

## Tests

```powershell
npm test
```

These cover the following:

- IST day boundaries, including the 23:59:59.999 / 00:00 edge.
- Timestamp and clock-skew validation.
- The event period.
- Duplicate IDs.
- The midnight, restart and delayed-event scenarios.

They run against throwaway SQLite databases, never `data/entries.db`.

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
