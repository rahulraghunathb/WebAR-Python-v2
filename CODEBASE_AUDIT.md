# Codebase Audit

Date: 2026-03-06

## Scope

Reviewed the Python backend (`app.py`, `src/`, `tests/`), frontend runtime (`static/index.html`, `static/js/`), alignment/editor tools in `static/`, and architecture notes in `BUILD.md` and `SYSTEM_DESIGN.md`.

Binary assets in `static/assets/` were not inspected beyond their filenames.

## Executive Summary

The project has a workable single-user prototype shape, but the current implementation has several structural issues that will block reliable production use:

1. The backend runtime is effectively global, so multiple clients will interfere with each other.
2. The AR alignment chain is internally inconsistent: the viewport math, IMU sync path, and alignment tool do not match the renderer contract.
3. The Python environment is not reproducible right now; `pytest -q` fails during import because the dependency spec allows an OpenCV/NumPy ABI mismatch.

## Bugs

### Critical

1. Global frame processing state mixes all connected clients.
   - Evidence: `app.py:25`, `app.py:103-118`, `app.py:194`
   - Why it matters: `frame_queue`, `last_processed_id`, and `last_received_id` are global. Results are sent with `socketio.emit("result", result)`, which broadcasts to every client. By inspection, a second client can overwrite the first client's frames and receive pose data that does not belong to it.
   - Recommendation: move queue/state to a per-client session object keyed by `request.sid`, and emit results back only to the originating socket.

2. The alignment tool does not match the runtime, and its exported config is not consumed.
   - Evidence: `static/alignment-tool/alignment.js:4`, `static/alignment-tool/alignment.js:165-185`, `static/alignment-tool/alignment.js:533`, `static/js/model-renderer.js:30`, `static/js/model-renderer.js:181-202`
   - Why it matters: the tool claims to use the same coordinate system as runtime, but the runtime normalizes the model differently, places its feet on the origin using `minY`, and applies an extra `Math.PI / 2` X rotation. The tool exports `this.alignment = {...}`, but `model-renderer.js` does not apply an alignment config at all.
   - Recommendation: create one shared transform pipeline and config schema for both the runtime and the alignment tool, or remove the tool until it is accurate.

### High

3. IMU/frame synchronization is broken because the frame ID is dropped before rendering.
   - Evidence: `app.py:169`, `app.py:187`, `static/index.html:523-534`, `static/js/model-renderer.js:325-332`
   - Why it matters: the backend returns the frame ID at the top level, but `handleResult()` passes only `data.pose` to `updatePose()`. `ModelRenderer.updatePose()` expects `pose.id`, so the IMU history lookup never succeeds and the renderer falls back to the current IMU orientation instead of the captured-frame baseline.
   - Recommendation: pass the frame ID through with the pose object, or change `updatePose()` to accept the full result payload.

4. Pose tracking is never explicitly reset on no-detection frames.
   - Evidence: `src/processor.py:260`, `src/processor.py:460`, `src/pose_solver.py:378-398`, and no call site in `app.py` when detection fails
   - Why it matters: `PoseSolver` only transitions to `LOST`/`SEARCHING` when its failure handlers run, but the app only calls `compute_pose_ransac()` on positive detections. When the target disappears, the solver can remain in a stale tracking state, which also affects the fast-tracking branch in `ImageProcessor.detect()`.
   - Recommendation: call a loss/reset path on no-detection frames and on client disconnect, or move pose-state ownership fully into the processor.

5. The renderer/video geometry is inconsistent because the video is cropped with `object-fit: cover` and the AR pipeline does not compensate.
   - Evidence: `static/index.html:45`, `static/index.html:593`, `static/index.html:644-647`, `static/index.html:709`
   - Why it matters: the backend pose is computed from the full camera frame, but the user sees a cropped view. The Three.js canvas is resized to the displayed rectangle without compensating for crop offsets, which will create visible overlay drift on devices where the camera aspect ratio and viewport aspect ratio differ.
   - Recommendation: either render the camera feed without crop, or explicitly model the crop/letterbox transform and apply it consistently to both pose projection and renderer sizing.

6. The dependency spec currently allows a broken OpenCV/NumPy combination.
   - Evidence: `requirements.txt:3-4`
   - Verification: `pytest -q` currently fails during collection because `cv2` cannot import against the installed NumPy 2.x ABI.
   - Why it matters: the repo is not reproducible from its own dependency declarations.
   - Recommendation: pin a compatible pair, for example `numpy<2` until the selected OpenCV wheel is guaranteed NumPy 2 compatible, and add a locked/tested environment file.

### Medium

7. `DeviceMotionManager` leaks event listeners because `bind()` is used inline for both add and remove.
   - Evidence: `static/js/device-motion.js:103-115`
   - Why it matters: `removeEventListener()` receives a different function object than `addEventListener()`, so listeners are never removed. Repeated start/stop cycles will accumulate duplicate handlers.
   - Recommendation: bind once in the constructor and reuse the stored function references.

8. Permission flow is inconsistent and duplicates camera access.
   - Evidence: `static/index.html:445`, `static/index.html:575-578`, `static/js/camera-intrinsics.js:106`, `static/js/device-motion.js:57-87`
   - Why it matters: camera permission is requested during initialization and then requested again when starting the session. Motion/orientation permissions are also touched outside the user gesture path, which is unreliable on iOS.
   - Recommendation: collapse permissions into a single start flow triggered by user interaction, then cache and reuse the resulting stream/capabilities.

9. Camera intrinsics are estimated from coarse device heuristics rather than real camera calibration data.
   - Evidence: `static/js/camera-intrinsics.js:69-76`, `static/js/camera-intrinsics.js:200-231`, `static/js/camera-intrinsics.js:272-284`
   - Why it matters: using a hardcoded horizontal FOV per platform can create systematic scale and alignment error, especially across Android devices and front/back camera variants.
   - Recommendation: derive intrinsics from real camera characteristics when available, or at least separate known device profiles from generic fallback logic.

10. `WebSocketManager` exposes a `url` option but ignores it.
    - Evidence: `static/js/websocket.js:7-9`, `static/js/websocket.js:31`
    - Why it matters: this is a silent API contract mismatch. Callers can supply a URL and still connect to the default origin.
    - Recommendation: pass `this.url` into `io(...)` when provided.

## Improvements

1. Replace one-off globals with explicit session objects.
   - Suggested shape: `client_id -> { queue, processor, counters, connection state }`
   - Benefit: fixes correctness, simplifies disconnect cleanup, and makes metrics per-client instead of global noise.

2. Unify the pose/render contract.
   - Define one payload schema for detection results: frame ID, pose, confidence, camera intrinsics fingerprint, and optional debug metrics.
   - Keep frame identity intact from capture to render so IMU fusion has a real synchronization point.

3. Share one model transform pipeline between tools and runtime.
   - Put normalization, upright rotation, anchor point, and optional alignment offsets in one module or JSON schema.
   - Remove `static/model-editor.html` if it is no longer authoritative.

4. Reduce per-frame allocations on the client.
   - `static/index.html:682-718` creates a fresh canvas and data URL every send.
   - Reuse a single canvas, prefer `toBlob()` or binary transport, and decide whether `VisionManager`/`FrameCapture` should be wired in or deleted.

5. Remove stale or contradictory dependencies and code paths.
   - `eventlet` is declared in `requirements.txt:6`, but the app forces `async_mode="threading"` in `app.py:22`.
   - `VisionManager` and `FrameCapture` are scaffolded but not used by the main app.
   - Benefit: smaller install surface, fewer misleading maintenance paths.

6. Strengthen automated validation.
   - Add a dependency smoke test that imports `cv2`, `numpy`, and starts a minimal processor.
   - Add backend integration tests for per-client isolation and pose reset behavior.
   - Add a browser smoke test for the frame transport/render loop.

7. Clean up lower-priority maintainability issues.
   - `src/processor.py:363-364` reaches into `PoseSolver` private fields directly.
   - Several UI strings and logs contain mojibake characters, which suggests inconsistent file encoding.
   - `app.py` contains a hardcoded Flask secret key.

## Implementation Plan

### Phase 1: Reproducible Environment

Goal: make the repo installable and testable on a clean machine.

1. Pin a known-good NumPy/OpenCV pair and document the supported Python versions.
2. Remove unused runtime dependencies, especially `eventlet`, unless you intentionally switch the server back to that mode.
3. Add a minimal CI or local verification script that runs dependency install and `pytest -q`.

Definition of done:
- `pytest -q` passes in a fresh environment.
- The install instructions in `BUILD.md` match the real dependency set.

### Phase 2: Backend Session Isolation and Pose Lifecycle

Goal: make tracking correct for one client and safe for many clients.

1. Introduce per-client state keyed by socket ID.
2. Queue frames and emit results per client instead of globally.
3. Reset or degrade pose state when detection is lost and on disconnect.
4. Add tests for two simultaneous clients and target-loss recovery.

Definition of done:
- Two clients can connect without cross-talk.
- Lost target transitions through `LOST`/`SEARCHING` correctly.

### Phase 3: Renderer and Camera Contract

Goal: make what the user sees match what the backend solved.

1. Preserve frame IDs end-to-end so IMU history lookup works.
2. Fix the viewport crop problem by using letterboxed display or explicit crop compensation.
3. Replace heuristic camera geometry with a more accurate intrinsics strategy.
4. Reuse frame capture buffers to reduce garbage creation and latency spikes.

Definition of done:
- IMU synchronization path is exercised in runtime logs.
- Model alignment remains stable across portrait and landscape device layouts.

### Phase 4: Tooling Consolidation

Goal: remove misleading tooling and make support tools trustworthy.

1. Decide whether `static/alignment-tool/` is part of the supported workflow.
2. If yes, make it consume the same normalization/orientation code as `model-renderer.js`.
3. Remove or integrate `static/model-editor.html`, `VisionManager`, and any other dead paths.

Definition of done:
- Exported alignment data can be pasted into the runtime and reproduce the same transform.
- There is one documented path for model alignment.

### Phase 5: Quality Gates and Observability

Goal: keep regressions from reappearing.

1. Add focused tests around `ImageProcessor`, `PoseSolver`, and Socket.IO session routing.
2. Add lightweight runtime metrics: frame age, dropped frames, per-client processing latency, and pose confidence.
3. Log explicit state transitions rather than ad hoc print statements.

Definition of done:
- Core regressions are covered by automated checks.
- Runtime debugging does not depend on manual console inspection alone.

## Suggested Order of Work

1. Fix the environment and get tests runnable.
2. Fix backend session isolation and pose-reset behavior.
3. Fix renderer alignment, frame ID propagation, and camera viewport math.
4. Clean up tooling, dead code, and lower-priority maintainability issues.
