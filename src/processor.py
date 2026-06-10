"""
Optimized Multi-Scale ORB Detection
Best balance of performance and accuracy with no false positives.
"""

import logging
import os
import pickle
from typing import Tuple, Optional, Dict

import cv2
import numpy as np

from .interfaces import (
    IImageProcessor,
    IFeatureDetector,
    IFeatureMatcher
)
from .pose_solver import PoseSolver, TrackingState

log = logging.getLogger(__name__)


class ImageProcessor(IImageProcessor):
    """Optimized multi-scale ORB detection with 6DoF pose estimation."""

    # Scale levels. Kept sparse on purpose: ORB itself already runs an
    # 8-level internal pyramid (scale_factor 1.2 ≈ 3.6x range), so dense
    # external scales mostly duplicated work. Each extra scale is a full
    # brute-force match per frame.
    SCALES = [1.0, 0.5, 0.3]

    # Thresholds
    MIN_MATCHES = 10
    MIN_INLIERS_BASE = 8
    RANSAC_THRESH = 4.0  # Tighter RANSAC

    # Anti-false-positive settings
    MIN_INLIER_RATIO = 0.40  # 40% of matches must survive RANSAC
    MIN_INLIER_RATIO_SMALL = 0.50  # 50% for small scales

    # Target physical size (meters) - base dimension for pose estimation
    # The actual aspect ratio is calculated from the target image
    TARGET_PHYSICAL_BASE = 1.0  # Base size in meters

    def __init__(self, detector, matcher):
        self._detector = detector
        self._matcher = matcher

        self._target_image = None
        self._target_corners = None
        self._pyramid = []
        self._last_scale = 1.0
        self._debug_info = {}

        # Pose solver for 6DoF pose computation (state machine + PnP).
        # Target size will be set when set_target() is called.
        # NOTE: no backend smoothing - the frontend renderer owns smoothing.
        self._pose_solver = PoseSolver()

    def create_session_copy(self) -> "ImageProcessor":
        """Create a per-session processor sharing the (read-only) target data.

        The pyramid/keypoints/descriptors are shared references; only the
        mutable tracking state (pose solver, last scale, debug info) is fresh.
        This is what makes multi-client use safe: each socket session gets its
        own state machine instead of corrupting a global one.
        """
        clone = ImageProcessor(self._detector, self._matcher)
        clone._target_image = self._target_image
        clone._target_corners = self._target_corners
        clone._pyramid = self._pyramid
        clone._pose_solver.set_target_size(
            self._pose_solver._target_width,
            self._pose_solver._target_height
        )
        return clone

    def set_target(self, target_image: np.ndarray) -> bool:
        if target_image is None or target_image.size == 0:
            return False

        self._target_image = target_image
        h, w = target_image.shape[:2]
        self._target_corners = np.array([
            [0, 0], [w, 0], [w, h], [0, h]
        ], dtype=np.float32)

        self._set_physical_size(w, h)

        # Build pyramid
        self._pyramid = []
        for scale in self.SCALES:
            if scale == 1.0:
                scaled = target_image
            else:
                scaled = cv2.resize(target_image, (int(w*scale), int(h*scale)))

            kp, desc = self._detector.detect_and_compute(scaled)
            if desc is not None and len(kp) >= 4:
                # Scale keypoints back to original size
                for k in kp:
                    k.pt = (k.pt[0]/scale, k.pt[1]/scale)
                self._pyramid.append({
                    'scale': scale,
                    'keypoints': kp,
                    'descriptors': desc,
                    'kp_count': len(kp)
                })

        if not self._pyramid:
            return False

        log.info("Pyramid: %s keypoints", [p['kp_count'] for p in self._pyramid])
        return True

    def _set_physical_size(self, w: int, h: int):
        """Compute physical target size (meters) preserving aspect ratio."""
        aspect_ratio = w / h
        if w >= h:
            target_width = self.TARGET_PHYSICAL_BASE
            target_height = self.TARGET_PHYSICAL_BASE / aspect_ratio
        else:
            target_height = self.TARGET_PHYSICAL_BASE
            target_width = self.TARGET_PHYSICAL_BASE * aspect_ratio

        self._pose_solver.set_target_size(target_width, target_height)
        log.info("Target physical size: %.3fm x %.3fm (aspect: %.3f)",
                 target_width, target_height, aspect_ratio)

    def load_target_blob(self, blob_path: str) -> bool:
        """Load preprocessed target features from a .webarimg blob."""
        if not os.path.exists(blob_path):
            log.error("Blob not found at %s", blob_path)
            return False

        try:
            with open(blob_path, 'rb') as f:
                data = pickle.load(f)

            w, h = data['original_size']
            self._target_image = np.zeros((h, w, 3), dtype=np.uint8)  # Dummy image for aspect ratio
            self._target_corners = np.array([
                [0, 0], [w, 0], [w, h], [0, h]
            ], dtype=np.float32)

            self._set_physical_size(w, h)

            # Blobs may contain more scales than we use at runtime - only
            # load the ones in SCALES so match cost stays bounded.
            wanted = [e for e in data['pyramid']
                      if any(abs(e['scale'] - s) < 1e-6 for s in self.SCALES)]
            if not wanted:
                wanted = data['pyramid']

            self._pyramid = []
            for entry in wanted:
                # Reconstruct cv2.KeyPoint objects
                keypoints = []
                for k in entry['keypoints']:
                    kp = cv2.KeyPoint(
                        x=k['pt'][0], y=k['pt'][1],
                        size=k['size'], angle=k['angle'],
                        response=k['response'], octave=k['octave'],
                        class_id=k['class_id']
                    )
                    keypoints.append(kp)

                self._pyramid.append({
                    'scale': entry['scale'],
                    'keypoints': keypoints,
                    'descriptors': entry['descriptors'],
                    'kp_count': len(keypoints)
                })

            log.info("Target loaded from blob: %s", blob_path)
            log.info("Pyramid: %s keypoints (scales %s)",
                     [p['kp_count'] for p in self._pyramid],
                     [p['scale'] for p in self._pyramid])
            return True
        except Exception as e:
            log.error("Error loading target blob: %s", e)
            return False

    def detect(self, frame: np.ndarray) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray], bool, float]:
        """
        Detect target in frame using multi-scale ORB matching.

        Returns:
            corners: 4x1x2 array of detected corners (for visualization)
            inlier_src: Nx1x2 array of inlier keypoints in target image space
            inlier_dst: Nx1x2 array of inlier keypoints in scene/frame space
            detected: True if target was detected
            confidence: Detection confidence (0-1)
        """
        self._debug_info = {
            'keypoints': 0, 'good_matches': 0, 'inliers': 0,
            'confidence': 0, 'scale_used': 0, 'state': 'NO_DETECTION'
        }

        if not self.is_ready():
            return None, None, None, False, 0.0

        scene_kp, scene_desc = self._detector.detect_and_compute(frame)
        self._debug_info['keypoints'] = len(scene_kp) if scene_kp else 0

        if scene_desc is None or len(scene_kp) < 8:
            return None, None, None, False, 0.0

        best = None
        best_score = 0

        for entry in self._get_scale_order():
            scale = entry['scale']

            # Match
            matches = self._matcher.match(entry['descriptors'], scene_desc)
            n_matches = len(matches)
            if n_matches < self.MIN_MATCHES:
                continue

            # Compute homography with tight RANSAC
            src = np.float32([entry['keypoints'][m.queryIdx].pt for m in matches]).reshape(-1,1,2)
            dst = np.float32([scene_kp[m.trainIdx].pt for m in matches]).reshape(-1,1,2)

            H, mask = cv2.findHomography(src, dst, cv2.RANSAC, self.RANSAC_THRESH)
            if H is None:
                continue

            inliers_count = int(np.sum(mask)) if mask is not None else 0

            # Scale-dependent minimum inliers
            min_inliers = max(self.MIN_INLIERS_BASE, int(12 * scale))
            if inliers_count < min_inliers:
                continue

            # Inlier ratio - stricter at small scales
            inlier_ratio = inliers_count / n_matches
            required_ratio = self.MIN_INLIER_RATIO_SMALL if scale < 0.5 else self.MIN_INLIER_RATIO
            if inlier_ratio < required_ratio:
                continue

            # Transform corners (for visualization)
            corners = cv2.perspectiveTransform(self._target_corners.reshape(-1,1,2), H)

            # Validate geometry
            if not self._validate_quad(corners, scale):
                continue

            # Compute reprojection error
            reproj_error = self._compute_reproj_error(src, dst, H, mask)
            max_error = 3.0 + (1.0 - scale) * 4.0  # 3px close, 7px far
            if reproj_error > max_error:
                continue

            # Extract inlier keypoints for pose estimation
            inlier_indices = np.where(mask.flatten() == 1)[0]
            inlier_src_pts = src[inlier_indices]  # Target image 2D points
            inlier_dst_pts = dst[inlier_indices]  # Scene image 2D points

            # Score: weighted combination
            score = (inliers_count * 0.4) + (inlier_ratio * 20) + ((1.0 / max(0.5, reproj_error)) * 5)

            if score > best_score:
                best_score = score
                best = {
                    'corners': corners,
                    'inlier_src': inlier_src_pts,
                    'inlier_dst': inlier_dst_pts,
                    'matches': n_matches,
                    'inliers': inliers_count,
                    'scale': scale,
                    'confidence': min(1.0, inliers_count / 20.0),
                    'reproj': reproj_error
                }

            # Early exit if excellent
            if inliers_count >= 15 and inlier_ratio >= 0.5 and reproj_error < 2.0:
                break

            # FAST-TRACKING Early exit: during stable tracking, even moderate success is enough to move on
            if (self._pose_solver.get_state() == TrackingState.TRACKING
                    and inliers_count >= 12 and inlier_ratio >= 0.45 and reproj_error < 3.5):
                break

        if best:
            self._last_scale = best['scale']
            self._debug_info.update({
                'good_matches': int(best['matches']),
                'inliers': int(best['inliers']),
                'confidence': float(best['confidence']),
                'scale_used': float(best['scale']),
                'state': 'DETECTED'
            })
            return best['corners'], best['inlier_src'], best['inlier_dst'], True, best['confidence']

        return None, None, None, False, 0.0

    def _get_scale_order(self):
        ordered, others = [], []
        for e in self._pyramid:
            if abs(e['scale'] - self._last_scale) < 0.15:
                ordered.insert(0, e)
            else:
                others.append(e)
        others.sort(key=lambda x: x['scale'])
        return ordered + others

    def _validate_quad(self, corners, scale: float) -> bool:
        """Strict quad validation to prevent false positives."""
        if corners is None or len(corners) != 4:
            return False

        pts = corners.reshape(4, 2).astype(np.float32)

        # Area check - scale dependent
        area = cv2.contourArea(pts)
        min_area = max(500, 1500 * scale)  # Larger min at close range
        if area < min_area:
            return False

        # Convexity - must be a proper quad
        hull = cv2.convexHull(pts, returnPoints=False)
        if len(hull) != 4:
            return False

        # Edge lengths
        edges = [np.linalg.norm(pts[(i+1)%4] - pts[i]) for i in range(4)]
        min_edge = max(20, 30 * scale)
        if min(edges) < min_edge:
            return False

        # Aspect ratio check
        if max(edges) / min(edges) > 6:
            return False

        # Check for reasonable angles (not too acute)
        for i in range(4):
            v1 = pts[(i+1)%4] - pts[i]
            v2 = pts[(i-1)%4] - pts[i]
            cos_angle = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6)
            angle = np.arccos(np.clip(cos_angle, -1, 1))
            if angle < 0.3 or angle > 2.8:  # ~17° to ~160°
                return False

        return True

    def _compute_reproj_error(self, src, dst, H, mask) -> float:
        if mask is None or np.sum(mask) == 0:
            return float('inf')

        projected = cv2.perspectiveTransform(src, H)
        errors = [np.linalg.norm(projected[i] - dst[i])
                  for i in range(len(mask)) if mask[i]]
        return np.mean(errors) if errors else float('inf')

    def _map_2d_to_3d(self, pts_2d: np.ndarray) -> np.ndarray:
        """
        Map 2D target image points to 3D world coordinates.

        COORDINATE SYSTEMS (OpenCV convention, Y-DOWN):
        - Image: Origin at top-left, Y increases downward
        - 3D: Origin at target center, Y increases downward (matches image)

        Mapping:
        - Image (0, 0) [Top-Left]     -> 3D (-hw, -hh, 0)
        - Image (w, 0) [Top-Right]    -> 3D (+hw, -hh, 0)
        - Image (w, h) [Bottom-Right] -> 3D (+hw, +hh, 0)
        - Image (0, h) [Bottom-Left]  -> 3D (-hw, +hh, 0)

        The conversion to Three.js Y-up happens in pose_solver._build_pose_data()

        Args:
            pts_2d: Nx2 array of points in target image pixels

        Returns:
            Nx3 array of 3D world points (on Z=0 plane)
        """
        h, w = self._target_image.shape[:2]

        # Get physical dimensions from pose_solver
        phys_w = self._pose_solver._target_width
        phys_h = self._pose_solver._target_height

        # Map pixel coords to physical coords (centered at origin, Y-down like image)
        pts_3d = np.zeros((len(pts_2d), 3), dtype=np.float32)
        pts_3d[:, 0] = (pts_2d[:, 0] / w - 0.5) * phys_w  # X: 0->-hw, w->+hw
        pts_3d[:, 1] = (pts_2d[:, 1] / h - 0.5) * phys_h  # Y: 0->-hh, h->+hh (Y-down)
        pts_3d[:, 2] = 0  # Z = 0 (planar target)

        return pts_3d

    def estimate_pose(self, inlier_src: np.ndarray, inlier_dst: np.ndarray,
                      frame_width: int, frame_height: int) -> Optional[Dict]:
        """Compute 6DoF pose from detect() inlier correspondences.

        Maps target-image inliers to 3D world points and delegates to the
        pose solver. This is the one entry point app code should use.
        """
        object_points = self._map_2d_to_3d(inlier_src.reshape(-1, 2))
        image_points = inlier_dst.reshape(-1, 2)
        return self._pose_solver.compute_pose_ransac(
            object_points, image_points, frame_width, frame_height
        )

    def notify_no_detection(self):
        """Tell the pose solver the detector found nothing this frame.

        Must be called on every missed frame so the tracking state machine
        decays (TRACKING → LOST → SEARCHING) instead of keeping a stale prior.
        """
        self._pose_solver.notify_no_detection()

    def set_camera_intrinsics(self, fx: float, fy: float, cx: float, cy: float):
        """Forward camera intrinsics to the pose solver."""
        self._pose_solver.set_camera_intrinsics(fx, fy, cx, cy)

    def process_frame(self, frame):
        corners, _, _, detected, conf = self.detect(frame)
        result = frame.copy()
        if detected and corners is not None:
            pts = corners.reshape(-1, 2).astype(np.int32)
            cv2.polylines(result, [pts], True, (0, 255, 0), 3, cv2.LINE_AA)
            for p in pts:
                cv2.circle(result, tuple(p), 5, (0, 255, 0), -1)
        return result, detected

    def is_ready(self):
        return self._target_image is not None and len(self._pyramid) > 0

    def get_target_info(self):
        if not self.is_ready():
            return {"ready": False}
        return {
            "ready": True,
            "keypoints_count": sum(p['kp_count'] for p in self._pyramid),
            "pyramid_scales": len(self._pyramid)
        }

    def get_debug_info(self):
        return self._debug_info.copy()

    def get_pose(self) -> Optional[Dict]:
        """Return the last computed 6DoF pose."""
        return self._pose_solver.get_last_pose()

    def reset_pose(self):
        """Reset pose estimator state (call when target is lost)."""
        self._pose_solver.reset()
