# WebAR Image Target SDK - Architecture & Build Documentation

A Python + Three.js WebAR SDK for real-time image target detection, 6DoF AR model rendering, and IMU sensor fusion.

---

## System Architecture

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (Browser)                                   │
├────────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌────────────────────────────────┐   │
│  │  Camera.js   │───▶│   WebARApp   │───▶│         WebSocket.js           │   │
│  │(Intrinsics)  │    │(Orchestrator)│    │   (Frame + Intrinsics → Srv)   │   │
│  └──────────────┘    └──────────────┘    └────────────────────────────────┘   │
│         │                   │                           │                      │
│         ▼                   ▼                           ▼                      │
│  ┌──────────────┐    ┌───────────────┐    ┌────────────────────────────────┐  │
│  │ DeviceMotion │    │ Three.js      │    │     ModelRenderer.js           │  │
│  │ (IMU Fusion) │◀──▶│ (6DoF Canvas) │◀──▶│  (Pose + IMU 6DoF Rendering)   │  │
│  └──────────────┘    └───────────────┘    └────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
                                    │ WebSocket
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                           SERVER (Python/Flask)                                 │
├────────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │                            app.py                                       │   │
│  │  WebSocket Handler: receive frame → process → emit pose + corners       │   │
│  │  Async Mode: eventlet                                                   │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                    │                                           │
│                                    ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │                         processor.py                                    │   │
│  │  ImageProcessor: Multi-scale ORB detection + homography validation     │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│         │                    │                    │                            │
│         ▼                    ▼                    ▼                            │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────────────┐           │
│  │ ORBDetector │      │  BFMatcher  │      │     PoseSolver      │           │
│  │ (Features)  │      │ (Matching)  │      │ (solvePnP + 6DoF)   │           │
│  └─────────────┘      └─────────────┘      └─────────────────────┘           │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Data Flow

### 1. Frame Capture → Detection → AR Rendering

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 1. CAPTURE                                                                       │
│    Camera.js: getUserMedia() → video element → canvas → JPEG (70% quality)      │
│    Throttled to 10 FPS, downscaled to 640px                                     │
│    Intrinsics: Computed once and sent with EVERY frame                          │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 2. TRANSPORT                                                                     │
│    WebSocket.js: Base64 encode → emit('frame', {image, intrinsics}) → Server    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 3. DETECTION (processor.py)                                                      │
│    a. Extract ORB features from camera frame                                    │
│    b. Match against multi-scale target pyramid [1.0, 0.75, 0.5, 0.4, 0.3]       │
│    c. Compute homography with RANSAC (threshold: 4.0px)                         │
│    d. Validate quad geometry (area, convexity, angles, edges)                   │
│    e. Return corners if valid                                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 4. POSE ESTIMATION (pose_solver.py)                                              │
│    a. Define 3D target points (Physical size computed from aspect ratio)         │
│    b. cv2.solvePnPRansac() → rvec, tvec                                         │
│    c. State Machine: SEARCHING → TRACKING → LOST                                │
│    d. Temporal smoothing (EMA α=0.7) + tracking prior                           │
│    e. Convert OpenCV → Three.js coordinates (Y-up, Z-backward)                  │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 5. RESPONSE                                                                      │
│    {                                                                             │
│      detected: true,                                                             │
│      pose: {                                                                     │
│        matrix: [16 floats],  // Camera transform for Three.js                   │
│        position: {x, y, z},                                                      │
│        rotation: {x, y, z},                                                      │
│        distance: 1.2,        // Real distance in meters                         │
│        state: "TRACKING"                                                         │
│      },                                                                          │
│      debug: { inliers: 24, confidence: 0.95 }                                    │
│    }                                                                             │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 6. AR RENDERING (model-renderer.js)                                              │
│    a. Model placed at ORIGIN (target location)                                  │
│    b. Camera positioned using pose.matrix                                        │
│    c. SENSOR FUSION: IMU data corrects rotation when vision is slightly laggy   │
│    d. Three.js renders GLB model over video feed                                │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
WebAR-Python/
├── app.py                          # Flask server + WebSocket (eventlet)
├── requirements.txt                # Python dependencies
├── BUILD.md                        # Documentation
├── SYSTEM_DESIGN.md                # Technical design details
│
├── src/
│   ├── __init__.py                 # Package exports
│   ├── interfaces.py               # Abstract base classes (ISP)
│   ├── processor.py                # Core detection engine ⭐
│   ├── pose_solver.py              # 6DoF pose estimation & tracking state ⭐
│   │
│   ├── detectors/                  # Feature extraction
│   │   └── orb_detector.py         # ORB (default)
│   ├── matchers/                   # Feature matching
│   │   └── bf_matcher.py           # Brute-Force (default)
│   ├── stabilizers/                # Pose smoothing
│   │   └── kalman_stabilizer.py    # Kalman filter (optional)
│   ├── trackers/                   # Frame-to-frame tracking
│   │   └── optical_flow_tracker.py # Lucas-Kanade (optional)
│   └── renderers/                  # Visualization
│       └── contour_renderer.py     # Draw detection box
│
└── static/
    ├── index.html                  # Main AR viewer app (Orchestrator) ⭐
    ├── model-editor.html           # 3D model adjustment tool
    ├── assets/
    │   ├── ranger-base-image.jpg   # Default target image
    │   ├── ranger-3d-model.glb     # 3D model for AR
    │   └── overlay.jpg             # Debug overlay asset
    ├── alignment-tool/             # Tool for physical-to-virtual alignment
    │   ├── index.html
    │   └── alignment.js
    └── js/
        ├── camera.js               # Camera stream management
        ├── websocket.js            # Socket.IO client
        ├── camera-intrinsics.js    # FOV and Matrix computation ⭐
        ├── device-motion.js        # IMU sensor fusion ⭐
        └── model-renderer.js       # Three.js 6DoF AR rendering
```

---

## Core Components Deep Dive

### 1. ImageProcessor (`processor.py`)

- **Multi-Scale Pyramid**: Matches against 5 scales (1.0 to 0.3) to handle different distances.
- **Scale Priority**: Remembers the last successful scale for faster subsequent matching.
- **Geometry Validation**: Strict checks for convexity, area, and angles to ensure NO false positives.

### 2. PoseSolver (`pose_solver.py`)

- **State Machine**:
  - `SEARCHING`: Full detection loop.
  - `TRACKING`: Uses **Extrinsic Guess** (prior pose) for 3x faster and stable refinement.
  - `LOST`: Holds last known pose for 5 frames while attempting recovery.
- **Coordinate Conversion**: Maps OpenCV's Y-down matrix to Three.js's Y-up world.

### 3. Frontend Orchestration (`index.html` + `/js`)

- **WebARApp**: Manages the main lifecycle, permissions, and loop.
- **CameraIntrinsicsManager**: Computes canonical intrinsics based on actual hardware to lock FOV.
- **DeviceMotionManager**: Accesses Gyroscope/Accelerometer for rotational stability during movement.

---

## Coordination Systems

| System   | Up Axis | Depth Axis | Unit   |
| -------- | ------- | ---------- | ------ |
| OpenCV   | Y-Down  | Z-Forward  | Meters |
| Three.js | Y-Up    | Z-Backward | Meters |
| Browser  | Y-Down  | N/A        | Pixels |

**Sensor Fusion**: When the target is detected, the IMU sets a reference. If the camera moves faster than the tracking updates, the IMU offsets the Three.js camera rotation to prevent "swimming".

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

`getUserMedia` and `DeviceMotionEvent` require a secure context (HTTPS).

```bash
# In a new terminal
ngrok http 5000
# Use the https://...ngrok.io URL on your phone
```

### 4. Target Image Preprocessing (Optimization)

To improve FPS and reduce initial load time, you can preprocess your target images offline. This extracts ORB features once and saves them as a compressed binary blob (`.webarimg`).

```bash
# Preprocess the default target
python preprocess_target.py static/assets/ranger-base-image.jpg --features 5000
```

**Benefits:**

- **Faster Start:** Server skips the expensive multi-scale feature extraction on startup.
- **Higher FPS:** Heavy extraction is moved offline, leaving more CPU for runtime matching.
- **Improved Detection:** You can extract more features (5k+) offline than you would at runtime without performance penalty.

The server will automatically look for a `.webarimg` file with the same name as your target image and load it if found.

---

## Configuration

- **Target Image**: Replace `static/assets/ranger-base-image.jpg` with your target.
- **3D Model**: Replace `static/assets/ranger-3d-model.glb` with your GLB file.
- **Tracking Settings**: Adjust `MIN_MATCHES` and `RANSAC_THRESH` in `processor.py`.
- **Smoothing**: Adjust `smoothing_alpha` in `processor.py` (0.7 = responsive).

---

## Troubleshooting

| Issue           | Cause       | Solution                                                |
| --------------- | ----------- | ------------------------------------------------------- |
| No Camera       | No HTTPS    | Use `ngrok` for mobile or `localhost` on PC.            |
| Stuttering      | Low Network | Reduce frame scale from 640px to 480px in `index.html`. |
| Model Jumps     | Multi-match | Ensure target image has unique, high-contrast features. |
| IMU Not Working | iOS Policy  | iOS requires a user click to enable motion sensors.     |
