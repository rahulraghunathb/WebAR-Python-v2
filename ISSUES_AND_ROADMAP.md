# WebAR SDK - Flaws, Issues, Improvements, and Roadmap

This document captures current gaps in the codebase and a phased roadmap.

---

## Flaws (Architectural / Technical Debt)
- Single worker thread for all clients; heavy load from many clients will queue.
- Vision pipeline depends on JPEG/Base64 transfer, adding latency and CPU overhead
  (binary Socket.IO transport is the next step).
- Intrinsics rely on heuristic FOV database; no true calibration support.
- No frame-to-frame tracking (optical flow): every frame is a full re-detection.
- ~~Shared global tracking state across all clients + broadcast results~~ FIXED:
  per-session processors, results emitted per-sid.

---

## Issues (Observed / Likely Risks)
- Network jitter causes visible pose jumps when FPS drops below ~10.
- ~~IMU translation (dead-reckoning) drifts without a bias correction model~~
  FIXED: translational dead-reckoning removed (wrong reference frame; rotation-only now).
- ~~Model visibility can flicker on brief detection losses~~ FIXED: renderer owns
  loss handling with a 500ms dead-reckon grace window.
- ~~Stale pose prior survives when target leaves the frame~~ FIXED:
  `notify_no_detection()` decays TRACKING → LOST → SEARCHING.
- ~~Frame-id IMU sync never matched (pose.id missing)~~ FIXED: server attaches id to pose.
- ~~Triple-stacked smoothing (backend EMA + frontend lerp + IMU) caused lag~~ FIXED:
  single time-based smoothing stage in the renderer.
- ~~`object-fit: cover` crop vs full-frame FOV misalignment~~ FIXED: effective-FOV
  correction in the renderer.
- No multi-target support; changing targets requires manual preprocessing and restart.

---

## Improvements (Short-Term, Low Risk)
- ~~Add server-side frame drop policy (process latest only, discard stale IDs)~~ DONE (per-client).
- Add client-side adaptive FPS (scale down when CPU/network is overloaded).
- Send grayscale or raw RGB via binary Socket.IO to reduce encode/decode cost.
- ~~Expose tracking state + confidence in UI and logging~~ DONE.
- Add target configuration via config file or query param.
- Replace pickle in `.webarimg` with a non-executable format (np.savez/msgpack)
  before ever accepting user-uploaded targets.

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
