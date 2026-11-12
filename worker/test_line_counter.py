"""Unit tests for the counting-line logic. Run with: python -m unittest test_line_counter -v"""

import unittest

from line_counter import LineCounter

# Horizontal line across a 1000px-wide image at y=500.
# With entry_side="positive", the normal (y1-y2, x2-x1) = (0, 1000)/1000 = (0, 1),
# so the positive side is BELOW the line (larger y). Walking top -> bottom is entry.


def make_counter(entry_side="positive", **kwargs):
    return LineCounter((0, 500), (1000, 500), entry_side=entry_side, **kwargs)


class LineCounterTests(unittest.TestCase):
    def walk(self, counter, track_id, ys, x=500, start_frame=0):
        results = []
        for i, y in enumerate(ys):
            results.append(counter.update(track_id, (x, y), start_frame + i))
        return results

    def test_crossing_in_entry_direction_counts_once(self):
        c = make_counter()
        results = self.walk(c, 1, [300, 350, 400, 450, 520, 560, 600, 650])
        self.assertEqual(sum(results), 1)
        self.assertEqual(c.total_entries, 1)

    def test_crossing_in_exit_direction_does_not_count(self):
        c = make_counter()
        results = self.walk(c, 1, [650, 600, 560, 520, 450, 400, 350, 300])
        self.assertEqual(sum(results), 0)
        self.assertEqual(c.total_entries, 0)

    def test_entry_side_negative_flips_direction(self):
        c = make_counter(entry_side="negative")
        self.assertEqual(sum(self.walk(c, 1, [650, 600, 560, 520, 450, 400])), 1)
        c2 = make_counter(entry_side="negative")
        self.assertEqual(sum(self.walk(c2, 2, [300, 350, 400, 450, 520, 560])), 0)

    def test_track_first_seen_on_entry_side_does_not_count(self):
        c = make_counter()
        self.assertEqual(sum(self.walk(c, 1, [600, 620, 650, 700])), 0)

    def test_no_double_count_when_person_goes_back_and_forth(self):
        c = make_counter()
        ys = [300, 400, 520, 600, 520, 400, 300, 400, 520, 600, 700]
        self.assertEqual(sum(self.walk(c, 1, ys)), 1)

    def test_standing_on_line_jitter_does_not_count(self):
        c = make_counter(margin_px=8)
        # Jitters around y=500 within the dead zone, never clearly crossing.
        ys = [300, 400, 495, 505, 498, 503, 496, 504]
        self.assertEqual(sum(self.walk(c, 1, ys)), 0)

    def test_jitter_then_real_crossing_counts(self):
        c = make_counter(margin_px=8)
        ys = [300, 400, 495, 505, 498, 503, 550, 600]
        self.assertEqual(sum(self.walk(c, 1, ys)), 1)

    def test_multiple_people_crossing_together_counted_separately(self):
        c = make_counter()
        for frame in range(12):
            # Three people walking side by side, all entering.
            for tid, x in ((1, 300), (2, 500), (3, 700)):
                y = 300 + frame * 40
                c.update(tid, (x, y), frame)
        self.assertEqual(c.total_entries, 3)

    def test_track_with_too_few_frames_is_ignored(self):
        c = make_counter(min_track_frames=5)
        # Only 3 observations before the crossing: below the minimum.
        ys = [300, 600, 650]
        self.assertEqual(sum(self.walk(c, 1, ys)), 0)

    def test_signed_distance_and_anchor(self):
        c = make_counter()
        self.assertAlmostEqual(c.signed_distance((500, 600)), 100.0)
        self.assertAlmostEqual(c.signed_distance((500, 400)), -100.0)
        _, anchor = c.label_anchor(offset_px=40)
        self.assertGreater(anchor[1], 500)  # entry label sits below the line

    def test_zero_length_line_rejected(self):
        with self.assertRaises(ValueError):
            LineCounter((10, 10), (10, 10))

    def test_bad_entry_side_rejected(self):
        with self.assertRaises(ValueError):
            LineCounter((0, 0), (10, 0), entry_side="up")


if __name__ == "__main__":
    unittest.main()
