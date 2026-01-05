"""
Brute-Force Feature Matcher implementation.
Single Responsibility: Match feature descriptors only.
"""

from typing import List, Optional
import cv2
import numpy as np

from ..interfaces import IFeatureMatcher


class BFMatcher(IFeatureMatcher):
    """
    Brute-Force matcher for binary descriptors (ORB, BRIEF, etc.).
    
    Uses HAMMING distance and Lowe's ratio test for filtering.
    """
    
    def __init__(
        self,
        norm_type: int = cv2.NORM_HAMMING,
        cross_check: bool = False,
        ratio_threshold: float = 0.75,
        min_matches: int = 10
    ):
        """
        Initialize BF matcher with configurable parameters.
        
        Args:
            norm_type: Distance norm (HAMMING for binary descriptors)
            cross_check: Enable cross-check matching
            ratio_threshold: Lowe's ratio test threshold
            min_matches: Minimum matches for valid detection
        """
        self._matcher = cv2.BFMatcher(norm_type, crossCheck=cross_check)
        self._ratio_threshold = ratio_threshold
        self._min_matches = min_matches
    
    def match(
        self, 
        descriptors1: np.ndarray, 
        descriptors2: np.ndarray
    ) -> List:
        """
        Match descriptors using kNN and Lowe's ratio test.
        
        Args:
            descriptors1: Descriptors from target image
            descriptors2: Descriptors from scene image
            
        Returns:
            List of good matches passing ratio test
        """
        if descriptors1 is None or descriptors2 is None:
            return []
        
        if len(descriptors1) < 2 or len(descriptors2) < 2:
            return []
        
        # kNN matching with k=2
        try:
            matches = self._matcher.knnMatch(descriptors1, descriptors2, k=2)
        except cv2.error:
            return []
        
        # Apply Lowe's ratio test
        good_matches = []
        for match_pair in matches:
            if len(match_pair) == 2:
                m, n = match_pair
                if m.distance < self._ratio_threshold * n.distance:
                    good_matches.append(m)
        
        return good_matches
    
    def get_min_matches(self) -> int:
        """Return minimum matches threshold."""
        return self._min_matches
