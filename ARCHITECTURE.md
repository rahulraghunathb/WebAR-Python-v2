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

## Auto research platform (2026-07-04) — testing without the phone

Automated experimentation over the ground-truth simulator (`static/sim.html`):
define an experiment spec → a matrix of headless runs executes → structured
results → a self-contained HTML report.

```
node tools/research.mjs experiments/cliff-sweep.json   # run (resumable)
node tools/report.mjs   results/cliff-sweep            # analyze
```

- **Spec** (`experiments/*.json`): `base` params + `grid` axes (arrays or
  `{from,to,step}`) × `seeds` × named pipeline-config variants (`configs`,
  injected into worker init — reaches both pipeline and EnvMap gates).
  Runs = product(grid) × seeds × |configs|.
- **Orchestrator** (`tools/research.mjs`, zero npm deps): one headless
  Chrome, N tab slots (default `--concurrency 2`; 2 parallel runs ≈ 3×
  slower each on a laptop — throughput still wins), navigate-per-run (fresh
  worker per run = config isolation), tab recycled every 12 runs (SwiftShader
  WebGL context bloat), progress-based stall watchdog (`__SIM_PROGRESS__`
  beacon) + absolute timeout, crash events via CDP, retry-once at queue
  back, JSONL appended per attempt, **resume by runId** (SHA-256 of
  spec+params+seed+config), spec-hash guard refuses to mix experiments.
- **sim.html research params**: `?seed=` decorrelates noise/shake/gyro
  (seed=0 ≡ canonical baseline), `?cfg=<JSON>` pipeline overrides,
  `__TEST_DONE__.metrics` (heldPct, mapPeak, detectionRate, raw/fused cm,
  timeline, profile echo).
- **Report** (`tools/report.mjs`): self-contained report.html — heatmaps
  (mean over seeds + min–max glyph), robustness curves with seed bands,
  paired A/B table (joined on params+seed), sortable drill-down with
  colored state timelines, failure list.
- Server: uses a running dev server on :5000, else spawns its own static
  server (`tools/lib/static-server.mjs`).

First platform result (smoke, 4 runs): bootstrap bimodality is
**seed-dependent even at the stable default** — noise2/blur0.10 held 97.9%
(seed 0) vs 0% (seed 1). Robustness must be measured as P(hold) over seeds,
not a single run.

### Bootstrap survivability round (2026-07-04) — first autonomous fix loop

The platform's cliff-sweep measured map survival as a ~70/30 coin flip under
ANY realistic noise (perfectly bimodal, flat across noise 2–6 / blur
0.06–0.20). Per-frame traces (`&dump=1` + `tools/dump-run.mjs`) of a holding
seed vs a collapsing seed at the same profile localized four compounding
mechanisms, fixed as `bootstrapV2` (pipeline cfg flag, now DEFAULT ON):

1. **Honest triangulation gate** — the accept bound was calibrated on
   REFINED poster-anchor residuals (~1× noise floor) while fresh 2-view DLT
   legitimately sits near 2×; ripe candidates starved at exactly the
   poster-exit window. Now `max(2.6, 2×noisePx)` (baseline/parallax gates —
   the drift protection — unchanged).
2. **Coast-on-dip** — a young map dipping ONE frame below `mapMinInliers`
   hard-LOST while the pose was cm-accurate, killing the KLT chain + the
   candidate bank. Now bridges ≤ `mapCoastMax` (3) frames on the motion
   prior; maintenance is skipped during a coast (a stale pose must never
   anchor geometry) and the jump-gate age keeps growing (a coast is not a
   measurement).
3. **Young-point cull immunity + candidate retry** — fresh DLT points carry
   the worst depth of their lifetime and were culled before refinement could
   fix them; failed candidates were dropped on a single noisy verdict. Now
   <8-observation points survive below 2× the cull gate, and candidates get
   2 retries (each with strictly more baseline).
4. **Exit-window replenishment** — proactive corner-only harvesting existed
   only in MAP_TRACKING; during poster tracking candidates sat pinned at 0
   through the exit window. Now the same cheap `_harvestOnlyStep` runs under
   a strong poster whenever the candidate pipeline runs low.

**Paired verdict** (fix-bootstrap, 45 seed-pairs across noise×blur grid):
P(hold) **71% → 100%**, 14 wins / 0 losses / 31 ties, raw error 3.04→2.77cm,
fused 3.79→2.83cm, map peak 43→49, proc unchanged. All suites green.

Two more bugs found by the same loop:
- **"fastpan held 0%" was a metric artifact**: poster-KLT legitimately clings
  to the view edge (state TRACKING, 1–3cm error) — requiring MAP_TRACKING
  state under-counted "held". Metric now: pose delivered while poster out,
  any subsystem.
- **Zombie poster chain after relocalization**: test-slam's teleport was made
  a real 51cm jump (the old 25cm hop was silently absorbed by the V2 coast),
  which exposed stale poster-KLT anchors latching onto background texture
  post-reloc and emitting a self-consistent pose 55cm off — whose
  maintenance then culled the relocated map to 0. Fix: a reloc IS a
  discontinuity → `_dropTracking()` the 2D poster chain; the poster must
  re-enter via descriptor-validated detection. 14/14 with the harder
  teleport, poster-free error 10.1cm across the blind jump.

### Digital twin viewer (`static/twin.html`)

Visual replica of manual phone testing, no phone needed: a **phone-screen
panel** (the degraded camera frames the worker actually sees + the ranger
GLB rendered on the ESTIMATED fused pose — the same render path as
index.html) beside a **god view** (dollhouse: poster, boxes, floor grid,
ground-truth phone vs estimated-phone ghost with frustums, GT vs estimated
trails with pen-up on teleports, live map point cloud). Live degradation
sliders (noise/blur/shake/seed), trajectory select, pause/restart. Runs the
real worker with `debugMap` on; realtime clocks (vision ~15 Hz, fusion/render
60 Hz). Headless verification: `node tools/twin-check.mjs` (asserts tracking
+ live fused error via `window.__TWIN_STATE__`, saves a screenshot).

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

## Phase 4 — WebXR world-tracking backend

`static/sdk/core/world-tracking.js` + demo `static/examples/webxr.html`.

Strategy: don't rebuild SLAM where the platform provides it. On ARCore
Android (Chrome and friends), `immersive-ar` WebXR sessions expose full VIO
world tracking; the module wraps it as one of two backends behind a unified
selection API:

| Backend | Where | World definition |
|---|---|---|
| `WebXRBackend` | ARCore Android | ARCore VIO: markerless 6DoF, plane hit-testing, native image-tracking (behind `chrome://flags/#webxr-incubations`) anchoring content to our target |
| `ImageTargetBackend` (the SDK) | everywhere else, incl. iOS Safari | the image target is the world |

The two are architecturally inverse (SDK moves the camera around a fixed
target; WebXR drives the camera and content is placed in world space) —
consumers branch on `backend.kind`. `WorldTracking.detectCapabilities()`
reports webxr / immersive-ar / hit-test / dom-overlay / image-tracking with
honest reasons, and `selectBackend()` auto-falls back.

Demo features: capability HUD, Enter AR, hit-test reticle + tap-to-place of
the ranger model (world-anchored by ARCore), automatic image-anchoring when
the incubation flag grants `image-tracking`, dom-overlay HUD, clean exit.

Verified: `tests/test_world_tracking.js` (Node, 16/16 — capability paths
across no-WebXR / no-AR / full-ARCore mocked environments, session-init
shapes, frame-processing safety) plus graceful-degradation check in a
non-AR desktop browser. On-device behavior requires an ARCore phone
(Chrome, HTTPS) — reachable through the existing ngrok flow at
`/static/examples/webxr.html`.

## Phase 5 (MBVO) — Marker-Bootstrapped Visual Odometry

The answer to "the image is not anchored when I'm moving": the pose now
survives the poster leaving the view by tracking the ENVIRONMENT.

Modules (each one Node-verifiable below the cv layer):
- `static/sdk/vision/geometry.js` — pure-math core: SE(3)/Rodrigues, DLT
  triangulation (4x4 Jacobi eigen), robust motion-only Gauss-Newton on
  SE(3) (Huber + hard outlier rejection), zero dependencies.
- `static/sdk/vision/map.js` — environment map: candidate harvesting
  (grid-bucketed, off-poster), metric triangulation against per-candidate
  anchor poses, refine-and-cull, map-only pose solving.
- `pipeline.js` — MAP_TRACKING state, unified LK (poster + map + candidates
  ride one pyramid pass), trust routing, drift-at-reacquire metric.

The physics that shaped the design:
1. **The poster pins the monocular gauge.** Pure monocular VO has a 7-DoF
   similarity ambiguity; every triangulated point inherits METRIC scale
   from poses measured against the metrically-known poster.
2. **sigma_Z ~ Z^2·sigma_px/(f·b)**: triangulation needs BASELINE. Rotation
   produces none - the baseline gate (8cm) prevents pose noise under
   rotation from faking parallax into garbage depths.
3. **Depth errors surface as the baseline grows** (dpx ~ f·b·dZ/Z^2), so a
   growing residual triggers RE-triangulation (better baseline = better
   depth), not deletion. Only unexplainable residuals (KLT drifters) die.
4. **A poster pose is absolute truth only when STRONG.** At the view edge
   PnP is biased (measured 18.8cm/6.7° while still "tracking"). Weak poster
   poses are cross-checked against the physical motion prior; the map wins
   when the poster jumps implausibly. Map maintenance (anchor/refine/cull)
   only ever runs under strong poses.
5. **Jump gate**: hand-held cameras move a few cm/frame; any map pose
   jumping >15cm/frame is GN converging somewhere wrong - honest LOST
   beats confidently wrong.

6. **Gates scale to the measured noise floor, not constants.** Real phones
   sit at ~2px reprojection (rolling shutter, motion blur) where synthetic
   renders sit at ~0.6px - fixed gates are wrong on one of them. The first
   phone field test proved it: the map NEVER built (strong-pose gate at
   1.2px vs a 2px device floor). The pipeline now learns `noisePx` (EMA of
   reprojection over >= 45-inlier frames) and scales the strong-pose,
   triangulation and cull gates from it.
7. **The jump gate scales with the prior's age.** A fixed per-frame jump
   limit turns one borderline rejection into a death spiral: each rejected
   frame leaves the prior staler, so the next measured "jump" includes more
   real camera motion and is rejected harder.

Verified by `static/test-slam.html` (10/10): a TRUE-3D synthetic scene
(Three.js render -> real worker, ground-truth trajectory): poster orbit ->
pan fully away (47 frames out of view) -> return. Results: pose held 39/47
frames, drift **9.9cm median / 20cm max** over a 1.4m + 42° excursion
(motion-only VO, no bundle adjustment), rotation 3.3° median, recovers
through single-frame losses, reacquire snaps to 3.3cm. Map tracking costs
~2-5ms/frame (GN) + periodic detect for harvesting.

Known limits / next steps for drift: measurement re-anchoring
(reprojection-guided LK), sliding-window local BA, and keyframe descriptors
for map relocalization after full loss.

## Relocalization + map visualization (2026-06-12)

The map graduated from disposable VO state to a RELOCALIZABLE SLAM map:

- **Descriptors, opportunistically**: harvested candidates capture their
  32-byte ORB descriptor when the source pass computed one (full detects
  do; corner-only harvest passes stay corner-only). Zero added per-frame
  compute - the bytes were already in memory.
- **Dormant pool**: a KLT-lost point with a descriptor goes DORMANT
  (capped 160, aged out after ~900 frames) instead of dying; LOST ->
  SEARCHING now calls `env.sleep()` instead of destroying the map.
- **Poster-free relocalization** (`_tryRelocalize`): on full-res search
  frames, the scene descriptors the failed poster detect ALREADY computed
  are matched against the map's descriptor points (SIMD kernel, ~0.25ms),
  PnP from scratch (DLT init, no prior), robust GN refinement, inliers
  revived as the tracked map. Runs only on frames already paying for a
  search detect - steady-state cost is exactly zero.
- **Dev map visualization** (`?debug=map`): SLAM point cloud (green =
  tracked, amber = dormant) + camera trail rendered in the world frame, so
  dots stick to the surfaces they were triangulated on. The gate lives in
  the WORKER: with the flag off (production), not one extra byte is
  copied or transferred - verified by a pipeline-harness assertion.

Verified in test-slam.html (14/14, double-run): relocalization fires both
organically (map death mid-pan: recovered next full-res frame) and in a
dedicated phase - camera TELEPORTED to a new viewpoint with the poster
HIDDEN: recovered in 1 frame, poster-free pose error 2.2cm median, map
rebuilt to 21+ points. Bench unchanged (mean 4.2ms, p95 16.2ms).

Bug found on the way: `_posterRoiFromPose` conflated "poster offscreen"
(skip the retry) with "poster too LARGE for an ROI to pay off" (the most
reacquirable case there is) - large centered posters were never retried
during MAP_TRACKING.

Next (deferred until phone field data): `.webmap` persistence -
serialize points+descriptors like `.webart`, reload across sessions,
relocalize without ever showing the poster.

## Performance optimization round (2026-06-12)

Goal: system-wide speedup. Method: percentile instrumentation in both
harnesses, then attack the measured bottleneck. Measurement first exposed
that **brute-force descriptor matching was 92% of detection cost** (99.9ms
of a 114ms detect; ORB itself only 8ms) - every optimization followed from
that number.

Shipped (all 101 checks green, results reproduced across double runs):
- **Asymmetric matching budgets**: exploration (SEARCHING/LOST/poster retry)
  matches a stride-subsampled 600-feature target set (~3x cheaper - it only
  needs to FIND); quality-path refreshes keep the full 2000 set (their
  anchors pin the pose noise floor every map gate scales from).
- **Predicted-ROI poster retry + offscreen skip**: during MAP_TRACKING the
  pose projects the poster's quad; retries run in that ROI, and when the
  poster isn't even in view the retry is SKIPPED - this eliminated the
  single biggest waste class (full re-detections of an off-screen poster:
  the 587ms spikes in phone logs).
- **Half-res search alternation** (full-first): ~4x cheaper per SEARCHING
  attempt; full-res attempts interleaved for small/far posters.
- **Corner-only harvesting** (ORB.detect, no descriptors/matching) where a
  pass exists only to seed map candidates; proactive cadence (candidate
  pipeline kept full - reactive starvation triggers are structurally too
  late during pans).
- **Quad-confined matching** on refreshes: detector untouched (same
  keypoints/anchors/harvest), but Hamming matching restricted to scene
  points inside the known quad, where all true matches live.
- **Worker warmup** at init (corner-rich pattern; first-detect JIT spike).
- Uncertainty-scaled triangulation gates (gateScale grows with map-only
  time), zombie-track suppression (no refresh detects in MAP_TRACKING).

Measured on the deterministic 110-frame MBVO trajectory (desktop headless):

| Metric | Before | After | Speedup |
|---|---|---|---|
| Frame p95 (worst-case behavior) | 171.3ms | 15.8ms | **10.8x** |
| Map-tracking avg | 27.8ms | 3.3ms | **8.4x** |
| Detection class avg | 114.0ms | 17.2ms | **6.6x** |
| Frame max | 189.4ms | 34.4ms | **5.5x** |
| Frame mean | 24.3ms | 4.7ms | **5.2x** |
| Poster tracking | 5.6ms | 3.1ms | 1.8x |
| Hamming matching (kernel) | 25ns/pair | 3.5ns/pair | **7.1x** |

Quality IMPROVED alongside (same harness): map drift 7.0cm median vs 9.9cm
before optimization, rotation 2.9 deg vs 3.3, reacquire snap 3.9cm.

**FB-check replaced by geometric validation**: the classic backward LK pass
(half of all LK cost - 4 pyramid builds/frame) exists to catch tracker
drift, but this architecture re-validates every tracked point per frame
against FIXED references anyway: poster points via RANSAC against anchored
target coordinates (coherent drift breaks reprojection there), map points
via GN residuals + poster-truth culling. The forward pass's patch residual
('err' gate) plus those geometric gates carry the same protection at half
the LK cost - verified on the ground-truth harness (quality improved, not
just held). `fbCheck: true` restores the classic behavior.

Phone impact (from logged spike classes): the 587ms class (full detect,
poster offscreen) is eliminated outright; 119-271ms detects drop to the
~35-60ms refresh class.

**Negative results (load-bearing, do not retry):** thinning the TRACKING
re-anchor path was attempted four independent ways (ROI scene detection,
sparse target set, corner-only split, exploration-grade fallback) and every
variant measurably degraded the MBVO map handoff - frequent full-density
re-anchoring pins the pose noise floor. Also `maxTrackPoints` 60 -> 40
degraded the map for the same reason.

**Custom SIMD Hamming matcher (BUILT)**: profiling showed the wasm
BFMatcher runs ~25ns/descriptor-pair (unvectorized). `tools/matcher.c`
(868-byte standalone wasm, embedded base64 in
`static/sdk/vision/matcher.js`) does XOR + `i8x16.popcnt` + pairwise
reduction: 3.5ns/pair, bit-exact vs reference, graceful cv fallback.
Also: RANSAC iteration cap (findHomography 2000 -> 500 @ 0.995 - the
default only ran to exhaustion on junk that gets rejected anyway) and
amortized DLT refinement (8/frame round-robin, defer-don't-cull).

Remaining levers if ever needed: LK pyramid reuse
(`buildOpticalFlowPyramid` whitelist + slim rebuild, ~1.3x mean) - the
steady-state floor is otherwise LK/PnP-bound and camera-fps-capped.

## Roadmap status

- [x] **Phase 1 — client-side image tracking** (this document)
- [x] **Phase 2 — vision+IMU fusion** (error-state complementary filter
      with latency compensation; IMU is the 60Hz pose source, vision
      corrects drift — see above)
- [x] **Phase 3 — SDK packaging** (`.webart` compiled targets + offline
      compiler, npm package shape, A-Frame adapter, configurable targets)
- [x] **Phase 4 — WebXR world-tracking backend** (ARCore via WebXR with
      hit-test placement + native image-tracking when flagged; unified
      backend selection with image-target fallback — see above)
- [x] **Phase 5 — MBVO** (marker-bootstrapped visual odometry: the model
      stays anchored when the poster leaves the view — see above; iOS-safe,
      no WebXR required)
- [ ] MBVO drift reduction: reprojection-guided re-anchoring, sliding-window
      local BA, descriptor-based map relocalization
- [x] **Slim WASM core** (`vendor/opencv-slim.js`): custom OpenCV.js build
      with only the modules/bindings the pipeline calls
      (core,imgproc,features2d,calib3d,video,flann + whitelist) and WASM
      SIMD. **3.9MB raw / 1.0MB gzip** vs the full build's 11MB / 3.5MB —
      72% smaller over the wire; KLT track step ~6.6ms → ~4.1ms. The worker
      feature-detects SIMD and falls back to the full build when slim is
      absent or SIMD unsupported (verified both ways, 12/12 pipeline
      checks). Build recipe + Windows gotchas in `tools/README.md`.
      CAUTION: this emscripten-6 build has a known upstream bug — `Mat.clone()`
      returns a buffer alias, not a copy (`static/test-heap.html` probes it;
      pipeline.js uses `copyTo` instead).
- [ ] npm registry publish + hosted target-compiler service (the `.webart`
      pipeline is the service's core; needs an upload API + auth)
- [ ] Multi-target support (N compiled targets, per-target state machines)

## Known constraints

- Intrinsics still come from the device-FOV heuristic database
  (`camera-intrinsics.js`); a calibration flow would improve metric scale.
- `createImageBitmap(video, {resize})` path needs the canvas fallback on
  older Safari (implemented, auto-detected).
- First load on SIMD browsers is the 1.0MB-gzip slim core (then cached);
  non-SIMD browsers get the full opencv.js at 3.5MB gzip.
- Multiple simultaneous targets not yet supported (single compiled target).
