# WebAR SDK - System Design Document (legacy server-tracking mode)

> **NOTE:** The product has moved to client-side WASM tracking — see
> **ARCHITECTURE.md** for the current architecture. This document describes
> the original server-side pipeline, which is preserved as a fallback at
> `/static/legacy-server.html` and as the reference implementation for the
> client-side port.

## Overview

A Python + Three.js WebAR SDK for real-time image target detection and 6DoF AR model rendering. The system captures video frames from the browser, sends them to a Python backend for ORB-based feature detection, and renders 3D models overlaid on detected targets.

---

## Architecture Diagram

```
+------------------------------------------------------------------+
|                        CLIENT (Browser)                           |
+------------------------------------------------------------------+
|                                                                   |
|  +-------------+    +------------+    +------------------+        |
|  | Camera.js   |--->| index.html |--->| WebSocket.js     |        |
|  | getUserMedia|    | (App class)|    | Socket.IO client |        |
|  +-------------+    +-----+------+    +--------+---------+        |
|                           |                    |                  |
|                           v                    |                  |
|  +-------------+    +-------------+            |                  |
|  | outputCanvas|    | threeCanvas |            |                  |
|  | (2D overlay)|    | (3D model)  |            |                  |
|  +-------------+    +-------------+            |                  |
|        ^                  ^                    |                  |
|        |                  |                    |                  |
|  +-----+------------------+--------------------+                  |
|  |         ModelRenderer.js (Three.js)        |                  |
|  +--------------------------------------------+                  |
+------------------------------------------------------------------+
                              | WebSocket (Socket.IO)
                              v
+------------------------------------------------------------------+
|                      SERVER (Python/Flask)                        |
+------------------------------------------------------------------+
|  +------------------------------------------------------------+  |
|  |                        app.py                               |  |
|  |  Flask + Flask-SocketIO                                     |  |
|  |  Handles: WebSocket events, frame processing, responses     |  |
|  +-----------------------------+------------------------------+  |
|                                |                                  |
|                                v                                  |
|  +-----------------------------+------------------------------+  |
|  |                     processor.py                            |  |
|  |  ImageProcessor: Multi-scale ORB detection pipeline         |  |
|  +-----------------------------+------------------------------+  |
|              |                 |                 |                |
|              v                 v                 v                |
|  +------------+    +------------+    +------------------+        |
|  | ORBDetector|    | BFMatcher  |    | PoseSolver       |        |
|  | (features) |    | (matching) |    | (6DoF solvePnP)  |        |
|  +------------+    +------------+    +------------------+        |
+------------------------------------------------------------------+
```

---

## Project Structure

```
WebAR-Python/
├── app.py                      # Flask server + WebSocket handlers (ENTRY POINT)
├── requirements.txt            # Python dependencies
├── BUILD.md                    # Build/setup documentation
├── SYSTEM_DESIGN.md            # This document
│
├── preprocess_target.py        # Offline target feature extraction (.webarimg)
│
├── src/                        # Python backend modules
│   ├── __init__.py
│   ├── interfaces.py           # Abstract interfaces (ISP pattern)
│   ├── processor.py            # Core detection engine (ImageProcessor)
│   ├── pose_solver.py          # 6DoF pose estimation (PoseSolver)
│   │
│   ├── detectors/              # Feature extraction strategies
│   │   ├── orb_detector.py     # ORB detector (USED)
│   │   └── akaze_detector.py   # AKAZE detector (available, not default)
│   │
│   └── matchers/               # Feature matching strategies
│       ├── bf_matcher.py       # Brute-Force matcher (USED)
│       └── flann_matcher.py    # FLANN matcher (available, not default)
│
├── static/                     # Frontend assets
│   ├── index.html              # Main AR viewer (contains App class inline)
│   ├── model-editor.html       # Simple 3D model position editor
│   │
│   ├── alignment-tool/         # Advanced alignment tool
│   │   ├── index.html
│   │   ├── alignment.js
│   │   └── styles.css
│   │
│   ├── assets/
│   │   ├── ranger-base-image.jpg      # Target image
│   │   ├── ranger-base-image.webarimg # Preprocessed target features
│   │   └── ranger-3d-model.glb        # 3D model
│   │
│   └── js/
│       ├── camera.js           # Camera access wrapper
│       ├── camera-intrinsics.js # FOV / intrinsics management
│       ├── device-motion.js    # IMU (orientation) manager
│       ├── websocket.js        # WebSocket client
│       ├── model-renderer.js   # Three.js 3D rendering + smoothing
│       ├── frame-capture.js    # (future) raw-pixel capture for WASM path
│       └── vision-manager.js   # (future) client-side vision abstraction
│
└── tests/
    ├── test_detector.py        # Detector/matcher/processor unit tests
    └── test_pose_solver.py     # State machine + session isolation tests
```

---

## Core Components

### 1. ImageProcessor (processor.py)

The main detection engine implementing multi-scale ORB feature matching.

**Key Features:**
- Multi-scale pyramid detection: `[1.0, 0.5, 0.3]` (sparse; ORB's internal
  pyramid covers intermediate scales)
- RANSAC-based homography with validation
- Strict quad geometry validation (area, convexity, angles)
- `create_session_copy()`: per-client state sharing read-only target data

**Detection Flow:**
```
set_target(image) -> build pyramid -> store keypoints/descriptors
         |
detect(frame) -> extract ORB -> match each scale -> RANSAC homography
         |                                               |
         v                                               v
    validate_quad() <------ compute reprojection error
         |
         v
    extract inlier keypoints from RANSAC mask
         |
         v
    return corners, inlier_src, inlier_dst, detected, confidence
```

**Inlier-Based Pose Estimation:**
- Uses all inlier keypoints (8-20+ points) instead of just 4 corners
- `_map_2d_to_3d()` converts target image pixels to 3D world coordinates
- `compute_pose_6dof()` delegates to `solvePnPRansac` for robust pose

### 2. PoseSolver (pose_solver.py)

6DoF pose estimation using OpenCV's solvePnP, with a tracking state machine
(SEARCHING → TRACKING → LOST → SEARCHING).

**Key Features:**
- `compute_pose_ransac()` uses solvePnPRansac with N inlier points
  (SOLVEPNP_IPPE for initial planar detection, ITERATIVE+prior when tracking)
- `notify_no_detection()` MUST be called on missed frames so the state
  machine decays and stale pose priors are discarded
- NO backend smoothing: the frontend renderer owns all temporal smoothing
  (stacked smoothing on both ends was a major source of lag)
- One PoseSolver per client session (see `ImageProcessor.create_session_copy`)
- OpenCV to Three.js coordinate conversion

**Coordinate Conversion:**
```
OpenCV:  X-right, Y-down, Z-forward
Three.js: X-right, Y-up, Z-backward

Transformation:
flip_yz = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
```

### 3. ModelRenderer (model-renderer.js)

Three.js-based AR rendering with a perspective camera driven by the 6DoF pose.

**Key Features:**
- Single time-based smoothing stage (`alpha = 1 - exp(-dt/tau)`) run at
  render rate toward the latest ~12Hz vision pose
- IMU rotation prediction between vision updates (baseline synced per
  frame id via `pose.id`)
- Dead-reckon grace window (500ms) before the model hides on tracking loss
- FOV corrected for the `object-fit: cover` crop of the video element
- GLB model loading with auto-centering and scaling

---

## Data Flow

```
1. CAPTURE (camera.js)
   Camera.start() -> getUserMedia() -> video element

2. SEND (index.html App class)
   video -> reused canvas -> JPEG 50% -> base64 -> socket.emit('frame')
   Throttled: ~12 FPS, downscaled to 480px max dimension
   IMU quaternion snapshotted per frame id for later sync

3. DETECT (app.py -> processor.py, per-session processor)
   Base64 decode (grayscale) -> ImageProcessor.detect()
   Returns: corners, inlier correspondences, detected, confidence
   On miss: processor.notify_no_detection() (drives state machine decay)

4. POSE (app.py -> pose_solver.py)
   inliers -> ImageProcessor.estimate_pose() -> solvePnP (raw, unsmoothed)
   Returns: 4x4 matrix, position, rotation, distance, state, confidence

5. RESPOND (app.py)
   socket.emit('result', {...}, to=session.sid)   # per-client, no broadcast
   pose carries the frame id for IMU sync

6. RENDER (index.html -> model-renderer.js)
   updatePose() records the target pose; render() smooths toward it at
   display rate (time-based alpha) + IMU rotation prediction in between
```

---

## WebSocket API

### Client -> Server

```javascript
socket.emit('frame', {
    frame: 'data:image/jpeg;base64,...',  // or just base64 string
    fov: 60.0  // optional camera FOV
});
```

### Server -> Client

```javascript
socket.on('result', {
    detected: boolean,
    frameSize: [width, height],
    corners: [[x,y], [x,y], [x,y], [x,y]],  // 4 corners in video coords
    confidence: float,  // 0-1
    pose: {
        matrix: [16 floats],  // Column-major 4x4 for Three.js
        position: {x, y, z},  // In meters
        rotation: {x, y, z},  // In degrees
        distance: float,      // Camera-to-target distance
        camera_matrix: {fx, fy, cx, cy}
    },
    debug: {
        keypoints: int,
        good_matches: int,
        inliers: int,
        scale_used: float,
        state: 'DETECTED' | 'NO_DETECTION'
    }
});

socket.on('status', {
    connected: boolean,
    ready: boolean,
    keypoints: int
});
```

---

## Identified Issues (Resolved)

### 1. Duplicate Assets - FIXED
- ~~`src/assets/` and `static/assets/` contained identical files~~
- **Resolution:** Removed `src/assets/`, updated app.py to use `static/assets/`

### 2. Unused Code - FIXED
| File | Status | Action |
|------|--------|--------|
| `static/js/app.js` | REMOVED | Was duplicate of index.html inline App class |
| `static/css/styles.css` | REMOVED | Was unused, styles are inline in index.html |
| `src/trackers/optical_flow_tracker.py` | KEPT | Available for future use |
| `src/stabilizers/kalman_stabilizer.py` | KEPT | Available for future use |
| `src/renderers/contour_renderer.py` | KEPT | Available for future use |

### 3. Duplicate Functionality - NOTED
- `model-editor.html` overlaps with `alignment-tool/`
- Both provide 3D model positioning, alignment-tool is more complete
- Consider consolidating in future refactor

### 4. Unused Dependencies in ImageProcessor - FIXED
- Removed unused `drawer` and `stabilizer` parameters from ImageProcessor constructor
- These modules are kept available for future integration if needed

---

## Improvement Suggestions

### High Priority

1. **Consolidate Assets**
   - Remove duplicate `src/assets/` directory
   - Use only `static/assets/` which is web-accessible

2. **Clean Up Unused Files**
   - Remove `static/js/app.js` (unused duplicate)
   - Remove `static/css/styles.css` (unused, styles are inline)
   - Consider removing or marking optical_flow_tracker as experimental

3. **Fix ImageProcessor Interface**
   - Either integrate stabilizer/drawer or remove from constructor
   - Current code creates but ignores these components

### Medium Priority

4. **Client-Side Processing Option**
   - Consider WebAssembly/TensorFlow.js for client-side detection
   - Would reduce latency and server load

5. **Improve Pose Stability**
   - Implement quaternion SLERP for rotation smoothing
   - Current linear interpolation can cause issues near gimbal lock

6. **Add Error Handling**
   - WebSocket reconnection with exponential backoff
   - Graceful degradation when detection fails repeatedly

### Low Priority

7. **Consolidate Model Editors**
   - Merge `model-editor.html` into `alignment-tool/`
   - One comprehensive tool instead of two partial ones

8. **Add TypeScript**
   - Type safety for frontend code
   - Better IDE support and refactoring

9. **Add Integration Tests**
   - End-to-end tests with mock video frames
   - WebSocket communication tests

---

## Configuration Reference

### Detection Thresholds (processor.py)
```python
SCALES = [1.0, 0.5, 0.3]             # Sparse external pyramid (ORB's internal
                                     # 8-level pyramid covers intermediates)
MIN_MATCHES = 10                     # Minimum feature matches
MIN_INLIERS_BASE = 8                 # Minimum RANSAC inliers
RANSAC_THRESH = 4.0                  # RANSAC reprojection threshold (pixels)
MIN_INLIER_RATIO = 0.40              # Minimum inlier/match ratio
MIN_INLIER_RATIO_SMALL = 0.50        # Stricter for small scales
```

### Pose Estimation (pose_solver.py)
```python
MIN_INLIERS_DETECT = 8               # Inliers for initial detection
MIN_INLIERS_TRACK = 6                # Inliers to maintain tracking
MAX_REPROJ_ERROR = 5.0               # Max reprojection error (pixels)
LOST_FRAME_THRESHOLD = 5             # Missed frames before SEARCHING
# No backend smoothing - the frontend renderer owns it.
```

### Frame Processing (index.html / model-renderer.js)
```javascript
sendInterval = 80                    // ms between frames (~12 FPS to backend)
jpegQuality = 0.5                    // JPEG compression for transport
maxDimension = 480                   // Downscale to 480px
positionTau = 0.12                   // Position smoothing time constant (s)
rotationTau = 0.10                   // Rotation smoothing time constant (s)
deadReckonLimit = 500                // ms to coast on IMU after vision loss
```

---

## Technology Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Backend Framework | Flask | 3.0+ |
| WebSocket | Flask-SocketIO (threading) + simple-websocket | 5.3+ |
| Computer Vision | OpenCV | 4.11+ |
| Frontend 3D | Three.js | 0.128 |
| Transport | Socket.IO | 4.6 |
| Model Format | glTF/GLB | 2.0 |

---

## Running the Application

```bash
# Install dependencies
cd WebAR-Python
python -m venv venv
venv\Scripts\activate  # Windows
pip install -r requirements.txt

# Run locally
python app.py
# Open http://localhost:5000

# For mobile (HTTPS required for camera access)
ngrok http 5000
# Use the https:// URL
```

---

## Cleanup Summary

### Files Removed:
- `src/assets/` - duplicate of static/assets (DELETED)
- `static/js/app.js` - unused duplicate (DELETED)
- `static/css/styles.css` - unused (DELETED)
- `static/css/` - empty directory (DELETED)

### Code Refactored:
- `app.py` - removed unused imports (ContourRenderer, KalmanStabilizer)
- `app.py` - simplified ImageProcessor instantiation
- `app.py` - updated target path to use static/assets/
- `processor.py` - removed unused drawer/stabilizer parameters
- `tests/test_detector.py` - updated to match new ImageProcessor signature

### Files Kept for Future Use:
- `src/detectors/akaze_detector.py` / `src/matchers/flann_matcher.py` -
  alternative strategies, not wired by default
- `model-editor.html` - simpler alternative to alignment-tool

(`frame-capture.js`/`vision-manager.js` were removed - superseded by the
real client-side SDK in `static/sdk/`.)
