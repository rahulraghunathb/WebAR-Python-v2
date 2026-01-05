"""
FLANN-based Feature Matcher implementation.
Faster than brute-force matching for large feature sets.
"""

from typing import List
import cv2
import numpy as np

from ..interfaces import IFeatureMatcher


class FLANNMatcher(IFeatureMatcher):
    """
    FLANN (Fast Library for Approximate Nearest Neighbors) matcher.
    
    Significantly faster than brute-force for large feature sets.
    Supports both binary (ORB, AKAZE) and float (SIFT, SURF) descriptors.
    """
    
    def __init__(
        self,
        use_binary: bool = True,
        ratio_threshold: float = 0.7,
        min_matches: int = 10,
        checks: int = 50
    ):
        """
        Initialize FLANN matcher.
        
        Args:
            use_binary: True for binary descriptors (ORB, AKAZE), False for float
            ratio_threshold: Lowe's ratio test threshold (lower = stricter)
            min_matches: Minimum matches for valid detection
            checks: Number of checks in search (higher = more accurate, slower)
        """
        self._ratio_threshold = ratio_threshold
        self._min_matches = min_matches
        
        if use_binary:
            # LSH index for binary descriptors
            index_params = dict(
                algorithm=6,  # FLANN_INDEX_LSH
                table_number=6,
                key_size=12,
                multi_probe_level=1
            )
        else:
            # KD-Tree for float descriptors
            index_params = dict(
                algorithm=1,  # FLANN_INDEX_KDTREE
                trees=5
            )
        
        search_params = dict(checks=checks)
        self._matcher = cv2.FlannBasedMatcher(index_params, search_params)
    
    def match(
        self, 
        descriptors1: np.ndarray, 
        descriptors2: np.ndarray
    ) -> List:
        """
        Match descriptors using FLANN with ratio test.
        
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
        
        # Ensure descriptors are uint8 for binary matching
        if descriptors1.dtype != np.uint8:
            descriptors1 = descriptors1.astype(np.uint8)
        if descriptors2.dtype != np.uint8:
            descriptors2 = descriptors2.astype(np.uint8)
        
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
