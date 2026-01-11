"""
Optimized Multi-Scale ORB Detection
Best balance of performance and accuracy with no false positives.
"""

from typing import Tuple, Optional, Dict, List
import cv2
import numpy as np
import pickle
import os

from .interfaces import (
    IImageProcessor,
    IFeatureDetector,
    IFeatureMatcher
)
from .pose_solver import PoseSolver, TrackingState


class ImageProcessor(IImageProcessor):
    """Optimized multi-scale ORB detection with 6DoF pose estimation."""
    
    # Scale levels - balanced range
    SCALES = [1.0, 0.75, 0.5, 0.4, 0.3]
    
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
        
        # Pose solver for 6DoF pose computation
        # Target size will be set when set_target() is called
        self._pose_solver = PoseSolver(
            smoothing_alpha=0.7,  # More responsive (less smoothing)
            use_extrinsic_guess=True
        )
    
    def set_target(self, target_image: np.ndarray) -> bool:
        if target_image is None or target_image.size == 0:
            return False
        
        self._target_image = target_image
        h, w = target_image.shape[:2]
        self._target_corners = np.array([
            [0, 0], [w, 0], [w, h], [0, h]
        ], dtype=np.float32)
        
        # Calculate physical size maintaining target aspect ratio
        # Use the larger dimension as the base (1 meter)
        aspect_ratio = w / h
        
        if w >= h:
            target_width = self.TARGET_PHYSICAL_BASE
            target_height = self.TARGET_PHYSICAL_BASE / aspect_ratio
        else:
            target_height = self.TARGET_PHYSICAL_BASE
            target_width = self.TARGET_PHYSICAL_BASE * aspect_ratio
        
        # Update pose solver with correct dimensions
        self._pose_solver.set_target_size(target_width, target_height)
        print(f"Target physical size: {target_width:.3f}m x {target_height:.3f}m (aspect: {aspect_ratio:.3f})")
        
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
        
        print(f"Pyramid: {[p['kp_count'] for p in self._pyramid]} keypoints")
        return True

    def load_target_blob(self, blob_path: str) -> bool:
        """Load preprocessed heart image target from .webarimg blob."""
        if not os.path.exists(blob_path):
            print(f"Error: Blob not found at {blob_path}")
            return False

        try:
            with open(blob_path, 'rb') as f:
                data = pickle.load(f)

            w, h = data['original_size']
            self._target_image = np.zeros((h, w, 3), dtype=np.uint8) # Dummy image for aspect ratio
            self._target_corners = np.array([
                [0, 0], [w, 0], [w, h], [0, h]
            ], dtype=np.float32)

            aspect_ratio = w / h
            if w >= h:
                target_width = self.TARGET_PHYSICAL_BASE
                target_height = self.TARGET_PHYSICAL_BASE / aspect_ratio
            else:
                target_height = self.TARGET_PHYSICAL_BASE
                target_width = self.TARGET_PHYSICAL_BASE * aspect_ratio

            self._pose_solver.set_target_size(target_width, target_height)
            
            self._pyramid = []
            for entry in data['pyramid']:
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

            print(f"✓ Target loaded from blob: {blob_path}")
            print(f"Pyramid: {[p['kp_count'] for p in self._pyramid]} keypoints")
            return True
        except Exception as e:
            print(f"Error loading target blob: {e}")
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
            if self._pose_solver._state == TrackingState.TRACKING and inliers_count >= 12 and inlier_ratio >= 0.45 and reproj_error < 3.5:
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
    
    def compute_pose_6dof(self, object_points: np.ndarray, image_points: np.ndarray,
                          frame_width: int, frame_height: int,
                          fov_degrees: float = 60.0) -> Optional[Dict]:
        """
        Compute 6DoF pose from inlier keypoints using solvePnPRansac.

        Args:
            object_points: Nx3 array of 3D target points (world coordinates)
            image_points: Nx2 array of 2D scene points (image coordinates)
            frame_width: Width of the camera frame
            frame_height: Height of the camera frame
            fov_degrees: Camera field of view in degrees

        Returns:
            Pose dict with matrix, position, rotation, distance, or None if failed
        """
        return self._pose_solver.compute_pose_ransac(
            object_points, image_points,
            frame_width, frame_height, fov_degrees
        )
    
    def get_pose(self) -> Optional[Dict]:
        """Return the last computed 6DoF pose."""
        return self._pose_solver.get_last_pose()
    
    def reset_pose(self):
        """Reset pose estimator state (call when target is lost)."""
        self._pose_solver.reset()
    
    def set_pose_smoothing(self, alpha: float):
        """Adjust pose smoothing. Lower = smoother, higher = more responsive."""
        self._pose_solver.set_smoothing(alpha)
