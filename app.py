import base64
import os
import time
import threading
from collections import deque

import cv2
import numpy as np
from flask import Flask, render_template, jsonify
from flask_socketio import SocketIO, emit

from src.detectors import ORBDetector
from src.matchers import BFMatcher
from src.processor import ImageProcessor

# Initialize Flask app
app = Flask(__name__, static_folder="static", template_folder="static")
app.config["SECRET_KEY"] = "target-detection-secret-key"

# Use standard threading for better compatibility with ThreadPoolExecutor
# Force 'threading' to avoid eventlet conflicts
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Single-worker frame queue (latest frame wins)
frame_queue = deque(maxlen=1)
frame_event = threading.Event()
queue_lock = threading.Lock()
last_processed_id = 0
last_received_id = 0
queue_drop_count = 0

# Create processor
detector = ORBDetector(n_features=800, scale_factor=1.2, n_levels=8)
matcher = BFMatcher(ratio_threshold=0.8, min_matches=8)
processor = ImageProcessor(detector=detector, matcher=matcher)

DEFAULT_TARGET_PATH = os.path.join(
    os.path.dirname(__file__), "static", "assets", "ranger-base-image.jpg"
)


def load_default_target():
    # Try loading preprocessed blob first
    blob_path = DEFAULT_TARGET_PATH.replace(".jpg", ".webarimg")
    if os.path.exists(blob_path):
        if processor.load_target_blob(blob_path):
            print(f"✓ Preprocessed target loaded: {blob_path}")
            return True

    # Fallback to standard image loading
    if os.path.exists(DEFAULT_TARGET_PATH):
        target_image = cv2.imread(DEFAULT_TARGET_PATH, cv2.IMREAD_COLOR)
        if target_image is not None:
            processor.set_target(target_image)
            print(f"✓ Target image loaded (runtime extraction): {DEFAULT_TARGET_PATH}")
            return True
    return False


load_default_target()


def frame_worker():
    while True:
        frame_event.wait()
        while True:
            with queue_lock:
                if not frame_queue:
                    frame_event.clear()
                    break
                data, frame_id = frame_queue.pop()
            process_frame(data, frame_id)


threading.Thread(target=frame_worker, daemon=True).start()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/status")
def status():
    return jsonify(processor.get_target_info())


@socketio.on("connect")
def handle_connect():
    print("Client connected")
    info = processor.get_target_info()
    emit(
        "status",
        {
            "connected": True,
            "ready": processor.is_ready(),
            "keypoints": info.get("keypoints_count", 0) if info.get("ready") else 0,
        },
    )


@socketio.on("frame")
def handle_frame(data):
    global last_processed_id, last_received_id, queue_drop_count

    # Handle both dict and raw data
    frame_id = data.get("id", 0) if isinstance(data, dict) else 0

    with queue_lock:
        if frame_id > 0 and frame_id <= last_processed_id:
            return
        if frame_id > 0 and frame_id <= last_received_id:
            return
        if len(frame_queue) == frame_queue.maxlen:
            queue_drop_count += 1
        frame_queue.append((data, frame_id))
        if frame_id > 0:
            last_received_id = frame_id
    frame_event.set()


def process_frame(data, frame_id):
    global last_processed_id, queue_drop_count

    with queue_lock:
        if frame_id > 0 and frame_id < last_processed_id:
            return

    try:
        start_time = time.time()

        # Extract image data
        if isinstance(data, dict):
            encoded_data = data.get("image") or data.get("frame")
            intrinsics = data.get("intrinsics")
        else:
            encoded_data = data
            intrinsics = None

        if not encoded_data:
            return

        if "," in encoded_data:
            header, encoded = encoded_data.split(",", 1)
        else:
            encoded = encoded_data

        nparr = np.frombuffer(base64.b64decode(encoded), np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            return

        h, w = frame.shape[:2]

        if intrinsics and intrinsics.get("fx"):
            processor.set_camera_intrinsics(
                fx=intrinsics["fx"],
                fy=intrinsics["fy"],
                cx=intrinsics.get("cx", w / 2),
                cy=intrinsics.get("cy", h / 2),
                frame_width=intrinsics.get("width"),
                frame_height=intrinsics.get("height"),
            )

        corners, inlier_src, inlier_dst, detected, confidence = processor.detect(frame)

        result = {
            "detected": detected,
            "id": frame_id,
            "frameSize": [w, h],
            "debug": {
                **processor.get_debug_info(),
                "confidence": confidence,
                "queue_drops": queue_drop_count,
                "proc_ms": int((time.time() - start_time) * 1000),
            },
        }

        if detected and corners is not None and inlier_src is not None:
            result["corners"] = corners.reshape(-1, 2).tolist()
            object_points = processor.map_2d_to_3d(inlier_src.reshape(-1, 2))
            image_points = inlier_dst.reshape(-1, 2)

            # Fix: PoseSolver uses 'compute_pose_ransac' instead of 'solve'
            pose = processor.compute_pose_ransac(object_points, image_points, w, h)
            if pose:
                result["pose"] = pose
                result["debug"]["tracking_state"] = pose.get("state")
                result["debug"]["tracking_confidence"] = pose.get("confidence")

        if frame_id > 0:
            with queue_lock:
                last_processed_id = frame_id
        socketio.emit("result", result)

        if detected:
            print(f"[{frame_id}] DETECTED - {result['debug']['proc_ms']}ms")
        elif frame_id % 10 == 0:
            print(f"[{frame_id}] NO_DETECTION - {result['debug']['proc_ms']}ms")

    except Exception as e:
        print(f"Async Error: {e}")


if __name__ == "__main__":
    socketio.run(
        app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True
    )
