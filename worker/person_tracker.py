"""Full-person detection (Ultralytics YOLO nano, COCO class 0) + ByteTrack.

One instance per camera: `YOLO.track(persist=True)` keeps the tracker state
inside the model object, so separate instances give independent track IDs.
Only box geometry is kept in memory; nothing about a person is stored.
"""

from __future__ import annotations

from typing import List, Tuple

from ultralytics import YOLO

PERSON_CLASS_ID = 0
Track = Tuple[float, float, float, float, int]   # x1, y1, x2, y2, track_id


class PersonTracker:
    def __init__(self, model_path: str, tracker_yaml: str, confidence: float, inference_size: int) -> None:
        self._model = YOLO(model_path)
        self._tracker_yaml = tracker_yaml
        self.confidence = float(confidence)
        self.inference_size = int(inference_size)

    def update(self, frame) -> List[Track]:
        results = self._model.track(
            frame,
            persist=True,
            tracker=self._tracker_yaml,
            classes=[PERSON_CLASS_ID],
            conf=self.confidence,
            imgsz=self.inference_size,
            verbose=False,
        )
        boxes = results[0].boxes
        if boxes is None or len(boxes) == 0 or boxes.id is None:
            return []
        xyxy = boxes.xyxy.tolist()
        ids = boxes.id.int().tolist()
        return [(x1, y1, x2, y2, tid) for (x1, y1, x2, y2), tid in zip(xyxy, ids)]
