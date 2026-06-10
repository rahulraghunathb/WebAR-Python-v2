"""
Pose Solver - Production 6DoF Pose Estimation with Tracking Mode

TRACKING STATE MACHINE:
=======================
SEARCHING → DETECTING → TRACKING → LOST → SEARCHING

SEARCHING: No target found, full detection each frame
DETECTING: Target found, initializing pose
TRACKING:  Pose established, incremental updates using prior
LOST:      Tracking failed, attempting re-detection

IMPORTANT: The caller MUST call notify_no_detection() on frames where the
detector found nothing, otherwise the state machine never decays and a stale
pose prior survives indefinitely.

SMOOTHING: None on the backend. Temporal smoothing is owned entirely by the
frontend renderer (which runs at display rate and can do it time-correctly).
Stacking smoothing on both ends was a major source of perceived lag.

COORDINATE SYSTEMS:
==================
3D Points (for solvePnP): X-right, Y-down (OpenCV image convention), Z=0 plane
OpenCV Camera: X-right, Y-down, Z-forward (into scene)
Three.js Camera: X-right, Y-up, Z-backward (toward viewer)

The conversion from OpenCV to Three.js is done in _build_pose_data() by
applying a flip matrix C = diag(1, -1, -1) to both rotation and translation.
"""

import logging
from typing import Optional, Dict
from enum import Enum
import cv2
import numpy as np

log = logging.getLogger(__name__)


class TrackingState(Enum):
    SEARCHING = "SEARCHING"  # No target, doing full detection
    DETECTING = "DETECTING"  # Target found, initializing pose
    TRACKING = "TRACKING"    # Stable tracking with prior
    LOST = "LOST"           # Lost tracking, re-detecting


class PoseSolver:
    """
    Production 6DoF pose solver with tracking mode for stable AR.

    Key features:
    - State machine for detection → tracking transitions
    - Pose refinement using previous frame as prior
    - Confidence-based tracking quality assessment
    - Proper coordinate system conversion for Three.js
    """

    # Physical target size defaults (meters)
    DEFAULT_TARGET_WIDTH = 1.0
    DEFAULT_TARGET_HEIGHT = 1.0

    # Tracking thresholds
    MIN_INLIERS_DETECT = 8      # Minimum inliers for initial detection
    MIN_INLIERS_TRACK = 6       # Minimum inliers to maintain tracking
    MAX_REPROJ_ERROR = 5.0      # Maximum reprojection error (pixels)

    # Lost tracking recovery
    LOST_FRAME_THRESHOLD = 5    # Frames before switching to SEARCHING

    def __init__(self,
                 target_width: float = None,
                 target_height: float = None):
        """Initialize the pose solver."""
        self._target_width = target_width or self.DEFAULT_TARGET_WIDTH
        self._target_height = target_height or self.DEFAULT_TARGET_HEIGHT

        self._target_3d_points = None
        self._camera_matrix = None
        self._dist_coeffs = np.zeros((4, 1), dtype=np.float32)

        # Tracking state
        self._state = TrackingState.SEARCHING
        self._lost_frames = 0
        self._tracking_frames = 0

        # Pose state (tracking prior)
        self._last_rvec = None
        self._last_tvec = None
        self._last_pose = None
        self._last_inlier_count = 0
        self._last_reproj_error = float('inf')

        # Tracking confidence
        self._confidence = 0.0

        self._init_target_points()

    def _init_target_points(self):
        """Initialize 3D target corner points centered at origin.

        COORDINATE SYSTEM (OpenCV convention for solvePnP):
        - Origin at target center
        - X: positive to the right
        - Y: positive DOWN (OpenCV image convention)
        - Z: positive out of target (toward camera)

        Corner order matches standard image corner detection:
        [Top-Left, Top-Right, Bottom-Right, Bottom-Left]

        The conversion to Three.js Y-up happens in _build_pose_data()
        """
        hw = self._target_width / 2
        hh = self._target_height / 2

        # Target in XY plane at Z=0, Y-DOWN (OpenCV convention)
        self._target_3d_points = np.array([
            [-hw, -hh, 0],  # Top-Left
            [ hw, -hh, 0],  # Top-Right
            [ hw,  hh, 0],  # Bottom-Right
            [-hw,  hh, 0]   # Bottom-Left
        ], dtype=np.float32)

    def set_target_size(self, width: float, height: float):
        """Update target physical dimensions in meters."""
        self._target_width = width
        self._target_height = height
        self._init_target_points()

    def set_camera_intrinsics(self, fx: float, fy: float, cx: float, cy: float):
        """Set camera intrinsic matrix directly."""
        self._camera_matrix = np.array([
            [fx, 0, cx],
            [0, fy, cy],
            [0, 0, 1]
        ], dtype=np.float32)

    def estimate_camera_from_fov(self, frame_width: int, frame_height: int,
                                  fov_degrees: float = 60.0):
        """Estimate camera intrinsics from horizontal FOV."""
        fov_rad = np.radians(fov_degrees)
        fx = frame_width / (2 * np.tan(fov_rad / 2))
        fy = fx  # Square pixels
        cx = frame_width / 2
        cy = frame_height / 2
        self.set_camera_intrinsics(fx, fy, cx, cy)

    def get_state(self) -> TrackingState:
        """Get current tracking state."""
        return self._state

    def get_confidence(self) -> float:
        """Get tracking confidence (0-1)."""
        return self._confidence

    def notify_no_detection(self):
        """Notify the solver that the detector found nothing this frame.

        This drives the TRACKING → LOST → SEARCHING decay so a stale pose
        prior cannot survive across long gaps and poison re-acquisition.
        """
        self._handle_detection_failure()

    def compute_pose_ransac(self, object_points: np.ndarray, image_points: np.ndarray,
                            frame_width: int, frame_height: int,
                            fov_degrees: float = 60.0,
                            reproj_threshold: float = 8.0) -> Optional[Dict]:
        """
        Compute 6DoF pose with tracking mode support.

        Uses state machine to determine how to process each frame:
        - SEARCHING/DETECTING: Full solvePnPRansac, no prior
        - TRACKING: Use previous pose as prior for refinement
        - LOST: Attempt re-detection with relaxed thresholds
        """
        if len(object_points) < 4 or len(image_points) < 4:
            self._handle_detection_failure()
            return None

        # Ensure camera intrinsics
        if self._camera_matrix is None:
            self.estimate_camera_from_fov(frame_width, frame_height, fov_degrees)

        # Process based on current state
        if self._state in [TrackingState.SEARCHING, TrackingState.DETECTING]:
            return self._compute_initial_pose(object_points, image_points, reproj_threshold)
        elif self._state == TrackingState.TRACKING:
            return self._compute_tracking_pose(object_points, image_points, reproj_threshold)
        elif self._state == TrackingState.LOST:
            return self._compute_recovery_pose(object_points, image_points, reproj_threshold)

        return None

    def _compute_initial_pose(self, object_points: np.ndarray, image_points: np.ndarray,
                               reproj_threshold: float) -> Optional[Dict]:
        """Compute pose during initial detection (no prior).

        Uses SOLVEPNP_IPPE: purpose-built for planar targets (all our object
        points lie on Z=0), faster and more accurate inside RANSAC than the
        generic iterative solver.
        """
        success, rvec, tvec, inliers = cv2.solvePnPRansac(
            object_points.astype(np.float32),
            image_points.astype(np.float32),
            self._camera_matrix,
            self._dist_coeffs,
            reprojectionError=reproj_threshold,
            iterationsCount=100,
            flags=cv2.SOLVEPNP_IPPE
        )

        if not success or inliers is None or len(inliers) < self.MIN_INLIERS_DETECT:
            self._handle_detection_failure()
            return None

        # Refine with inliers only
        obj_inliers = object_points[inliers.flatten()].astype(np.float32)
        img_inliers = image_points[inliers.flatten()].astype(np.float32)

        success, rvec, tvec = cv2.solvePnP(
            obj_inliers, img_inliers,
            self._camera_matrix, self._dist_coeffs,
            rvec=rvec, tvec=tvec,
            useExtrinsicGuess=True,
            flags=cv2.SOLVEPNP_ITERATIVE
        )

        if not success:
            self._handle_detection_failure()
            return None

        # Compute reprojection error
        reproj_error = self._compute_reprojection_error(obj_inliers, img_inliers, rvec, tvec)

        if reproj_error > self.MAX_REPROJ_ERROR:
            self._handle_detection_failure()
            return None

        # Successful detection - transition to TRACKING
        self._state = TrackingState.TRACKING
        self._tracking_frames = 1
        self._lost_frames = 0
        self._last_rvec = rvec.copy()
        self._last_tvec = tvec.copy()
        self._last_inlier_count = len(inliers)
        self._last_reproj_error = reproj_error

        # Compute confidence
        self._confidence = self._compute_confidence(len(inliers), reproj_error, len(object_points))

        # Build and store pose
        pose = self._build_pose_data(rvec, tvec)
        pose['inlier_count'] = len(inliers)
        pose['reproj_error'] = reproj_error
        pose['state'] = self._state.value
        pose['confidence'] = self._confidence
        self._last_pose = pose

        log.info("[Pose] DETECTING→TRACKING: inliers=%d, reproj=%.2fpx, conf=%.2f",
                 len(inliers), reproj_error, self._confidence)
        return pose

    def _compute_tracking_pose(self, object_points: np.ndarray, image_points: np.ndarray,
                                reproj_threshold: float) -> Optional[Dict]:
        """Compute pose during tracking (use prior for stability)."""
        # Use previous pose as initial guess for refinement
        success, rvec, tvec, inliers = cv2.solvePnPRansac(
            object_points.astype(np.float32),
            image_points.astype(np.float32),
            self._camera_matrix,
            self._dist_coeffs,
            rvec=self._last_rvec.copy(),
            tvec=self._last_tvec.copy(),
            useExtrinsicGuess=True,  # KEY: Use prior!
            reprojectionError=reproj_threshold,
            iterationsCount=50,  # Fewer iterations when tracking
            flags=cv2.SOLVEPNP_ITERATIVE
        )

        if not success or inliers is None or len(inliers) < self.MIN_INLIERS_TRACK:
            return self._handle_tracking_failure()

        # Refine with inliers
        obj_inliers = object_points[inliers.flatten()].astype(np.float32)
        img_inliers = image_points[inliers.flatten()].astype(np.float32)

        success, rvec, tvec = cv2.solvePnP(
            obj_inliers, img_inliers,
            self._camera_matrix, self._dist_coeffs,
            rvec=rvec, tvec=tvec,
            useExtrinsicGuess=True,
            flags=cv2.SOLVEPNP_ITERATIVE
        )

        if not success:
            return self._handle_tracking_failure()

        # Compute reprojection error
        reproj_error = self._compute_reprojection_error(obj_inliers, img_inliers, rvec, tvec)

        # Check for tracking quality
        if reproj_error > self.MAX_REPROJ_ERROR * 1.5:  # Slightly relaxed for tracking
            return self._handle_tracking_failure()

        # Update state (also covers LOST → TRACKING recovery)
        self._state = TrackingState.TRACKING
        self._tracking_frames += 1
        self._lost_frames = 0
        self._last_rvec = rvec.copy()
        self._last_tvec = tvec.copy()
        self._last_inlier_count = len(inliers)
        self._last_reproj_error = reproj_error

        # Update confidence
        self._confidence = self._compute_confidence(len(inliers), reproj_error, len(object_points))

        # Build pose
        pose = self._build_pose_data(rvec, tvec)
        pose['inlier_count'] = len(inliers)
        pose['reproj_error'] = reproj_error
        pose['state'] = self._state.value
        pose['confidence'] = self._confidence
        pose['tracking_frames'] = self._tracking_frames
        self._last_pose = pose

        # Log occasionally
        if self._tracking_frames % 30 == 0:
            log.info("[Pose] TRACKING: frames=%d, inliers=%d, reproj=%.2fpx",
                     self._tracking_frames, len(inliers), reproj_error)

        return pose

    def _compute_recovery_pose(self, object_points: np.ndarray, image_points: np.ndarray,
                                reproj_threshold: float) -> Optional[Dict]:
        """Attempt to recover tracking after loss.

        Reuses the tracking path with a relaxed threshold (single PnP solve;
        the previous implementation solved twice on success). If the prior is
        gone, fall back to a fresh detection.
        """
        if self._last_rvec is None:
            self._state = TrackingState.SEARCHING
            return self._compute_initial_pose(object_points, image_points, reproj_threshold)

        pose = self._compute_tracking_pose(object_points, image_points, reproj_threshold * 1.5)
        if pose is not None:
            log.info("[Pose] LOST→TRACKING: Recovered with %d inliers", pose['inlier_count'])
        return pose  # None on failure: never return a stale pose during recovery

    def _handle_detection_failure(self):
        """Handle failed detection."""
        if self._state == TrackingState.TRACKING:
            self._state = TrackingState.LOST
            self._lost_frames = 1
        elif self._state == TrackingState.LOST:
            self._lost_frames += 1
            if self._lost_frames > self.LOST_FRAME_THRESHOLD:
                self._state = TrackingState.SEARCHING
                self._last_rvec = None
                self._last_tvec = None
                log.info("[Pose] LOST→SEARCHING: Lost for %d frames", self._lost_frames)

        self._confidence = 0.0

    def _handle_tracking_failure(self) -> Optional[Dict]:
        """Handle a failed tracking/recovery frame."""
        if self._state != TrackingState.LOST:
            log.info("[Pose] TRACKING→LOST: Tracking failed")
        self._state = TrackingState.LOST
        self._lost_frames += 1
        self._confidence *= 0.8  # Decay confidence

        if self._lost_frames > self.LOST_FRAME_THRESHOLD:
            self._state = TrackingState.SEARCHING
            self._last_rvec = None
            self._last_tvec = None
            log.info("[Pose] LOST→SEARCHING: Lost for %d frames", self._lost_frames)

        return None  # CRITICAL: Return None to avoid "stuck" model visual.

    def _compute_reprojection_error(self, object_points: np.ndarray, image_points: np.ndarray,
                                     rvec: np.ndarray, tvec: np.ndarray) -> float:
        """Compute mean reprojection error."""
        projected, _ = cv2.projectPoints(object_points, rvec, tvec,
                                          self._camera_matrix, self._dist_coeffs)
        projected = projected.reshape(-1, 2)
        errors = np.linalg.norm(projected - image_points.reshape(-1, 2), axis=1)
        return float(np.mean(errors))

    def _compute_confidence(self, inlier_count: int, reproj_error: float, total_points: int) -> float:
        """Compute tracking confidence (0-1)."""
        # Inlier ratio contribution
        inlier_score = min(1.0, inlier_count / 20.0)

        # Reprojection error contribution (lower is better)
        reproj_score = max(0.0, 1.0 - reproj_error / self.MAX_REPROJ_ERROR)

        # Coverage contribution (more points = more confident)
        coverage_score = min(1.0, total_points / 30.0)

        # Weighted combination
        confidence = 0.4 * inlier_score + 0.4 * reproj_score + 0.2 * coverage_score
        return float(np.clip(confidence, 0.0, 1.0))

    def _build_pose_data(self, rvec: np.ndarray, tvec: np.ndarray) -> Dict:
        """
        Convert OpenCV pose to Three.js camera transformation.

        solvePnP gives: Object pose in Camera frame (T_cam_obj)
        We need: Camera pose in World frame (T_world_cam) for Three.js

        Coordinate systems:
        - OpenCV: X-right, Y-down, Z-forward
        - Three.js: X-right, Y-up, Z-backward

        Steps:
        1. Get R, t from solvePnP (object in camera coords)
        2. Invert to get camera in object/world coords
        3. Convert OpenCV→OpenGL coordinates (flip Y and Z)
        4. Output column-major 4x4 matrix
        """
        # Step 1: Rodrigues to rotation matrix
        R_cv, _ = cv2.Rodrigues(rvec)
        t_cv = tvec.flatten()

        # Step 2: Invert to get camera in world coords
        R_cam = R_cv.T
        t_cam = -R_cam @ t_cv

        # Step 3: OpenCV to OpenGL/Three.js conversion
        # Flip Y and Z axes
        C = np.diag([1.0, -1.0, -1.0]).astype(np.float32)
        R_gl = C @ R_cam @ C
        t_gl = C @ t_cam

        # Step 4: Build 4x4 matrix
        T = np.eye(4, dtype=np.float32)
        T[:3, :3] = R_gl
        T[:3, 3] = t_gl

        # Convert to column-major for Three.js
        matrix_colmajor = T.T.flatten().tolist()

        # Compute distance
        distance = float(np.linalg.norm(t_cv))

        log.debug("[Pose] pos=(%.3f,%.3f,%.3f) dist=%.2fm", t_gl[0], t_gl[1], t_gl[2], distance)

        return {
            'matrix': matrix_colmajor,
            'position': {
                'x': float(t_gl[0]),
                'y': float(t_gl[1]),
                'z': float(t_gl[2])
            },
            'rotation': self._matrix_to_euler_degrees(R_gl),
            'distance': distance,
            'camera_matrix': {
                'fx': float(self._camera_matrix[0, 0]),
                'fy': float(self._camera_matrix[1, 1]),
                'cx': float(self._camera_matrix[0, 2]),
                'cy': float(self._camera_matrix[1, 2])
            }
        }

    def _matrix_to_euler_degrees(self, R: np.ndarray) -> Dict[str, float]:
        """Convert rotation matrix to Euler angles (XYZ order, degrees)."""
        sy = np.sqrt(R[0, 0]**2 + R[1, 0]**2)
        singular = sy < 1e-6

        if not singular:
            x = np.arctan2(R[2, 1], R[2, 2])
            y = np.arctan2(-R[2, 0], sy)
            z = np.arctan2(R[1, 0], R[0, 0])
        else:
            x = np.arctan2(-R[1, 2], R[1, 1])
            y = np.arctan2(-R[2, 0], sy)
            z = 0

        return {
            'x': float(np.degrees(x)),
            'y': float(np.degrees(y)),
            'z': float(np.degrees(z))
        }

    def reset(self):
        """Reset all pose state."""
        self._state = TrackingState.SEARCHING
        self._lost_frames = 0
        self._tracking_frames = 0
        self._last_rvec = None
        self._last_tvec = None
        self._last_pose = None
        self._confidence = 0.0
        log.info("[Pose] Reset to SEARCHING")

    def get_last_pose(self) -> Optional[Dict]:
        """Return the last computed pose."""
        return self._last_pose

    def get_target_3d_points(self) -> np.ndarray:
        """Return the 3D target corner points."""
        return self._target_3d_points.copy()

    def get_camera_matrix(self) -> Optional[np.ndarray]:
        """Return the current camera intrinsic matrix."""
        return self._camera_matrix.copy() if self._camera_matrix is not None else None

    # Legacy compatibility
    def compute_pose(self, corners: np.ndarray, frame_width: int, frame_height: int,
                     fov_degrees: float = 60.0) -> Optional[Dict]:
        """Compute pose from 4 corners (legacy method)."""
        if corners is None or len(corners) != 4:
            return None

        image_points = corners.reshape(4, 2).astype(np.float32)

        if self._camera_matrix is None:
            self.estimate_camera_from_fov(frame_width, frame_height, fov_degrees)

        return self.compute_pose_ransac(
            self._target_3d_points, image_points,
            frame_width, frame_height, fov_degrees
        )
