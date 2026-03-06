# System Design

Date: 2026-03-06

## Overview

The current application uses a custom repo-owned tracking pipeline.

It does not rely on native WebXR for target tracking.

The tracking loop is:
- capture camera frame in the browser
- downscale and encode the frame
- send frame and intrinsics to Python over Socket.IO
- detect the target with ORB and homography validation
- solve 6DoF pose with `solvePnPRansac`
- render the model in Three.js
- use IMU for immediate motion smoothing between vision updates

## Runtime Graph

```text
Browser Camera
  -> camera.js
  -> index.html app loop
  -> websocket.js
  -> Flask-SocketIO
  -> processor.py
  -> pose_solver.py
  -> result payload
  -> model-renderer.js
  -> Three.js canvas overlay
```

## Backend

### `app.py`
- hosts the app
- loads the target image
- creates per-client sessions
- receives frame packets over Socket.IO
- emits pose results back to the originating client

### `src/processor.py`
- builds a target pyramid
- runs multi-scale ORB matching
- validates homography geometry
- extracts inlier correspondences for pose solving
- updates tracking state on no-detection frames

### `src/pose_solver.py`
- manages `SEARCHING -> TRACKING -> LOST` state
- estimates pose using `solvePnPRansac`
- refines with prior pose during tracking
- converts OpenCV coordinates into the Three.js camera frame

## Frontend

### `static/index.html`
- owns startup flow
- asks for camera permission on user gesture
- asks for motion permission when available
- captures frames from the live video element
- sends intrinsics and frame IDs to the backend
- updates the HUD and debug panel

### `static/js/camera.js`
- starts and stops the camera stream
- exposes active track settings
- provides frame capture helpers

### `static/js/websocket.js`
- owns Socket.IO connection state
- sends frame payloads
- forwards status and result callbacks to the app

### `static/js/camera-intrinsics.js`
- estimates canonical intrinsics from device FOV heuristics
- scales intrinsics for downsampled frames
- provides the vertical FOV used by the renderer

### `static/js/device-motion.js`
- requests motion and orientation permissions
- tracks quaternion deltas and linear velocity
- provides a rotation baseline for render prediction

### `static/js/model-renderer.js`
- loads the GLB
- applies the shared transform profile
- consumes backend pose packets
- preserves the last good vision pose
- predicts motion between backend updates using IMU data

### `static/js/model-transform.js`
- defines the canonical asset URL, target image URL, and scale
- normalizes the model rig for runtime and alignment tooling

## Camera Permission Behavior

Camera permission is explicit.

The app does not request camera access at page load. It requests access only after the user presses the start button.

## Why This Is Not Full SLAM Yet

This repo now owns the target-tracking path, but it still does not contain a full map-building SLAM engine.

Missing pieces include:
- keyframe map construction
- relocalization after long target loss
- world anchors that persist after the image target leaves view
- full visual-inertial bundle adjustment

The current path is best described as custom image tracking with IMU-assisted rendering.

## Tracking State

Backend state:
- `SEARCHING`
- `DETECTING`
- `TRACKING`
- `LOST`

Renderer state:
- `SEARCHING`
- `TRACKING`
- `PREDICTING`

## Notes On Accuracy

The system depends on:
- target image quality
- lighting
- correct target physical size
- intrinsics estimation quality
- frame transport latency

The model alignment contract is shared with the alignment tool through `static/js/model-transform.js`.
