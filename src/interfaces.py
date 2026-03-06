"""
Abstract interfaces following Interface Segregation Principle (ISP).
Each interface defines a single responsibility for the detection pipeline.
"""

from abc import ABC, abstractmethod
from typing import Tuple, List, Optional
import numpy as np


class IFeatureDetector(ABC):
    """Interface for feature detection algorithms (ORB, SIFT, etc.)"""
    
    @abstractmethod
    def detect_and_compute(self, image: np.ndarray) -> Tuple[List, Optional[np.ndarray]]:
        """
        Detect keypoints and compute descriptors.
        
        Args:
            image: Grayscale or BGR image
            
        Returns:
            Tuple of (keypoints, descriptors)
        """
        pass
    
    @abstractmethod
    def get_name(self) -> str:
        """Return the name of the detector algorithm."""
        pass


class IFeatureMatcher(ABC):
    """Interface for feature matching algorithms."""
    
    @abstractmethod
    def match(
        self, 
        descriptors1: np.ndarray, 
        descriptors2: np.ndarray
    ) -> List:
        """
        Match descriptors between two images.
        
        Args:
            descriptors1: Descriptors from target image
            descriptors2: Descriptors from scene image
            
        Returns:
            List of good matches
        """
        pass
    
    @abstractmethod
    def get_min_matches(self) -> int:
        """Return minimum matches required for valid detection."""
        pass


class IImageProcessor(ABC):
    """Interface for the main image processing pipeline."""
    
    @abstractmethod
    def set_target(self, target_image: np.ndarray) -> bool:
        """
        Set the target image for detection.
        
        Args:
            target_image: Target image to detect
            
        Returns:
            True if target was set successfully
        """
        pass
    
    @abstractmethod
    def process_frame(self, frame: np.ndarray) -> Tuple[np.ndarray, bool]:
        """
        Process a video frame and detect target.
        
        Args:
            frame: Video frame to process
            
        Returns:
            Tuple of (processed frame with annotations, detection success)
        """
        pass
    
    @abstractmethod
    def is_ready(self) -> bool:
        """Check if processor is ready (target set)."""
        pass
