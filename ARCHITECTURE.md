# WebAR SDK — Architecture (Client-Side Tracking)

## Vision

An 8th-Wall-class WebAR engine: **all per-frame vision runs in the browser**
(WASM, off the main thread), the server is out of the frame loop entirely.
Zero network latency in tracking; the server's only jobs are hosting and
(eventually) cloud target compilation.

```
┌──────────────────────────── BROWSER ─────────────────────────────┐
│  Main thread                         Vision Worker                │
│  ┌───────────────────┐              ┌───────────────────────────┐ │
│  │ WebARSDK          │  ImageBitmap │ vision-worker.js          │ │
│  │ (frame pump,      │ ───────────▶ │  OpenCV.js (WASM)         │ │
│  │  backpressure,    │              │  pipeline.js:             │ │
│  │  events)          │ ◀─────────── │   detect-then-track       │ │
│  ├───────────────────┤  pose 30-60Hz│   ORB + KLT + PnP         │ │
│  │ ModelRenderer     │              └───────────────────────────┘ │
│  │ (Three.js, smooth │                                            │
│  │  + IMU predict)   │   DeviceMotionManager (IMU 60Hz)           │
│  └───────────────────┘   CameraIntrinsicsManager (FOV)            │
└───────────────────────────────────────────────────────────────────┘
              │ static hosting + target compile (offline)
              ▼
     Flask server (legacy server-tracking mode preserved)
```

## Components

| File | Role |
|---|---|
| `static/sdk/webar-sdk.js` | Public API + engine: frame pump (`requestVideoFrameCallback`), GPU capture (`createImageBitmap`, canvas fallback for Safari), single-in-flight backpressure (newest frame wins, zero queue latency), events (`ready`/`result`/`framesent`/`error`) |
| `static/sdk/vision/vision-worker.js` | Worker shell: owns the OpenCV WASM runtime, converts frames to gray Mats (pooled), routes messages |
| `static/sdk/vision/pipeline.js` | The tracker. Direct port of `src/processor.py` + `src/pose_solver.py` (same thresholds/validation/coordinate math) extended with KLT tracking |
| `static/sdk/vendor/opencv.js` | Official OpenCV.js 4.x build (vendored, ~11MB, cached by the browser after first load) |
| `static/js/model-renderer.js` | Three.js rendering, single time-based smoothing stage, IMU rotation prediction, cover-crop FOV correction |
| `static/test-pipeline.html` | Camera-free verification: synthetic warped-target frames through the REAL worker; 10 assertions |
| `static/legacy-server.html` + `app.py` sockets | The old server-side tracking path, preserved for comparison |

## The pipeline (detect-then-track)

```
SEARCHING ──(ORB 600 feat + ratio match vs 3-scale target set
             + RANSAC homography + quad validation)──▶ TRACKING

TRACKING ──every frame──▶ pyramidal LK on ≤60 anchored points
                          forward-backward consistency pruning (1.5px)
                          homography RANSAC (anchored target→scene, NO drift integration)
                          solvePnP ITERATIVE with prior
TRACKING ──every 45 frames or <24 points──▶ re-detection re-anchors everything
TRACKING ──too few points / bad reproj──▶ LOST (15-frame grace) ──▶ SEARCHING
```

Key properties:
- **Anchored correspondences**: tracked points always map original target
  pixels → current scene pixels, so homography/PnP never accumulates drift;
  individual point drift is killed by FB-check + RANSAC + periodic re-anchor.
- **Acquisition pose** via `SOLVEPNP_IPPE` (planar-specific), **tracking pose**
  via `SOLVEPNP_ITERATIVE` with the previous pose as prior.
- Pose conversion OpenCV→Three.js is identical to the Python solver
  (`tests/test_pose_solver.py` is the conformance reference).

## Measured performance (desktop, 480×360 frames, 960×1440 target)

| Stage | Time |
|---|---|
| Engine init + 3-scale target compile (2000 feat/scale) | ~1.2s once |
| Acquisition detect (first call incl. warmup) | ~130ms |
| **KLT track + PnP per frame** | **~8ms** |
| Reprojection error while tracking | <1px |
| Frame-to-frame distance stability | ~7mm |

Tracking at 8ms/frame leaves comfortable headroom for 30fps on mid-range
phones (budget 33ms).

## Verification

`/static/test-pipeline.html` — runs the production worker against 40
synthetic frames (target affine-warped with continuous drift + distractors):
acquisition, ≥90% detection, tracking engagement, finite poses, plausible
distances, reprojection bounds, jump bounds, motion-following corners.
10/10 passing. Python-side tests (`venv/Scripts/python -m unittest discover
-s tests`): 18/18.

## Roadmap status

- [x] **Phase 1 — client-side image tracking** (this document)
- [ ] **Phase 2 — EKF vision+IMU fusion** (replace renderer-side prediction
      with a proper error-state filter; IMU becomes the 60Hz pose source,
      vision corrects drift)
- [ ] **Phase 3 — SDK packaging** (npm module, A-Frame adapter, cloud
      target compiler producing a binary `.webart` format instead of
      in-browser compilation)
- [ ] **Phase 4 — WebXR world-tracking backend** (Android/Chrome: ARCore
      via WebXR; image targets layered on top)
- [ ] **Phase 5 — iOS world tracking** (evaluate AlvaAR / own VIO)
- [ ] Slim custom WASM core to replace the 11MB opencv.js (only ORB, LK,
      RANSAC, PnP needed → ~1.5MB)

## Known constraints

- Intrinsics still come from the device-FOV heuristic database
  (`camera-intrinsics.js`); a calibration flow would improve metric scale.
- `createImageBitmap(video, {resize})` path needs the canvas fallback on
  older Safari (implemented, auto-detected).
- opencv.js first load is ~11MB (then cached). The custom-core roadmap item
  removes this.
- Multiple simultaneous targets not yet supported (single compiled target).
