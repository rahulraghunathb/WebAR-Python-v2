# WebAR Image Target SDK - Architecture & Build Documentation

A Python + Three.js WebAR SDK for real-time image target detection, 6DoF pose estimation, and IMU-assisted rendering.

---

## System Architecture (Current Implementation)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (Browser)                                   │
├────────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌────────────────────────────────┐    │
│  │ Camera.js    │───▶│  WebARApp    │───▶│     WebSocket.js               │    │
│  │ (Stream)     │    │ (Orchestr.) │    │  (Frame + Intrinsics → Srv)    │    │
│  └──────────────┘    └──────────────┘    └────────────────────────────────┘    │
│         │                   │                           │                      │
│         ▼                   ▼                           ▼                      │
│  ┌──────────────┐    ┌───────────────┐    ┌────────────────────────────────┐   │
│  │ DeviceMotion │    │  Three.js     │    │   ModelRenderer.js            │   │
│  │ (IMU Fusion) │◀──▶│ (6DoF Canvas) │◀──▶│  (Pose + IMU 6DoF Rendering)   │   │
│  └──────────────┘    └───────────────┘    └────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────┘
                                    │ Socket.IO
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                           SERVER (Python/Flask)                                 │
├────────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────────────────┐    │
│  │                            app.py                                       │    │
│  │  Socket.IO (threading): receive frame → process → emit pose + corners   │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
│                                    │                                           │
│                                    ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────┐    │
│  │                         processor.py                                   │    │
│  │  Multi-scale ORB detection + homography + geometry validation           │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
│         │                    │                    │                            │
│         ▼                    ▼                    ▼                            │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────────────┐             │
│  │ ORBDetector │      │  BFMatcher  │      │     PoseSolver      │             │
│  │ (Features)  │      │ (Matching)  │      │ (solvePnP + 6DoF)    │             │
│  └─────────────┘      └─────────────┘      └─────────────────────┘             │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Data Flow (Current)

### 1. Camera + Permissions
- `CameraIntrinsicsManager` requests camera permission and caches device info.
- `CameraManager` starts the stream and provides native resolution.
- Intrinsics are initialized **once** from device FOV heuristics and locked.
- Motion permission is requested on user gesture (iOS requirement).

### 2. Frame Capture → Transport
- `WebARApp` captures frames in `static/index.html`.
- Frames are **downscaled to max 480px**, encoded as **JPEG (quality 0.5)**.
- Intrinsics are **scaled** to the downscaled frame size and sent with each frame.
- Frames are sent ~every **80ms** (~12 FPS) via Socket.IO.
- Each frame includes a timestamp-based `id` for IMU/vision alignment.

### 3. Detection (Server)
- `app.py` decodes Base64 JPEG → OpenCV frame.
- Intrinsics are applied per frame when provided; otherwise FOV fallback is used.
- `ImageProcessor.detect()` runs multi-scale ORB + homography + quad validation.
- Processing is executed on a `ThreadPoolExecutor(max_workers=1)` to avoid backlog.

### 4. Pose Estimation (Server)
- Inlier matches are mapped to 3D target points (planar target).
- `PoseSolver.compute_pose_ransac()` runs `solvePnPRansac` with tracking state machine.
- OpenCV coordinates are converted to Three.js (Y-up, Z-back).
- On tracking loss, the backend returns `None` to avoid a “stuck” model.

### 5. Rendering + IMU Fusion (Client)
- `ModelRenderer` treats the **target as world origin**; camera moves per pose.
- IMU samples are time-aligned using **frame IDs** for smoothing and prediction.
- Dead-reckoning uses IMU for rotation and limited translation between vision updates.

---

## Vision Processing Components

### ImageProcessor (`src/processor.py`)
- Multi-scale target pyramid: `[1.0, 0.75, 0.5, 0.4, 0.3]`.
- RANSAC homography with geometry validation (area, convexity, edges, angles).
- Inlier ratio thresholds to reduce false positives.
- Physical target size is derived from the target image aspect ratio.

### PoseSolver (`src/pose_solver.py`)
- Tracking state machine: `SEARCHING → DETECTING → TRACKING → LOST`.
- Uses extrinsic guess for fast tracking updates.
- Converts OpenCV to Three.js using a flip matrix and returns column-major matrices.

### Detectors / Matchers
- `ORBDetector` for feature detection (default: `n_features=800` in `app.py`).
- `BFMatcher` for binary descriptor matching (ratio test, default `ratio=0.8`).
- Alternative detectors/matchers exist (`AKAZE`, `FLANN`) but are not wired by default.

---

## Frontend Components

### Core Orchestrator (`static/index.html`)
- `WebARApp` manages permissions, camera, WebSocket, and render loop.
- UI includes a live info panel and tracking badge.
- Frame sender includes IMU baseline capture for sync.

### Camera Intrinsics (`static/js/camera-intrinsics.js`)
- FOV is derived from a device heuristic database.
- Intrinsics are **scaled** for downsampled frames to preserve FOV.

### IMU (`static/js/device-motion.js`)
- Captures orientation and linear acceleration.
- Provides delta rotation for smoothing and short-term prediction.

### Renderer (`static/js/model-renderer.js`)
- Model is normalized to fit ~0.5m and aligned to the target plane.
- Camera pose uses 4x4 matrix from backend (column-major).
- IMU prediction keeps rotation smooth between vision frames.

### Vision Manager (Scaffolded, Not Wired)
- `static/js/vision-manager.js` and `frame-capture.js` provide a future pipeline
  for raw grayscale and client-side WASM. The current flow still uses
  JPEG/Base64 from `index.html`.

---

## Project Structure

```
WebAR-Python-Bhavin/
├── app.py                          # Flask server + Socket.IO
├── preprocess_target.py            # Offline target preprocessing
├── requirements.txt                # Python dependencies
├── BUILD.md                        # Documentation
├── SYSTEM_DESIGN.md                # Technical design details
├── tests/                          # Unit tests (detector + matcher)
│
├── src/
│   ├── processor.py                # Core detection engine
│   ├── pose_solver.py              # 6DoF pose estimation + tracking
│   ├── interfaces.py               # Interfaces
│   ├── detectors/                  # ORB + AKAZE
│   └── matchers/                   # BF + FLANN
│
└── static/
    ├── index.html                  # Main WebAR viewer
    ├── model-editor.html           # 3D model adjustment tool
    ├── alignment-tool/             # Physical-to-virtual alignment tool
    ├── assets/                     # Target + model assets
    └── js/                         # Camera, WebSocket, intrinsics, IMU, renderer
```

---

## Setup & Running

### 1. Environment Setup

```bash
python -m venv venv
# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt
```

### 2. Run Locally

```bash
python app.py
# Open http://localhost:5000
```

### 3. Mobile Access (HTTPS Required)

```bash
# In a new terminal
ngrok http 5000
# Use the https://...ngrok.io URL on your phone
```

Notes:
- Socket.IO runs in **threading** mode for compatibility with CPU-bound work.
- `eventlet` is listed as a dependency but **not used** by default.
- The server processes frames sequentially (`max_workers=1`) to avoid backlog.

---

## Target Image Preprocessing (Optional, Recommended)

To avoid runtime feature extraction, preprocess targets to `.webarimg` blobs.

```bash
python preprocess_target.py static/assets/ranger-base-image.jpg --features 5000
```

Benefits:
- Faster startup (loads precomputed pyramid)
- Higher runtime FPS
- More stable detection with more features

The server automatically loads `.webarimg` with matching base filename.

---

## Configuration & Tuning

### Server
- `ImageProcessor.SCALES`, `MIN_MATCHES`, `RANSAC_THRESH` in `src/processor.py`.
- Pose smoothing: `PoseSolver` smoothing and inlier thresholds in `src/pose_solver.py`.
- `app.py` detector/matcher defaults: ORB features and ratio thresholds.

### Client
- Frame size and JPEG quality in `static/index.html`.
- IMU smoothing and dead-reckoning in `static/js/device-motion.js` and `model-renderer.js`.
- Model scale in `ModelRenderer` (`modelConfig.scale`).

---

## Troubleshooting

| Issue           | Cause       | Solution                                                |
| --------------- | ----------- | ------------------------------------------------------- |
| No Camera       | No HTTPS    | Use `ngrok` for mobile or `localhost` on PC.            |
| Stuttering      | Low Network | Reduce frame size or JPEG quality in `index.html`.      |
| Model Jumps     | Multi-match | Use a higher-contrast, unique target image.             |
| IMU Not Working | iOS Policy  | iOS requires a user click to enable motion sensors.     |

---

## Tests

```bash
python -m unittest tests/test_detector.py
```
