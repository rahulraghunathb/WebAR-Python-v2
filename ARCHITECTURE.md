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

## Phase 2 — Fusion engine (`static/sdk/core/fusion.js`)

Latency-compensated vision+IMU fusion. The IMU propagates orientation at
render rate; vision poses arrive 30-80ms stale and correct the state **at
their capture timestamp** via a state-history ring buffer. Corrections are
absorbed as error feedback (time-constant based), so they never fight the
prediction. Position uses a constant-velocity model whose velocity is
estimated from the **innovation increment** (alpha-beta style) with
rate-independent bandwidth. The accelerometer is deliberately NOT
integrated (uncalibrated web accel double-integration = noise amplification).

Design choices that mattered (each one found by the simulation harness):
1. **In-flight correction credit**: with 60ms latency and 30-60Hz vision,
   several measurements are in flight at once; innovations must be computed
   against `history(t_capture) + corrections applied since`, or the same
   error is re-corrected repeatedly and velocity diverges.
2. **Innovation-increment velocity**: raw-innovation velocity updates pump
   un-absorbed error (diverges at high rates).
3. **Time-constant gains everywhere**: fixed per-update gains change filter
   bandwidth with vision rate; `(1-exp(-dt/tau))/dt` keeps it constant.

Verified by `node tests/test_fusion.js` — a ground-truth simulation
(hand-sway motion, noisy IMU with a 73° reference-frame offset, delayed
noisy vision, 0.5s dropout), 9/9 checks at every rate:

| Vision rate | Fused rot RMS (vs hold-last) | Fused pos RMS (vs hold-last) |
|---|---|---|
| 12Hz | **0.48°** vs 3.48° | **16.0mm** vs 18.1mm |
| 30Hz | **0.34°** vs 2.60° | **11.2mm** vs 14.0mm |
| 60Hz | **0.28°** vs 2.29° | **9.2mm** vs 13.5mm |

Dropout (0.5s, no vision): coasts within ~1° / ~7cm, recovers cleanly.

Known approximation: device→camera mounting conjugation on IMU deltas is
ignored (deltas between corrections are a few degrees at most; residual is
absorbed by the next correction). Proper mounting calibration is future work.

## Phase 3 — SDK packaging

- **`.webart` compiled target format** (`static/sdk/vision/webart-format.js`
  documents the binary layout): produced offline by `preprocess_target.py`
  (the future cloud compiler), parsed zero-copy on device. 229KB vs 583KB
  legacy pickle, skips ~1.2s of on-device ORB extraction, and carries the
  target's physical size — pass `--width-m <printed width>` and poses
  become metrically true. Safe to parse (no pickle), validated against
  truncation/corruption.
- **SDK package shape**: `static/sdk/` is npm-publishable
  (`package.json`, `README.md` with full API docs, `WebARSDK.version`).
- **A-Frame adapter** (`static/sdk/adapters/aframe-webar.js`): declarative
  markup — `<a-scene webar="targets: poster.webart">` +
  `<a-entity webar-target>`; events `webar-ready/-target-found/-target-lost`.
  Example: `static/examples/aframe.html` (A-Frame vendored).
- **Configurable targets**: `/?target=<url>` query param; SDK accepts a
  candidate list and falls back in order (.webart → image).
- Verification: `tests/test_webart.js` (Node, 10/10 — round-trip vs the
  Python writer, corruption rejection) and two new browser checks in
  test-pipeline.html (12/12 — compiled-target init + detection parity).

Also fixed here: `/` was served via `render_template`, and with
`debug=False` Jinja caches the compiled template at first render — the
page was frozen at server-boot content. Now served as a static file.

## Roadmap status

- [x] **Phase 1 — client-side image tracking** (this document)
- [x] **Phase 2 — vision+IMU fusion** (error-state complementary filter
      with latency compensation; IMU is the 60Hz pose source, vision
      corrects drift — see above)
- [x] **Phase 3 — SDK packaging** (`.webart` compiled targets + offline
      compiler, npm package shape, A-Frame adapter, configurable targets)
- [ ] **Phase 4 — WebXR world-tracking backend** (Android/Chrome: ARCore
      via WebXR; image targets layered on top)
- [ ] **Phase 5 — iOS world tracking** (evaluate AlvaAR / own VIO)
- [ ] Slim custom WASM core to replace the 11MB opencv.js (only ORB, LK,
      RANSAC, PnP needed → ~1.5MB)
- [ ] npm registry publish + hosted target-compiler service (the `.webart`
      pipeline is the service's core; needs an upload API + auth)
- [ ] Multi-target support (N compiled targets, per-target state machines)

## Known constraints

- Intrinsics still come from the device-FOV heuristic database
  (`camera-intrinsics.js`); a calibration flow would improve metric scale.
- `createImageBitmap(video, {resize})` path needs the canvas fallback on
  older Safari (implemented, auto-detected).
- opencv.js first load is ~11MB (then cached). The custom-core roadmap item
  removes this.
- Multiple simultaneous targets not yet supported (single compiled target).
