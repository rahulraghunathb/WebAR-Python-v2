"""
ORB Feature Detector implementation.
Single Responsibility: Detect and compute ORB features only.
"""

from typing import Tuple, List, Optional
import cv2
import numpy as np

from ..interfaces import IFeatureDetector


class ORBDetector(IFeatureDetector):
    """
    ORB (Oriented FAST and Rotated BRIEF) feature detector.
    
    Implements IFeatureDetector interface for pluggable detection.
    """
    
    def __init__(
        self,
        n_features: int = 1000,
        scale_factor: float = 1.2,
        n_levels: int = 8,
        edge_threshold: int = 31,
        first_level: int = 0,
        wta_k: int = 2,
        patch_size: int = 31,
        fast_threshold: int = 20
    ):
        """
        Initialize ORB detector with configurable parameters.
        
        Args:
            n_features: Maximum number of features to retain
            scale_factor: Pyramid decimation ratio (> 1)
            n_levels: Number of pyramid levels
            edge_threshold: Size of border where features not detected
            first_level: Level of pyramid to put source image
            wta_k: Number of points for oriented BRIEF descriptor
            patch_size: Size of patch used by oriented BRIEF
            fast_threshold: Threshold for FAST keypoint detector
        """
        self._orb = cv2.ORB_create(
            nfeatures=n_features,
            scaleFactor=scale_factor,
            nlevels=n_levels,
            edgeThreshold=edge_threshold,
            firstLevel=first_level,
            WTA_K=wta_k,
            patchSize=patch_size,
            fastThreshold=fast_threshold
        )
        self._name = "ORB"
    
    def detect_and_compute(
        self, 
        image: np.ndarray
    ) -> Tuple[List, Optional[np.ndarray]]:
        """
        Detect keypoints and compute ORB descriptors.
        
        Args:
            image: Input image (grayscale or BGR)
            
        Returns:
            Tuple of (keypoints list, descriptors array or None)
        """
        # Convert to grayscale if needed
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image
        
        # Detect and compute
        keypoints, descriptors = self._orb.detectAndCompute(gray, None)
        
        return keypoints, descriptors
    
    def get_name(self) -> str:
        """Return detector name."""
        return self._name
