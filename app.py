import base64
import os
import threading
import time
from collections import deque
from typing import Dict, Optional, Tuple

import cv2
import numpy as np
from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO, emit

from src.detectors import ORBDetector
from src.matchers import BFMatcher
from src.processor import ImageProcessor

app = Flask(__name__, static_folder="static", template_folder="static")
app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY", "target-detection-secret-key")

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

DEFAULT_TARGET_PATH = os.path.join(
    os.path.dirname(__file__), "static", "assets", "ranger-base-image.jpg"
)
DEFAULT_TARGET_BLOB_PATH = DEFAULT_TARGET_PATH.replace(".jpg", ".webarimg")

SESSION_LOCK = threading.Lock()
SESSIONS: Dict[str, "ClientSession"] = {}


def create_processor() -> ImageProcessor:
    detector = ORBDetector(n_features=800, scale_factor=1.2, n_levels=8)
    matcher = BFMatcher(ratio_threshold=0.8, min_matches=8)
    processor = ImageProcessor(detector=detector, matcher=matcher)
    if not load_default_target(processor):
        raise RuntimeError("Target image could not be loaded")
    return processor


def load_default_target(processor: ImageProcessor) -> bool:
    if os.path.exists(DEFAULT_TARGET_BLOB_PATH) and processor.load_target_blob(
        DEFAULT_TARGET_BLOB_PATH
    ):
        print(f"[Target] Preprocessed target loaded: {DEFAULT_TARGET_BLOB_PATH}")
        return True

    if os.path.exists(DEFAULT_TARGET_PATH):
        target_image = cv2.imread(DEFAULT_TARGET_PATH, cv2.IMREAD_COLOR)
        if target_image is not None:
            if processor.set_target(target_image):
                print(f"[Target] Target image loaded: {DEFAULT_TARGET_PATH}")
                return True
    return False


try:
    TEMPLATE_PROCESSOR = create_processor()
    TARGET_INFO = TEMPLATE_PROCESSOR.get_target_info()
except Exception as exc:
    TEMPLATE_PROCESSOR = None
    TARGET_INFO = {"ready": False, "error": str(exc)}
    print(f"[Target] Failed to initialize template processor: {exc}")


class ClientSession:
    def __init__(self, sid: str):
        self.sid = sid
        self.frame_queue = deque(maxlen=1)
        self.frame_event = threading.Event()
        self.queue_lock = threading.Lock()
        self.last_processed_id = 0
        self.last_received_id = 0
        self.queue_drop_count = 0
        self.active = True
        self.worker = None
        self.processor: Optional[ImageProcessor] = None
        self.ready = False
        self.error: Optional[str] = None

        try:
            self.processor = create_processor()
            self.ready = self.processor.is_ready()
        except Exception as exc:
            self.error = str(exc)
            self.ready = False
            print(f"[Session:{sid}] Initialization failed: {exc}")

        if self.ready:
            self.worker = threading.Thread(target=self._frame_worker, daemon=True)
            self.worker.start()

    def get_status_payload(self) -> Dict:
        pose_status = self.processor.get_pose_status() if self.processor else {}
        keypoints = 0
        if self.processor and self.processor.is_ready():
            info = self.processor.get_target_info()
            keypoints = info.get("keypoints_count", 0)

        return {
            "connected": True,
            "ready": self.ready,
            "keypoints": keypoints,
            "tracking_state": pose_status.get("tracking_state", "SEARCHING"),
            "error": self.error,
        }

    def close(self) -> None:
        self.active = False
        self.frame_event.set()

    def enqueue_frame(self, data) -> None:
        if not self.ready or not self.processor:
            return

        frame_id = data.get("id", 0) if isinstance(data, dict) else 0

        with self.queue_lock:
            if frame_id > 0 and frame_id <= self.last_processed_id:
                return
            if frame_id > 0 and frame_id <= self.last_received_id:
                return
            if len(self.frame_queue) == self.frame_queue.maxlen:
                self.queue_drop_count += 1
            self.frame_queue.append((data, frame_id))
            if frame_id > 0:
                self.last_received_id = frame_id
        self.frame_event.set()

    def _frame_worker(self) -> None:
        while self.active or self.frame_queue:
            self.frame_event.wait()
            while True:
                with self.queue_lock:
                    if not self.frame_queue:
                        self.frame_event.clear()
                        break
                    data, frame_id = self.frame_queue.pop()
                self._process_frame(data, frame_id)

    def _extract_frame_payload(self, data) -> Tuple[Optional[str], Optional[Dict]]:
        if isinstance(data, dict):
            return data.get("image") or data.get("frame"), data.get("intrinsics")
        return data, None

    def _decode_frame(self, encoded_data: str) -> Optional[np.ndarray]:
        if not encoded_data:
            return None
        if "," in encoded_data:
            _, encoded = encoded_data.split(",", 1)
        else:
            encoded = encoded_data
        nparr = np.frombuffer(base64.b64decode(encoded), np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    def _process_frame(self, data, frame_id: int) -> None:
        if not self.processor:
            return

        with self.queue_lock:
            if frame_id > 0 and frame_id < self.last_processed_id:
                return

        start_time = time.time()

        try:
            encoded_data, intrinsics = self._extract_frame_payload(data)
            frame = self._decode_frame(encoded_data)
            if frame is None:
                return

            height, width = frame.shape[:2]

            if intrinsics and intrinsics.get("fx"):
                self.processor.set_camera_intrinsics(
                    fx=intrinsics["fx"],
                    fy=intrinsics["fy"],
                    cx=intrinsics.get("cx", width / 2),
                    cy=intrinsics.get("cy", height / 2),
                    frame_width=intrinsics.get("width"),
                    frame_height=intrinsics.get("height"),
                )

            corners, inlier_src, inlier_dst, detected, confidence = self.processor.detect(frame)
            if not detected:
                self.processor.notify_no_detection()

            pose_status = self.processor.get_pose_status()
            result = {
                "detected": detected,
                "id": frame_id,
                "frameSize": [width, height],
                "debug": {
                    **self.processor.get_debug_info(),
                    **pose_status,
                    "confidence": confidence,
                    "queue_drops": self.queue_drop_count,
                    "proc_ms": int((time.time() - start_time) * 1000),
                },
            }

            if detected and corners is not None and inlier_src is not None and inlier_dst is not None:
                result["corners"] = corners.reshape(-1, 2).tolist()
                object_points = self.processor.map_2d_to_3d(inlier_src.reshape(-1, 2))
                image_points = inlier_dst.reshape(-1, 2)
                pose = self.processor.compute_pose_ransac(
                    object_points, image_points, width, height
                )
                if pose:
                    pose["id"] = frame_id
                    result["pose"] = pose
                    result["debug"]["tracking_state"] = pose.get("state")
                    result["debug"]["tracking_confidence"] = pose.get("confidence")

            if frame_id > 0:
                with self.queue_lock:
                    self.last_processed_id = max(self.last_processed_id, frame_id)

            socketio.emit("result", result, to=self.sid)
        except Exception as exc:
            print(f"[Session:{self.sid}] Frame processing error: {exc}")
            socketio.emit(
                "error",
                {"message": str(exc), "id": frame_id},
                to=self.sid,
            )


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/status")
def status():
    return jsonify(TARGET_INFO)


@socketio.on("connect")
def handle_connect():
    sid = request.sid
    session = ClientSession(sid)

    with SESSION_LOCK:
        old_session = SESSIONS.pop(sid, None)
        if old_session:
            old_session.close()
        SESSIONS[sid] = session

    print(f"[Socket] Client connected: {sid}")
    emit("status", session.get_status_payload())


@socketio.on("disconnect")
def handle_disconnect():
    sid = request.sid
    with SESSION_LOCK:
        session = SESSIONS.pop(sid, None)
    if session:
        session.close()
    print(f"[Socket] Client disconnected: {sid}")


@socketio.on("frame")
def handle_frame(data):
    sid = request.sid
    with SESSION_LOCK:
        session = SESSIONS.get(sid)

    if not session:
        session = ClientSession(sid)
        with SESSION_LOCK:
            SESSIONS[sid] = session

    if not session.ready:
        emit(
            "error",
            {"message": session.error or "Session is not ready"},
            to=sid,
        )
        return

    session.enqueue_frame(data)


if __name__ == "__main__":
    socketio.run(
        app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True
    )
