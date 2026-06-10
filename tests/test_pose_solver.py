"""
Unit tests for the pose solver state machine and session isolation.
"""

import unittest
import numpy as np
import cv2

from src.detectors import ORBDetector
from src.matchers import BFMatcher
from src.processor import ImageProcessor
from src.pose_solver import PoseSolver, TrackingState


def make_target(size=300):
    """Create a feature-rich synthetic target image."""
    rng = np.random.RandomState(42)
    img = rng.randint(0, 255, (size, size, 3), dtype=np.uint8)
    img = cv2.GaussianBlur(img, (3, 3), 0)
    cv2.rectangle(img, (30, 30), (size - 30, size - 30), (255, 255, 255), 4)
    cv2.circle(img, (size // 2, size // 2), size // 6, (0, 0, 0), -1)
    return img


def project_points(solver, object_points, rvec, tvec):
    pts, _ = cv2.projectPoints(
        object_points, rvec, tvec,
        solver.get_camera_matrix(), np.zeros((4, 1), dtype=np.float32)
    )
    return pts.reshape(-1, 2)


class TestPoseSolverStateMachine(unittest.TestCase):
    """Verify SEARCHING → TRACKING → LOST → SEARCHING transitions."""

    def setUp(self):
        self.solver = PoseSolver()
        self.solver.set_target_size(1.0, 1.0)
        self.solver.estimate_camera_from_fov(640, 480, 60.0)

        # Synthetic planar correspondences: grid of points on the target,
        # viewed from a known camera pose.
        n = 5
        xs, ys = np.meshgrid(np.linspace(-0.4, 0.4, n), np.linspace(-0.4, 0.4, n))
        self.object_points = np.stack(
            [xs.ravel(), ys.ravel(), np.zeros(n * n)], axis=1
        ).astype(np.float32)
        self.rvec = np.array([[0.1], [0.05], [0.0]], dtype=np.float32)
        self.tvec = np.array([[0.0], [0.0], [1.5]], dtype=np.float32)
        self.image_points = project_points(
            self.solver, self.object_points, self.rvec, self.tvec
        )

    def test_initial_state_is_searching(self):
        self.assertEqual(self.solver.get_state(), TrackingState.SEARCHING)

    def test_detection_transitions_to_tracking(self):
        pose = self.solver.compute_pose_ransac(
            self.object_points, self.image_points, 640, 480
        )
        self.assertIsNotNone(pose)
        self.assertEqual(self.solver.get_state(), TrackingState.TRACKING)
        self.assertGreater(pose['confidence'], 0.3)

    def test_recovered_pose_matches_ground_truth(self):
        pose = self.solver.compute_pose_ransac(
            self.object_points, self.image_points, 640, 480
        )
        self.assertIsNotNone(pose)
        # Distance camera-to-target should be ~|tvec| = 1.5m
        self.assertAlmostEqual(pose['distance'], 1.5, delta=0.05)

    def test_no_detection_decays_to_searching(self):
        """notify_no_detection must drive TRACKING → LOST → SEARCHING."""
        self.solver.compute_pose_ransac(
            self.object_points, self.image_points, 640, 480
        )
        self.assertEqual(self.solver.get_state(), TrackingState.TRACKING)

        self.solver.notify_no_detection()
        self.assertEqual(self.solver.get_state(), TrackingState.LOST)

        for _ in range(PoseSolver.LOST_FRAME_THRESHOLD + 1):
            self.solver.notify_no_detection()
        self.assertEqual(self.solver.get_state(), TrackingState.SEARCHING)
        # Stale prior must be gone so it cannot poison re-acquisition
        self.assertIsNone(self.solver._last_rvec)

    def test_reacquisition_after_loss(self):
        self.solver.compute_pose_ransac(
            self.object_points, self.image_points, 640, 480
        )
        for _ in range(PoseSolver.LOST_FRAME_THRESHOLD + 2):
            self.solver.notify_no_detection()
        self.assertEqual(self.solver.get_state(), TrackingState.SEARCHING)

        pose = self.solver.compute_pose_ransac(
            self.object_points, self.image_points, 640, 480
        )
        self.assertIsNotNone(pose)
        self.assertEqual(self.solver.get_state(), TrackingState.TRACKING)

    def test_too_few_points_returns_none(self):
        pose = self.solver.compute_pose_ransac(
            self.object_points[:3], self.image_points[:3], 640, 480
        )
        self.assertIsNone(pose)


class TestSessionIsolation(unittest.TestCase):
    """Per-session processor copies must share target data but not state."""

    def setUp(self):
        detector = ORBDetector(n_features=500)
        matcher = BFMatcher(min_matches=10)
        self.base = ImageProcessor(detector, matcher)
        self.assertTrue(self.base.set_target(make_target()))

    def test_copy_is_ready_and_shares_pyramid(self):
        clone = self.base.create_session_copy()
        self.assertTrue(clone.is_ready())
        self.assertIs(clone._pyramid, self.base._pyramid)

    def test_copy_has_independent_solver_state(self):
        a = self.base.create_session_copy()
        b = self.base.create_session_copy()
        self.assertIsNot(a._pose_solver, b._pose_solver)

        # Drive one session's state machine; the other must be untouched
        a._pose_solver._state = TrackingState.TRACKING
        a.notify_no_detection()
        self.assertEqual(a._pose_solver.get_state(), TrackingState.LOST)
        self.assertEqual(b._pose_solver.get_state(), TrackingState.SEARCHING)

    def test_copy_inherits_physical_size(self):
        clone = self.base.create_session_copy()
        self.assertAlmostEqual(
            clone._pose_solver._target_width,
            self.base._pose_solver._target_width
        )
        self.assertAlmostEqual(
            clone._pose_solver._target_height,
            self.base._pose_solver._target_height
        )


if __name__ == '__main__':
    unittest.main()
