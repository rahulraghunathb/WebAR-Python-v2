# Build Guide

Date: 2026-03-06

## Current Runtime

The active runtime is a repo-owned image tracker.

It does not rely on WebXR for pose tracking.

The stack is:
- browser camera capture with explicit user permission
- Socket.IO frame transport
- Python OpenCV ORB target matching
- `solvePnPRansac` pose estimation
- Three.js rendering with IMU-assisted prediction

## Active Files

- `app.py`: Flask + Flask-SocketIO host and per-client tracking sessions
- `src/processor.py`: multi-scale ORB detection and inlier extraction
- `src/pose_solver.py`: pose solve, tracking state machine, and OpenCV-to-Three.js transform
- `static/index.html`: runtime shell, permission UI, and app orchestration
- `static/js/camera.js`: camera acquisition
- `static/js/websocket.js`: Socket.IO client transport
- `static/js/camera-intrinsics.js`: camera intrinsics estimation and scaling
- `static/js/device-motion.js`: IMU capture
- `static/js/model-renderer.js`: Three.js pose application and prediction
- `static/js/model-transform.js`: shared model rig and alignment profile

## What The App Does On Start

1. Connects to the tracker backend.
2. Waits until the target image is loaded server-side.
3. On user tap, requests camera permission.
4. Starts the camera stream.
5. Initializes camera intrinsics from the live stream.
6. Optionally requests motion-sensor permission.
7. Sends downscaled JPEG frames plus intrinsics over Socket.IO.
8. Receives pose results and renders the model over the tracked image.

## Camera Permission

Camera permission is now requested only after the user presses the start button.

That is handled in `static/index.html` through `CameraManager.start()`.

## Runtime Requirements

The custom tracker path requires:
- a browser with `getUserMedia`
- camera permission granted by the user
- a working Socket.IO connection to the Flask server
- Python dependencies from `requirements.txt`

Unlike the old strict WebXR runtime, `immersive-ar` support is not required.

## Install

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
python app.py
```

Open one of:
- `http://localhost:5000`
- your HTTPS tunnel URL such as ngrok

## Dependency Set

The repo is pinned to the versions that match the current local environment:
- `flask==3.1.2`
- `flask-socketio==5.6.0`
- `python-socketio==5.16.0`
- `python-engineio==4.13.0`
- `opencv-python==4.12.0.88`
- `numpy==2.2.6`
- `Pillow==12.1.0`

## Known Limits

This is a custom tracker path, but it is not yet a full SLAM system.

What exists:
- image target detection
- pose estimation from matched inlier points
- IMU-assisted short-term prediction
- per-client tracking sessions

What does not yet exist:
- persistent map building
- relocalization
- world-scale anchor persistence without the target
- full visual-inertial SLAM

## Verification

```bash
node --check static\js\camera.js
node --check static\js\websocket.js
node --check static\js\camera-intrinsics.js
node --check static\js\device-motion.js
node --check static\js\model-renderer.js
node --check static\js\model-transform.js
venv\Scripts\python.exe -m unittest discover -s tests -v
venv\Scripts\python.exe -m py_compile app.py
```
