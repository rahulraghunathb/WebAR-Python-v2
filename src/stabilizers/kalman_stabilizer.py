"""
Kalman Filter Stabilizer for temporal smoothing of homography.
Reduces jitter by predicting and smoothing transformation matrices.
"""

from typing import Optional, Tuple
import numpy as np
import cv2


class KalmanStabilizer:
    """
    Kalman filter for smoothing homography transformations.
    
    Tracks the 4 corner points of the detected target and smooths
    their positions over time to reduce jitter.
    """
    
    def __init__(
        self,
        process_noise: float = 0.03,
        measurement_noise: float = 0.1,
        smoothing_factor: float = 0.5
    ):
        """
        Initialize Kalman stabilizer.
        
        Args:
            process_noise: Process noise covariance (lower = smoother)
            measurement_noise: Measurement noise covariance
            smoothing_factor: Blend factor between prediction and measurement
        """
        self._process_noise = process_noise
        self._measurement_noise = measurement_noise
        self._smoothing_factor = smoothing_factor
        
        # Kalman filters for each corner point (x, y velocity tracking)
        self._kalman_filters = None
        self._initialized = False
        self._last_corners = None
        self._lost_count = 0
        self._max_lost_frames = 5
    
    def _create_kalman_filter(self, initial_x: float, initial_y: float) -> cv2.KalmanFilter:
        """Create a Kalman filter for a single point."""
        kf = cv2.KalmanFilter(4, 2)  # 4 state vars (x, y, vx, vy), 2 measurements (x, y)
        
        # Transition matrix (constant velocity model)
        kf.transitionMatrix = np.array([
            [1, 0, 1, 0],  # x = x + vx
            [0, 1, 0, 1],  # y = y + vy
            [0, 0, 1, 0],  # vx = vx
            [0, 0, 0, 1]   # vy = vy
        ], dtype=np.float32)
        
        # Measurement matrix
        kf.measurementMatrix = np.array([
            [1, 0, 0, 0],
            [0, 1, 0, 0]
        ], dtype=np.float32)
        
        # Process noise covariance
        kf.processNoiseCov = np.eye(4, dtype=np.float32) * self._process_noise
        
        # Measurement noise covariance
        kf.measurementNoiseCov = np.eye(2, dtype=np.float32) * self._measurement_noise
        
        # Initial state
        kf.statePost = np.array([initial_x, initial_y, 0, 0], dtype=np.float32)
        
        # Error covariance
        kf.errorCovPost = np.eye(4, dtype=np.float32)
        
        return kf
    
    def stabilize(
        self, 
        corners: Optional[np.ndarray], 
        detected: bool
    ) -> Tuple[Optional[np.ndarray], bool]:
        """
        Stabilize corner positions using Kalman filtering.
        
        Args:
            corners: 4 corner points as (4, 1, 2) or (4, 2) array, or None if not detected
            detected: Whether target was detected this frame
            
        Returns:
            Tuple of (stabilized corners, is_valid)
        """
        if detected and corners is not None:
            # Reshape corners if needed
            if corners.shape == (4, 1, 2):
                corners = corners.reshape(4, 2)
            
            self._lost_count = 0
            
            if not self._initialized:
                # Initialize Kalman filters
                self._kalman_filters = []
                for i in range(4):
                    kf = self._create_kalman_filter(corners[i, 0], corners[i, 1])
                    self._kalman_filters.append(kf)
                self._initialized = True
                self._last_corners = corners.copy()
                return corners.reshape(4, 1, 2), True
            
            # Update each Kalman filter with measurement
            smoothed_corners = np.zeros((4, 2), dtype=np.float32)
            for i, kf in enumerate(self._kalman_filters):
                # Predict
                prediction = kf.predict()
                
                # Correct with measurement
                measurement = np.array([corners[i, 0], corners[i, 1]], dtype=np.float32)
                corrected = kf.correct(measurement)
                
                # Blend prediction and correction for extra smoothing
                smoothed_corners[i, 0] = (
                    self._smoothing_factor * corrected[0] + 
                    (1 - self._smoothing_factor) * prediction[0]
                )
                smoothed_corners[i, 1] = (
                    self._smoothing_factor * corrected[1] + 
                    (1 - self._smoothing_factor) * prediction[1]
                )
            
            self._last_corners = smoothed_corners.copy()
            return smoothed_corners.reshape(4, 1, 2), True
        
        else:
            # No detection - use prediction only
            self._lost_count += 1
            
            if not self._initialized or self._lost_count > self._max_lost_frames:
                return None, False
            
            # Predict without correction
            predicted_corners = np.zeros((4, 2), dtype=np.float32)
            for i, kf in enumerate(self._kalman_filters):
                prediction = kf.predict()
                predicted_corners[i, 0] = prediction[0]
                predicted_corners[i, 1] = prediction[1]
            
            return predicted_corners.reshape(4, 1, 2), True
    
    def reset(self):
        """Reset the stabilizer state."""
        self._kalman_filters = None
        self._initialized = False
        self._last_corners = None
        self._lost_count = 0
