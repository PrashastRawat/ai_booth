"""Face detection (OpenCV YuNet) + multi-object tracking (ByteTrack).

Only box geometry and confidence are kept in memory for tracking. No face
crops, landmarks, embeddings or identities are stored anywhere.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import List, Tuple

import cv2
import numpy as np
from ultralytics.trackers.byte_tracker import BYTETracker

Box = Tuple[float, float, float, float, float]          # x1, y1, x2, y2, confidence
Track = Tuple[float, float, float, float, int]          # x1, y1, x2, y2, track_id


class _Detections:
    """Minimal detections container with the interface BYTETracker expects."""

    def __init__(self, xywh: np.ndarray, conf: np.ndarray) -> None:
        self.xywh = np.asarray(xywh, dtype=np.float32).reshape(-1, 4)
        self.conf = np.asarray(conf, dtype=np.float32).reshape(-1)
        self.cls = np.zeros(len(self.conf), dtype=np.float32)

    def __len__(self) -> int:
        return len(self.conf)

    def __getitem__(self, mask):
        return _Detections(self.xywh[mask], self.conf[mask])


class FaceDetector:
    """YuNet wrapper. Frames wider than `inference_width` are downscaled before detection."""

    def __init__(self, model_path: str, score_threshold: float, inference_width: int) -> None:
        self._det = cv2.FaceDetectorYN.create(model_path, "", (320, 320), score_threshold, 0.3, 5000)
        self.inference_width = int(inference_width)
        self._input_size = None

    def detect(self, frame: np.ndarray) -> List[Box]:
        h, w = frame.shape[:2]
        scale = min(1.0, self.inference_width / w)
        small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale < 1.0 else frame
        size = (small.shape[1], small.shape[0])
        if size != self._input_size:
            self._det.setInputSize(size)
            self._input_size = size
        _, faces = self._det.detect(small)
        if faces is None:
            return []
        out: List[Box] = []
        for f in faces:                      # row: x, y, w, h, 10 landmark values, score
            x, y, bw, bh, conf = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])
            out.append((x / scale, y / scale, (x + bw) / scale, (y + bh) / scale, conf))
        return out


class FaceTracker:
    """ByteTrack over face boxes. IDs are unique per tracker instance (one per camera)."""

    def __init__(self, confidence: float, track_buffer: int = 60, match_thresh: float = 0.8) -> None:
        args = SimpleNamespace(
            track_high_thresh=float(confidence),
            track_low_thresh=0.1,
            new_track_thresh=float(confidence),
            track_buffer=int(track_buffer),
            match_thresh=float(match_thresh),
            fuse_score=True,
        )
        self._tracker = BYTETracker(args)

    def update(self, faces: List[Box]) -> List[Track]:
        if faces:
            arr = np.asarray(faces, dtype=np.float32)
            xywh = np.column_stack([
                (arr[:, 0] + arr[:, 2]) / 2, (arr[:, 1] + arr[:, 3]) / 2,
                arr[:, 2] - arr[:, 0], arr[:, 3] - arr[:, 1],
            ])
            dets = _Detections(xywh, arr[:, 4])
        else:
            dets = _Detections(np.zeros((0, 4)), np.zeros(0))
        rows = self._tracker.update(dets)
        return [(float(r[0]), float(r[1]), float(r[2]), float(r[3]), int(r[4])) for r in rows]
