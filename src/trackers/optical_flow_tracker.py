"""
Optical Flow Tracker for persistent point tracking.
Tracks detected keypoints across frames instead of re-detecting every frame.
"""

from typing import Optional, Tuple, List
import numpy as np
import cv2


class OpticalFlowTracker:
    """
    Lucas-Kanade optical flow for tracking keypoints across frames.
    
    Reduces computation by only re-detecting features when tracking
    quality drops below threshold.
    """
    
    def __init__(
        self,
        max_corners: int = 100,
        quality_level: float = 0.3,
        min_distance: float = 7,
        block_size: int = 7,
        win_size: Tuple[int, int] = (21, 21),
        max_level: int = 3,
        min_tracked_ratio: float = 0.5
    ):
        """
        Initialize optical flow tracker.
        
        Args:
            max_corners: Maximum corners for goodFeaturesToTrack
            quality_level: Quality level for corner detection
            min_distance: Minimum distance between corners
            block_size: Block size for corner detection
            win_size: Window size for optical flow
            max_level: Maximum pyramid level
            min_tracked_ratio: Minimum ratio of tracked points before re-detection
        """
        self._max_corners = max_corners
        self._quality_level = quality_level
        self._min_distance = min_distance
        self._block_size = block_size
        self._win_size = win_size
        self._max_level = max_level
        self._min_tracked_ratio = min_tracked_ratio
        
        # Optical flow parameters
        self._lk_params = dict(
            winSize=win_size,
            maxLevel=max_level,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)
        )
        
        # State
        self._prev_gray = None
        self._prev_points = None
        self._initial_points = None
        self._tracking_active = False
    
    def start_tracking(
        self, 
        frame: np.ndarray, 
        keypoints: List
    ) -> bool:
        """
        Start tracking from detected keypoints.
        
        Args:
            frame: Current frame (BGR or grayscale)
            keypoints: Detected keypoints to track
            
        Returns:
            True if tracking started successfully
        """
        if len(keypoints) < 4:
            return False
        
        # Convert to grayscale
        if len(frame.shape) == 3:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        else:
            gray = frame
        
        # Extract point coordinates from keypoints
        points = np.float32([kp.pt for kp in keypoints]).reshape(-1, 1, 2)
        
        # Limit number of points
        if len(points) > self._max_corners:
            # Sort by response and take top N
            kp_with_response = [(kp, kp.response) for kp in keypoints]
            kp_with_response.sort(key=lambda x: x[1], reverse=True)
            top_kps = [kp for kp, _ in kp_with_response[:self._max_corners]]
            points = np.float32([kp.pt for kp in top_kps]).reshape(-1, 1, 2)
        
        self._prev_gray = gray
        self._prev_points = points
        self._initial_points = points.copy()
        self._tracking_active = True
        
        return True
    
    def track(
        self, 
        frame: np.ndarray
    ) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], float]:
        """
        Track points to the new frame.
        
        Args:
            frame: Current frame
            
        Returns:
            Tuple of (new_points, old_points, tracked_ratio)
        """
        if not self._tracking_active or self._prev_gray is None:
            return None, None, 0.0
        
        # Convert to grayscale
        if len(frame.shape) == 3:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        else:
            gray = frame
        
        # Calculate optical flow
        new_points, status, error = cv2.calcOpticalFlowPyrLK(
            self._prev_gray,
            gray,
            self._prev_points,
            None,
            **self._lk_params
        )
        
        if new_points is None:
            return None, None, 0.0
        
        # Select good points
        status = status.flatten()
        good_new = new_points[status == 1]
        good_old = self._prev_points[status == 1]
        
        # Calculate tracked ratio
        tracked_ratio = len(good_new) / len(self._prev_points) if len(self._prev_points) > 0 else 0
        
        # Update state
        self._prev_gray = gray
        self._prev_points = good_new.reshape(-1, 1, 2)
        
        # Check if we need to re-detect
        if tracked_ratio < self._min_tracked_ratio:
            self._tracking_active = False
        
        return good_new, good_old.reshape(-1, 2), tracked_ratio
    
    def compute_homography(
        self, 
        new_points: np.ndarray, 
        old_points: np.ndarray
    ) -> Optional[np.ndarray]:
        """
        Compute homography from tracked points.
        
        Args:
            new_points: Points in current frame
            old_points: Points in previous frame
            
        Returns:
            Homography matrix or None
        """
        if len(new_points) < 4 or len(old_points) < 4:
            return None
        
        H, mask = cv2.findHomography(
            old_points.reshape(-1, 1, 2),
            new_points.reshape(-1, 1, 2),
            cv2.RANSAC,
            5.0
        )
        
        return H
    
    def is_tracking(self) -> bool:
        """Check if tracking is currently active."""
        return self._tracking_active
    
    def reset(self):
        """Reset tracker state."""
        self._prev_gray = None
        self._prev_points = None
        self._initial_points = None
        self._tracking_active = False
