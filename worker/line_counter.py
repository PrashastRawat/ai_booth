"""Virtual counting-line logic.

This module has no computer-vision dependencies so it can be unit-tested on its
own. It receives (track_id, foot_point) observations and reports when a tracked
person crosses the line in the configured entry direction.

Coordinates are in image pixels, with y increasing downwards.

Side convention
---------------
For a line from P1 to P2, the "positive" side is the side that the normal
(y1 - y2, x2 - x1) points to. Use `entry_side` to choose which side people walk
INTO. The preview draws an "ENTRY" label on the entry side so you can confirm
the direction visually.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Tuple

Point = Tuple[float, float]


@dataclass
class _TrackState:
    side: int = 0            # last confidently observed side: -1, +1, or 0 (unknown)
    frames_seen: int = 0     # observations received for this track
    last_frame: int = 0      # frame index of the most recent observation
    counted: bool = False    # True once this track has produced an entry
    outside_frames: int = 0  # observations clearly on the non-entry side


class LineCounter:
    def __init__(
        self,
        p1: Point,
        p2: Point,
        entry_side: str = "positive",
        margin_px: float = 8.0,
        min_track_frames: int = 3,
        forget_after_frames: int = 300,
        min_outside_frames: int = 2,
    ) -> None:
        if entry_side not in ("positive", "negative"):
            raise ValueError("entry_side must be 'positive' or 'negative'")
        dx, dy = p2[0] - p1[0], p2[1] - p1[1]
        length = math.hypot(dx, dy)
        if length < 1e-6:
            raise ValueError("counting line has zero length")

        self.p1 = p1
        self.p2 = p2
        self.margin_px = margin_px
        self.min_track_frames = min_track_frames
        self.min_outside_frames = min_outside_frames
        self.forget_after_frames = forget_after_frames
        self._length = length
        # Unit normal pointing to the positive side.
        self.positive_normal: Point = ((p1[1] - p2[1]) / length, (p2[0] - p1[0]) / length)
        self._entry_sign = 1 if entry_side == "positive" else -1
        self._tracks: Dict[int, _TrackState] = {}
        self.total_entries = 0

    # ------------------------------------------------------------------ geometry
    def signed_distance(self, point: Point) -> float:
        """Perpendicular distance in pixels. Positive means the positive side."""
        px, py = point
        nx, ny = self.positive_normal
        return (px - self.p1[0]) * nx + (py - self.p1[1]) * ny

    def label_anchor(self, offset_px: float = 40.0) -> Tuple[Point, Point]:
        """Midpoint of the line and a point offset toward the entry side (for drawing)."""
        mx = (self.p1[0] + self.p2[0]) / 2
        my = (self.p1[1] + self.p2[1]) / 2
        nx, ny = self.positive_normal
        s = self._entry_sign * offset_px
        return (mx, my), (mx + nx * s, my + ny * s)

    # ------------------------------------------------------------------ counting
    def update(self, track_id: int, point: Point, frame_index: int) -> bool:
        """Feed one observation. Returns True only when this track enters now."""
        self._prune(frame_index)
        state = self._tracks.get(track_id)
        if state is None:
            state = _TrackState()
            self._tracks[track_id] = state
        state.frames_seen += 1
        state.last_frame = frame_index

        distance = self.signed_distance(point)
        # Dead zone (hysteresis): ignore jitter while the person stands on the line.
        if abs(distance) <= self.margin_px:
            return False

        new_side = 1 if distance > 0 else -1
        entered = False
        if (
            not state.counted
            and state.side != 0            # we have seen this track on the other side first
            and new_side != state.side     # it actually crossed
            and new_side == self._entry_sign
            and state.frames_seen >= self.min_track_frames
            and state.outside_frames >= self.min_outside_frames  # was clearly outside, not an ID born on the line
        ):
            state.counted = True           # never count this track ID again
            self.total_entries += 1
            entered = True
        if new_side != self._entry_sign:
            state.outside_frames += 1
        state.side = new_side
        return entered

    def has_counted(self, track_id: int) -> bool:
        state = self._tracks.get(track_id)
        return bool(state and state.counted)

    def _prune(self, frame_index: int) -> None:
        # Bound memory: forget tracks that have not been seen for a long time.
        if frame_index % 100 != 0:
            return
        cutoff = frame_index - self.forget_after_frames
        stale = [tid for tid, st in self._tracks.items() if st.last_frame < cutoff]
        for tid in stale:
            del self._tracks[tid]
