# WebAR SDK - Flaws, Issues, Improvements, and Roadmap

This document captures current gaps in the codebase and a phased roadmap.

---

## Flaws (Architectural / Technical Debt)
- Single-threaded processing (`max_workers=1`) can bottleneck on slow devices.
- Vision pipeline depends on JPEG/Base64 transfer, adding latency and CPU overhead.
- Intrinsics rely on heuristic FOV database; no true calibration support.
- Frame queue control is coarse; older frames can still be processed under load.
- Tracking state and confidence are not exposed clearly to the client UI.

---

## Issues (Observed / Likely Risks)
- Network jitter causes visible pose jumps when FPS drops below ~10.
- IMU translation (dead-reckoning) drifts without a bias correction model.
- Model visibility can flicker on brief detection losses.
- No multi-target support; changing targets requires manual preprocessing and restart.
- Limited test coverage (unit tests only for ORB/BF/processor basics).

---

## Improvements (Short-Term, Low Risk)
- Add server-side frame drop policy (process latest only, discard stale IDs).
- Add client-side adaptive FPS (scale down when CPU/network is overloaded).
- Send grayscale or raw RGB via binary Socket.IO to reduce encode/decode cost.
- Expose tracking state + confidence in UI and logging.
- Add target configuration via config file or query param.

---

## Roadmap (Phase Wise)

### Phase 0: Stabilize (1-2 weeks)
- Implement LIFO frame processing on server and ignore stale frames.
- Add structured logging for pose, inliers, and confidence.
- Add quick smoke tests for `app.py` socket flow.

### Phase 1: Performance + Accuracy (2-4 weeks)
- Add optional binary transport (no Base64) for frames.
- Improve intrinsics: per-device calibration file and fallback heuristics.
- Add adaptive downscale logic based on round-trip latency.

### Phase 2: Robust Tracking (4-6 weeks)
- Integrate optical-flow-based tracking between detections.
- Add multi-target support with a target registry.
- Add pose smoothing config exposed to UI or JSON config.

### Phase 3: Client-Side Vision (6-10 weeks)
- Wire `VisionManager` + `FrameCapture` to WASM pipeline.
- WebWorker offload for frame processing.
- Fallback to server when WASM not available.

---

## Suggested Owners / Focus Areas
- Vision: pose stability, optical flow, and target scaling
- Frontend: frame transport, UI metrics, IMU fusion
- Infra: logging, profiling, and test automation
