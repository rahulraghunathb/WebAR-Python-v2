import unittest

import cv2
import numpy as np

from src.detectors import ORBDetector
from src.matchers import BFMatcher
from src.pose_solver import PoseSolver, TrackingState
from src.processor import ImageProcessor


class TestPoseSolverStateTransitions(unittest.TestCase):
    def test_report_no_detection_moves_tracking_to_lost(self):
        solver = PoseSolver()
        solver._state = TrackingState.TRACKING
        solver._confidence = 0.8

        solver.report_no_detection()

        self.assertEqual(solver.get_state(), TrackingState.LOST)
        self.assertEqual(solver.get_confidence(), 0.0)

    def test_report_no_detection_eventually_returns_to_searching(self):
        solver = PoseSolver()
        solver._state = TrackingState.LOST
        solver._lost_frames = solver.LOST_FRAME_THRESHOLD
        solver._last_pose = {'matrix': [1.0] * 16}

        solver.report_no_detection()

        self.assertEqual(solver.get_state(), TrackingState.SEARCHING)
        self.assertIsNone(solver.get_last_pose())

    def test_get_target_size_reflects_updates(self):
        solver = PoseSolver()
        solver.set_target_size(1.2, 0.75)
        self.assertEqual(solver.get_target_size(), (1.2, 0.75))


class TestProcessorTrackingStatus(unittest.TestCase):
    def setUp(self):
        detector = ORBDetector(n_features=500)
        matcher = BFMatcher(min_matches=10)
        self.processor = ImageProcessor(detector, matcher)

        target = np.zeros((200, 200, 3), dtype=np.uint8)
        cv2.rectangle(target, (20, 20), (180, 180), (255, 255, 255), -1)
        cv2.circle(target, (100, 100), 30, (0, 0, 0), -1)
        cv2.line(target, (50, 50), (150, 150), (128, 128, 128), 3)
        self.processor.set_target(target)

    def test_notify_no_detection_updates_pose_status(self):
        self.processor._pose_solver._state = TrackingState.TRACKING
        self.processor.notify_no_detection()

        status = self.processor.get_pose_status()
        self.assertEqual(status['tracking_state'], TrackingState.LOST.value)
        self.assertEqual(status['tracking_confidence'], 0.0)


if __name__ == '__main__':
    unittest.main()
