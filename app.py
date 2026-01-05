"""
Flask Application with WebSocket for real-time target detection.
Entry point for the web application.
"""

import base64
import os

import cv2
import numpy as np
from flask import Flask, render_template, jsonify
from flask_socketio import SocketIO, emit

from src.detectors import ORBDetector
from src.matchers import BFMatcher
from src.processor import ImageProcessor


# Initialize Flask app
app = Flask(__name__, static_folder='static', template_folder='static')
app.config['SECRET_KEY'] = 'target-detection-secret-key'

# Initialize SocketIO with eventlet
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# Create processor with ORB + BFMatcher
# More features = better matching, lower thresholds = more detections
detector = ORBDetector(n_features=1500, scale_factor=1.2, n_levels=8)
matcher = BFMatcher(ratio_threshold=0.8, min_matches=8)  # More lenient matching
processor = ImageProcessor(detector=detector, matcher=matcher)

# Hardcoded target image path (using static/assets for web-accessible location)
DEFAULT_TARGET_PATH = os.path.join(os.path.dirname(__file__), 'static', 'assets', 'ranger-base-image.jpg')


def load_default_target():
    """Load the hardcoded default target image on startup."""
    if os.path.exists(DEFAULT_TARGET_PATH):
        target_image = cv2.imread(DEFAULT_TARGET_PATH, cv2.IMREAD_COLOR)
        if target_image is not None:
            success = processor.set_target(target_image)
            if success:
                info = processor.get_target_info()
                print(f"✓ Default target loaded: {info['keypoints_count']} keypoints detected")
                return True
            else:
                print("✗ Failed to extract features from default target image")
        else:
            print(f"✗ Failed to read default target image: {DEFAULT_TARGET_PATH}")
    else:
        print(f"✗ Default target image not found: {DEFAULT_TARGET_PATH}")
    return False


# Load default target on module import
load_default_target()


@app.route('/')
def index():
    """Serve the main HTML page."""
    return render_template('index.html')


@app.route('/status')
def status():
    """Get current processor status."""
    info = processor.get_target_info()
    return jsonify(info)


@socketio.on('connect')
def handle_connect():
    """Handle WebSocket connection."""
    print('Client connected')
    info = processor.get_target_info()
    emit('status', {
        'connected': True, 
        'ready': processor.is_ready(),
        'keypoints': info.get('keypoints_count', 0) if info.get('ready') else 0
    })


@socketio.on('disconnect')
def handle_disconnect():
    """Handle WebSocket disconnection."""
    print('Client disconnected')


@socketio.on('frame')
def handle_frame(data):
    """
    Process incoming video frame with camera intrinsics.
    Returns detection corners + 6DoF pose + debug info for frontend.
    Uses inlier keypoints for robust pose estimation.

    INTRINSICS HANDLING:
    - Frontend computes intrinsics ONCE at camera startup and locks them
    - Frontend sends scaled intrinsics with each frame (scaled for frame resolution)
    - Backend uses these intrinsics directly - does NOT compute its own FOV
    - This ensures frontend camera FOV matches backend pose estimation

    Data format:
    - Simple: base64 string (uses default FOV - not recommended)
    - With intrinsics: {image: base64, intrinsics: {fx, fy, cx, cy, fovHorizontal, fovVertical, width, height, fingerprint}}
    """
    if not processor.is_ready():
        emit('result', {'detected': False})
        return

    try:
        # Parse input data
        frame_data = data
        intrinsics = None
        fov = 60.0  # Fallback default (should rarely be used)

        if isinstance(data, dict):
            # New format with intrinsics
            frame_data = data.get('image', data.get('frame', data))
            intrinsics = data.get('intrinsics')
            if intrinsics:
                # Use horizontal FOV for pose estimation (matches how intrinsics are computed)
                fov = intrinsics.get('fovHorizontal', intrinsics.get('fov', 60.0))
            else:
                fov = data.get('fov', 60.0)

        # Decode base64 image
        if isinstance(frame_data, str):
            if ',' in frame_data:
                frame_data = frame_data.split(',')[1]
            image_bytes = base64.b64decode(frame_data)
        else:
            emit('result', {'detected': False})
            return

        nparr = np.frombuffer(image_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if frame is None:
            emit('result', {'detected': False})
            return

        h, w = frame.shape[:2]

        # CRITICAL: Set camera intrinsics from frontend
        # The frontend has computed these once from the actual camera
        # We use them directly to ensure pose estimation matches renderer FOV
        if intrinsics and intrinsics.get('fx'):
            processor._pose_solver.set_camera_intrinsics(
                fx=intrinsics['fx'],
                fy=intrinsics['fy'],
                cx=intrinsics.get('cx', w / 2),
                cy=intrinsics.get('cy', h / 2)
            )

        # Detect target and get inlier keypoints
        corners, inlier_src, inlier_dst, detected, confidence = processor.detect(frame)
        debug_info = processor.get_debug_info()

        result = {
            'detected': detected,
            'frameSize': [w, h],
            'debug': {
                **debug_info,
                'confidence': confidence
            }
        }

        if detected and corners is not None and inlier_src is not None:
            result['corners'] = corners.reshape(-1, 2).tolist()

            # Map target 2D inliers to 3D world coordinates
            object_points = processor._map_2d_to_3d(inlier_src.reshape(-1, 2))
            image_points = inlier_dst.reshape(-1, 2)

            # Compute 6DoF pose using inlier keypoints with tracking mode
            # Note: fov is only used if intrinsics weren't set above
            pose = processor.compute_pose_6dof(object_points, image_points, w, h, fov)
            if pose:
                result['pose'] = pose
                result['debug']['inliers'] = pose.get('inlier_count', len(object_points))
                result['debug']['state'] = pose.get('state', 'UNKNOWN')
                result['debug']['tracking_confidence'] = pose.get('confidence', 0.0)
                result['debug']['reproj_error'] = pose.get('reproj_error', 0.0)

        emit('result', result)

    except Exception as e:
        print(f"Frame processing error: {e}")
        import traceback
        traceback.print_exc()
        emit('result', {'detected': False})


if __name__ == '__main__':
    print("Starting Target Detection Server...")
    print("Open http://localhost:5000 in your browser")
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
