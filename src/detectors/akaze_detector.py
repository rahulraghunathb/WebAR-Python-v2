"""
AKAZE Feature Detector implementation.
Single Responsibility: Detect and compute AKAZE features only.
AKAZE provides better accuracy than ORB with more robust keypoints.
"""

from typing import Tuple, List, Optional
import cv2
import numpy as np

from ..interfaces import IFeatureDetector


class AKAZEDetector(IFeatureDetector):
    """
    AKAZE (Accelerated-KAZE) feature detector.
    
    More accurate than ORB, better suited for:
    - Scale and rotation invariance
    - Robustness to noise and blur
    - Non-linear scale space detection
    """
    
    def __init__(
        self,
        descriptor_type: int = cv2.AKAZE_DESCRIPTOR_MLDB,
        descriptor_size: int = 0,  # 0 = full size
        descriptor_channels: int = 3,
        threshold: float = 0.001,  # Lower = more keypoints
        n_octaves: int = 4,
        n_octave_layers: int = 4
    ):
        """
        Initialize AKAZE detector with configurable parameters.
        
        Args:
            descriptor_type: AKAZE_DESCRIPTOR_KAZE or AKAZE_DESCRIPTOR_MLDB
            descriptor_size: Size of the descriptor in bits (0 = full)
            descriptor_channels: Number of channels (1, 2, or 3)
            threshold: Detector response threshold
            n_octaves: Maximum number of octaves
            n_octave_layers: Number of sublevels per octave
        """
        self._akaze = cv2.AKAZE_create(
            descriptor_type=descriptor_type,
            descriptor_size=descriptor_size,
            descriptor_channels=descriptor_channels,
            threshold=threshold,
            nOctaves=n_octaves,
            nOctaveLayers=n_octave_layers
        )
        self._name = "AKAZE"
    
    def detect_and_compute(
        self, 
        image: np.ndarray
    ) -> Tuple[List, Optional[np.ndarray]]:
        """
        Detect keypoints and compute AKAZE descriptors.
        
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
        
        # Apply CLAHE for better contrast
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        
        # Detect and compute
        keypoints, descriptors = self._akaze.detectAndCompute(enhanced, None)
        
        return keypoints, descriptors
    
    def get_name(self) -> str:
        """Return detector name."""
        return self._name
