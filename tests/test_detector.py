"""
Unit tests for the detection pipeline.
"""

import unittest
import numpy as np
import cv2

from src.detectors import ORBDetector
from src.matchers import BFMatcher
from src.processor import ImageProcessor


class TestORBDetector(unittest.TestCase):
    """Test ORB detector functionality."""
    
    def setUp(self):
        self.detector = ORBDetector(n_features=500)
    
    def test_detect_on_valid_image(self):
        """Test detection on a valid image."""
        # Create test image with features
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2.rectangle(img, (100, 100), (300, 300), (255, 255, 255), -1)
        cv2.circle(img, (400, 200), 50, (128, 128, 128), -1)
        
        keypoints, descriptors = self.detector.detect_and_compute(img)
        
        self.assertIsNotNone(keypoints)
        self.assertGreater(len(keypoints), 0)
        self.assertIsNotNone(descriptors)
    
    def test_detect_on_blank_image(self):
        """Test detection on blank image."""
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        
        keypoints, descriptors = self.detector.detect_and_compute(img)
        
        # Should return empty but not crash
        self.assertIsNotNone(keypoints)
    
    def test_get_name(self):
        """Test detector name."""
        self.assertEqual(self.detector.get_name(), "ORB")


class TestBFMatcher(unittest.TestCase):
    """Test BF matcher functionality."""
    
    def setUp(self):
        self.matcher = BFMatcher(min_matches=5)
    
    def test_match_with_none_descriptors(self):
        """Test matching with None descriptors."""
        matches = self.matcher.match(None, None)
        self.assertEqual(matches, [])
    
    def test_get_min_matches(self):
        """Test min matches getter."""
        self.assertEqual(self.matcher.get_min_matches(), 5)


class TestImageProcessor(unittest.TestCase):
    """Test main processor functionality."""

    def setUp(self):
        detector = ORBDetector(n_features=500)
        matcher = BFMatcher(min_matches=10)
        self.processor = ImageProcessor(detector, matcher)
    
    def test_is_ready_without_target(self):
        """Test ready state without target."""
        self.assertFalse(self.processor.is_ready())
    
    def test_set_valid_target(self):
        """Test setting a valid target image."""
        # Create target with rich features
        target = np.zeros((200, 200, 3), dtype=np.uint8)
        cv2.rectangle(target, (20, 20), (180, 180), (255, 255, 255), -1)
        cv2.circle(target, (100, 100), 30, (0, 0, 0), -1)
        cv2.line(target, (50, 50), (150, 150), (128, 128, 128), 3)
        
        success = self.processor.set_target(target)
        
        self.assertTrue(success)
        self.assertTrue(self.processor.is_ready())
    
    def test_set_empty_target(self):
        """Test setting an empty target."""
        empty = np.array([])
        
        success = self.processor.set_target(empty)
        
        self.assertFalse(success)
    
    def test_get_target_info(self):
        """Test getting target info."""
        info = self.processor.get_target_info()
        self.assertFalse(info['ready'])


if __name__ == '__main__':
    unittest.main()
