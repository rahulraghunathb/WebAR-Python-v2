import base64
import logging
import mimetypes
import os
import threading
import time

import cv2
import numpy as np
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit

from src.detectors import ORBDetector
from src.matchers import BFMatcher
from src.processor import ImageProcessor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        # File copy so phone-side diagnostics survive and can be inspected
        logging.FileHandler(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "webar-server.log"),
            encoding="utf-8",
        ),
    ],
)
log = logging.getLogger("webar")

# Initialize Flask app
app = Flask(__name__, static_folder="static", template_folder="static")
app.config["SECRET_KEY"] = os.environ.get("WEBAR_SECRET_KEY", "dev-secret-change-me")

# Use standard threading (eventlet is unused/deprecated with this mode)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Base processor holds the (read-only) target data. Each connected client
# gets a session copy with its own pose-solver state machine so concurrent
# clients cannot corrupt each other's tracking (the old code shared one
# global solver AND broadcast results to every client).
detector = ORBDetector(n_features=800, scale_factor=1.2, n_levels=8)
matcher = BFMatcher(ratio_threshold=0.8, min_matches=8)
base_processor = ImageProcessor(detector=detector, matcher=matcher)

DEFAULT_TARGET_PATH = os.path.join(
    os.path.dirname(__file__), "static", "assets", "ranger-base-image.jpg"
)


def load_default_target():
    # Try loading preprocessed blob first
    blob_path = DEFAULT_TARGET_PATH.replace(".jpg", ".webarimg")
    if os.path.exists(blob_path):
        if base_processor.load_target_blob(blob_path):
            log.info("Preprocessed target loaded: %s", blob_path)
            return True

    # Fallback to standard image loading
    if os.path.exists(DEFAULT_TARGET_PATH):
        target_image = cv2.imread(DEFAULT_TARGET_PATH, cv2.IMREAD_COLOR)
        if target_image is not None:
            base_processor.set_target(target_image)
            log.info("Target image loaded (runtime extraction): %s", DEFAULT_TARGET_PATH)
            return True
    return False


load_default_target()


class ClientSession:
    """Per-client tracking state."""

    def __init__(self, sid: str):
        self.sid = sid
        self.processor = base_processor.create_session_copy()
        self.last_processed_id = 0
        self.last_received_id = 0
        self.drop_count = 0


# sid -> ClientSession
sessions = {}
# sid -> (data, frame_id): latest pending frame per client (newest wins)
pending_frames = {}
state_lock = threading.Lock()
frame_event = threading.Event()


def frame_worker():
    """Single worker: processes the newest pending frame per client."""
    while True:
        frame_event.wait()
        while True:
            with state_lock:
                if not pending_frames:
                    frame_event.clear()
                    break
                sid, (data, frame_id) = pending_frames.popitem()
                session = sessions.get(sid)
            if session is not None:
                process_frame(session, data, frame_id)


threading.Thread(target=frame_worker, daemon=True).start()


@app.route("/")
def index():
    # send_static_file, NOT render_template: index.html has no Jinja in it,
    # and with debug=False Jinja caches the compiled template at first
    # render - the page would be frozen at server-boot content forever.
    return app.send_static_file("index.html")


def _gzip_static(filename):
    """Static serving with precompressed support: if <file>.gz exists and
    the client accepts gzip, serve it with Content-Encoding (the 11MB WASM
    runtime drops to ~3.4MB over the wire). Generate siblings with:
    python -c "import gzip,shutil;..." or the build scripts."""
    if "gzip" in request.headers.get("Accept-Encoding", "").lower():
        gz_path = os.path.join(app.static_folder, filename + ".gz")
        if os.path.isfile(gz_path):
            mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            resp = send_from_directory(
                app.static_folder, filename + ".gz",
                mimetype=mime, conditional=True
            )
            resp.headers["Content-Encoding"] = "gzip"
            resp.headers["Vary"] = "Accept-Encoding"
            return resp
    return app.send_static_file(filename)


# Replace Flask's default static view with the gzip-aware one
app.view_functions["static"] = _gzip_static


@app.route("/status")
def status():
    return jsonify(base_processor.get_target_info())


@app.route("/client-log", methods=["POST"])
def client_log():
    """Remote debugging: phones POST their lifecycle/errors here."""
    data = request.get_json(silent=True) or {}
    log.info("[CLIENT %s] %s | %s",
             request.remote_addr, data.get("stage", "?"), data.get("detail", ""))
    if data.get("ua"):
        log.info("[CLIENT %s] ua: %s", request.remote_addr, data["ua"])
    return "", 204


@socketio.on("connect")
def handle_connect():
    sid = request.sid
    with state_lock:
        sessions[sid] = ClientSession(sid)
    log.info("Client connected: %s", sid)

    info = base_processor.get_target_info()
    emit(
        "status",
        {
            "connected": True,
            "ready": base_processor.is_ready(),
            "keypoints": info.get("keypoints_count", 0) if info.get("ready") else 0,
        },
    )


@socketio.on("disconnect")
def handle_disconnect():
    sid = request.sid
    with state_lock:
        sessions.pop(sid, None)
        pending_frames.pop(sid, None)
    log.info("Client disconnected: %s", sid)


@socketio.on("frame")
def handle_frame(data):
    sid = request.sid

    # Handle both dict and raw data
    frame_id = data.get("id", 0) if isinstance(data, dict) else 0
    frame_id = frame_id or 0

    with state_lock:
        session = sessions.get(sid)
        if session is None:
            return
        if frame_id > 0 and frame_id <= session.last_received_id:
            return  # Stale (out-of-order) frame
        if sid in pending_frames:
            session.drop_count += 1  # Overwriting an unprocessed frame
        pending_frames[sid] = (data, frame_id)
        if frame_id > 0:
            session.last_received_id = frame_id
    frame_event.set()


def process_frame(session: ClientSession, data, frame_id):
    if frame_id > 0 and frame_id < session.last_processed_id:
        return

    try:
        start_time = time.time()
        processor = session.processor

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
            _, encoded = encoded_data.split(",", 1)
        else:
            encoded = encoded_data

        nparr = np.frombuffer(base64.b64decode(encoded), np.uint8)
        # Decode straight to grayscale: ORB only needs luminance and this
        # skips a per-frame BGR->gray conversion.
        frame = cv2.imdecode(nparr, cv2.IMREAD_GRAYSCALE)
        if frame is None:
            return

        h, w = frame.shape[:2]

        if intrinsics and intrinsics.get("fx"):
            processor.set_camera_intrinsics(
                fx=intrinsics["fx"],
                fy=intrinsics["fy"],
                cx=intrinsics.get("cx", w / 2),
                cy=intrinsics.get("cy", h / 2),
            )

        corners, inlier_src, inlier_dst, detected, confidence = processor.detect(frame)

        result = {
            "detected": detected,
            "id": frame_id,
            "frameSize": [w, h],
            "debug": {
                **processor.get_debug_info(),
                "confidence": confidence,
                "queue_drops": session.drop_count,
                "proc_ms": int((time.time() - start_time) * 1000),
            },
        }

        if detected and corners is not None and inlier_src is not None:
            result["corners"] = corners.reshape(-1, 2).tolist()

            pose = processor.estimate_pose(inlier_src, inlier_dst, w, h)
            if pose:
                # Frame id rides along with the pose so the frontend can match
                # it to the IMU snapshot taken when this frame was captured.
                pose["id"] = frame_id
                result["pose"] = pose
                result["debug"]["tracking_state"] = pose.get("state")
                result["debug"]["tracking_confidence"] = pose.get("confidence")
        else:
            # CRITICAL: drive the tracking state machine on misses too,
            # otherwise a stale pose prior survives forever and poisons
            # re-acquisition when the target reappears.
            processor.notify_no_detection()

        if frame_id > 0:
            session.last_processed_id = frame_id

        # Emit only to the client that sent the frame (never broadcast).
        socketio.emit("result", result, to=session.sid)

        if detected:
            log.debug("[%s] DETECTED - %dms", frame_id, result["debug"]["proc_ms"])

    except Exception:
        log.exception("Frame processing error")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(
        app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True
    )
