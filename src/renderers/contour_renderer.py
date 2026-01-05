"""
Contour Renderer for drawing detection results.
Single Responsibility: Draw visual overlays only.
"""

from typing import Tuple, List, Optional
import cv2
import numpy as np

from ..interfaces import IContourDrawer


class ContourRenderer(IContourDrawer):
    """
    Renders green contour around detected target.
    
    Computes homography from matched keypoints and transforms
    target corners to scene coordinates.
    """
    
    def __init__(
        self,
        line_color: Tuple[int, int, int] = (0, 255, 0),  # Green in BGR
        line_thickness: int = 4,
        min_inliers: int = 10,
        ransac_threshold: float = 5.0
    ):
        """
        Initialize contour renderer.
        
        Args:
            line_color: BGR color for contour lines
            line_thickness: Thickness of contour lines
            min_inliers: Minimum inliers for valid homography
            ransac_threshold: RANSAC reprojection threshold
        """
        self._line_color = line_color
        self._line_thickness = line_thickness
        self._min_inliers = min_inliers
        self._ransac_threshold = ransac_threshold
    
    def draw_contour(
        self,
        image: np.ndarray,
        target_corners: np.ndarray,
        matches: List,
        keypoints_target: List,
        keypoints_scene: List
    ) -> Tuple[np.ndarray, Optional[np.ndarray]]:
        """
        Draw green contour around detected target.
        
        Args:
            image: Scene image to draw on
            target_corners: Corner points of target image (4 corners)
            matches: List of good matches
            keypoints_target: Keypoints from target
            keypoints_scene: Keypoints from scene
            
        Returns:
            Tuple of (annotated image, transformed corners or None)
        """
        result = image.copy()
        
        if len(matches) < self._min_inliers:
            return result, None
        
        # Extract matched point coordinates
        src_pts = np.float32([
            keypoints_target[m.queryIdx].pt for m in matches
        ]).reshape(-1, 1, 2)
        
        dst_pts = np.float32([
            keypoints_scene[m.trainIdx].pt for m in matches
        ]).reshape(-1, 1, 2)
        
        # Compute homography with RANSAC
        homography, mask = cv2.findHomography(
            src_pts, 
            dst_pts, 
            cv2.RANSAC, 
            self._ransac_threshold
        )
        
        if homography is None:
            return result, None
        
        # Count inliers
        if mask is not None:
            inliers = np.sum(mask)
            if inliers < self._min_inliers:
                return result, None
        
        # Transform target corners to scene
        transformed_corners = cv2.perspectiveTransform(
            target_corners.reshape(-1, 1, 2).astype(np.float32),
            homography
        )
        
        # Validate transformed corners (check for degenerate quadrilateral)
        if not self._is_valid_quadrilateral(transformed_corners):
            return result, None
        
        # Draw the green contour
        corners_int = transformed_corners.reshape(-1, 2).astype(np.int32)
        cv2.polylines(
            result,
            [corners_int],
            isClosed=True,
            color=self._line_color,
            thickness=self._line_thickness,
            lineType=cv2.LINE_AA
        )
        
        # Add corner circles for visibility
        for corner in corners_int:
            cv2.circle(
                result,
                tuple(corner),
                8,
                self._line_color,
                -1,
                cv2.LINE_AA
            )
        
        return result, transformed_corners
    
    def _is_valid_quadrilateral(self, corners: np.ndarray) -> bool:
        """
        Check if transformed corners form a valid convex quadrilateral.
        
        Args:
            corners: 4 corner points
            
        Returns:
            True if valid quadrilateral
        """
        if corners is None or len(corners) != 4:
            return False
        
        pts = corners.reshape(4, 2)
        
        # Check if convex
        hull = cv2.convexHull(pts.astype(np.float32), returnPoints=True)
        if len(hull) != 4:
            return False
        
        # Check minimum area (reject tiny detections)
        area = cv2.contourArea(pts.astype(np.float32))
        if area < 1000:  # Minimum 1000 pixels
            return False
        
        return True
