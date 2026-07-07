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

## Precision + latency round (2026-07-04) — toward 8th-Wall seamlessness

Shipped default-on, each paired-verified by the research platform:
- **Predictive fusion** (`fusion.js predictive`): body angular velocity
  estimated FROM VISION dead-reckons rotation between corrections (replaces
  the removed IMU's role); tight correction taus (smoothness now comes from
  the motion model, not lag). Dropout coast bound kept via faster velocity
  decay (`velDecayTauP`). tests/test_fusion.js 9/9.
- **precisionV2** (`pipeline.js`): custom JS sub-pixel corner refiner
  (`_subpixRefine`, Forstner-style — the slim WASM has no cornerSubPix)
  refines detect anchors AND the live LK chain every frame (arrests the LK
  random walk). RULE: anchored pairs must be refined on BOTH sides —
  `preprocess_target.py` now sub-pixel-refines target keypoints into the
  .webart; refining scene-only measured WORSE than refining neither.
- **Resolution lever**: processing at 720px (index.html maxDimension) —
  error scales ~1/resolution; tracking cost is point-bound, not pixel-bound.
- **Sim honesty upgrades**: corrections delivered proc_ms after capture via
  a queue (not at capture time), pose-age metrics (`poseAgeP50/P90Ms`),
  `?fcfg=`/`?px=` axes, and a TIMEBASE fix (trajectories authored at 20Hz
  reference; `hz` now changes sampling density, not camera speed).

Measured (canonical profile, cross-seed): raw 2.7→0.83cm (3.25×), rotation
0.92→0.31° (3×), pose-age 50→33ms; suites 13/13, 14/14, 9/9, fusion 9/9.
Known next bottlenecks, quantified: fused error no longer tracks raw
(fusion averaging rework next), map constants are frame-calibrated (60Hz
collapses: held 27%), LK drift grows with rate (SIMD LK + per-frame
refinement at high rate), sliding-window BA for long poster-free drift.

## On-device calibration round (2026-07-04, Pixel 6a field logs)

Two field-only failure classes, both reproduced in the harness and fixed:

- **720px map churn** (`resScaleMapGates`, default ON): field logs showed
  mapPts sawtoothing 30→1 with a FLAT dormant pool — points were being
  EXECUTED by a gate, not lost by KLT (corner-harvested points carry no
  descriptor, so their deaths never show in dormant). A new per-frame **map
  point-flow ledger** (`m_lk/m_cull/m_purge/m_tri/m_harv` in debug, dump
  columns `-lk -cu -pu +tr +hv`) pinned it: the map's OWN pixel gates — GN
  `mapHuberPx 2.0`/`mapOutlierPx 4.0` (solvePose + purgeOutliers) and
  harvest spacing — were never resolution-scaled, so at 720px the outlier
  purge ran at ~2σ of the real noise floor and shredded the map on every
  accepted pose during poster-weak/bridge frames (exactly when the map is
  needed). Pipeline-side gates got scaled in the previous rounds; these
  map-internal ones were the stragglers. Paired verdict (map-res-gates, 24
  pairs): at 720px fused median 2.63→2.01cm (10/12 pairs), LOST frames
  median 5→1, torture trace (noise 6) 15 LOST → 0; at 480px EXACT no-op
  (all 12 pairs bit-identical). Rule reaffirmed: **every pixel-unit
  threshold anywhere in the stack must scale with processing resolution** —
  grep for `Px` defaults when touching map.js/pipeline.js.

- **Heavy-frame stall loss** (`lkPredictSeed` + sim `?hic=` axis): one
  154ms frame (full detect+refresh on-device) = ~3 frame-times of camera
  motion in a single LK step; the chain breaks and, with a thin map, the
  session hard-LOSTs. The sim now models it: `&hic=K` advances the
  trajectory 3 frame-times before every Kth frame (hic=0 is byte-identical
  to before; hic=20 unseeded: detectionRate 0.67, held 33%, 28 LOST — the
  field signature). Fix: predicted-LK seeding — each LK pass records the
  MEDIAN flow of its survivors; the next pass starts from prior positions
  + flow × (frame-interval ratio), via OPTFLOW_USE_INITIAL_FLOW (capture
  timestamps now ride the frame message: sdk `ts:`, worker →
  `processFrame(gray, ts)`). Runtime-probed (falls back if the WASM lacks
  the flags overload; `debug.lk_seed` = 1/0/-1). DEFAULT ON. Paired
  verdicts: under stalls (lk-seed-hic, 24 pairs) slam held 32.6%→100%
  (7W/0L), detectionRate 0.77→0.90, fusedP90 25.8→14.1cm, proc FLAT
  (slightly cheaper: fewer re-detect cycles); without stalls (lk-seed, 24
  pairs) neutral — gentle motion rarely reaches the 1.5px seed threshold.
  Known residual: the map-pose jump gate allowance counts FRAMES
  (`mapMaxJumpM × min(4, framesSincePose)`) not elapsed TIME, so a
  post-stall map pose can be jump-rejected; timestamps are plumbed now —
  time-calibrate it if field logs show `jump=` rejections after spikes.

### Full trajectory coverage (2026-07-04)

The original five trajectories all moved in the horizontal plane ("orbit"
was a flat lateral ellipse). Five new ones close the gap — same table in
sim.html and twin.html (kept in sync by hand), `roll:` field in a
trajectory adds in-plane camera rotation (`gtPose` applies it about the
optical axis after lookAt):

| traj | motion | @720px/noise2 |
|---|---|---|
| vertpan | rise/dip ±1.1m, poster exits TOP/BOTTOM | held 100% — floor/ceiling map bridges vertically |
| tilt | pure pitch ±68° from parked (no baseline) | was held 10% → **100% with rotOnly** (below) |
| yaw | pure yaw ±70° from parked (no baseline) | was held 5.7% → **100% with rotOnly** |
| roll | ±40° about the optical axis, poster centered | tracks (raw 0.92cm) — KLT/H survive in-plane rotation |
| arc | ±70° arc around the CONTENT anchor + vertical bob | detectionRate 1.0, raw 1.12cm — oblique poster holds |
| overhead | rise ~1m, look down ~60° at the content | tracks (raw 1.28cm) |

Seed-robust numbers: results/traj-coverage.

## Rotation-only tracking mode (2026-07-05) — the no-baseline gap, closed

Pure rotation produces zero baseline, so the map cannot triangulate and
has nothing to bridge with when the poster rotates out of view (tilt held
9–10%, yaw 5.7%, deterministic — physics, not tuning). The fix, DEFAULT ON
(`rotOnly`), is a SIX-part system — every part exists because a measured
failure of the previous iteration demanded it (traces in the session log;
the intermediate variants that looked plausible and failed: naive
compose-on-prior 25cm frozen bias; speed-EMA engagement gate deadlocked
by the slide it was guarding against; window-speed gate flip-flopped
seed-to-seed on pose jitter; full sleep() on snap starved reloc capital;
aggressive 3-frame absolute retry reacquired oblique junk poses):

1. **`Geometry.rotationOnlyGN`** — depth-free 3-param GN on the infinite
   homography (x' ~ K·R·K⁻¹·x), Huber-robust, over the frame's surviving
   LK flows (POSTER + env: at the poster→rot-only handoff the poster chain
   is usually the only flow substrate alive — raw LK flows are valid
   rotation evidence regardless of what PnP thinks of the chain).
   tests/test_geometry.js 20/20 (pure rotation to 0.009°, 20% outliers
   OK, translation betrays itself via inlier fraction).
2. **Rot-consistency guard** (`rotOnlyFakeTransM`): an oblique/degraded
   poster chain does not fail loudly — it SLIDES (~3cm/frame of fake
   translation, under the jump gate), fakes baseline, poisons
   triangulation AND the noisePx floor, which loosens strongThresh — a
   feedback loop measured at 25cm frozen error. When the flow field is
   cleanly rotation-explained but a sub-45-inlier poster claims >1.5cm
   translation in one frame, the frame goes to the flow-measured rotation.
3. **Corner-harvest lifeline**: a sustained rotation sweeps 2–3 candidates
   out of the FOV per frame; replenishment fires EARLY (points+cands < 24,
   cadence 3, emergency 2 below 8 candidates) under the rot-only pose.
4. **Survival gate** (`rotOnlySurvival` 0.55, measured on ENV flows so the
   poster chain's legitimate oblique death doesn't read as one): a
   viewpoint DISCONTINUITY kills most flows in one frame (teleport: 25%
   survived) — the zombie minority must never seed a rotation lock;
   honest LOST reopens the fast reloc path.
5. **Translation detector** (`rotOnlyDriftDeg` 1.0): at engagement all
   candidate anchors are REBASED onto the freeze pose
   (`EnvMap.rebaseCandidates` — pre-freeze anchors carry the slide's
   phantom baseline); thereafter a static point seen from an unmoved
   center keeps its ray direction under any rotation, so a median
   anchor-ray angle above 1° means the camera is REALLY translating (the
   planar-scene flow ambiguity is invisible to residual gates, but not to
   parallax) → exit to honest LOST. This is what bounds the mid-walk
   frozen-center capture to ~2 frames.
6. **Fly-through catcher + absolute retry**: the measured ROTATION makes
   the poster's predicted DIRECTION trustworthy even with a frozen
   center, so when the poster is predicted in-view, a targeted ROI detect
   runs EVERY frame (a tilt swings the poster through a ~6-frame window;
   cadence-12 missed it and the second tilt half died unrecoverable).
   When predicted out of view, a sparse absolute-mode retry alternates
   half/full detects + dormant relocalization (a zombie lock once
   predicted the poster offscreen forever). On reacquire with >10cm drift
   snap, rot-anchored candidates are flushed (`dropRotAnchored`) — their
   frozen-center anchors would fake snap-sized baselines (a full sleep()
   was tried instead and STARVED reloc: tracked points' world-X is valid
   reloc capital a parked camera can never rebuild).

Scope gate: rot-only runs ONLY in the no-map regime (`env.size() < 12`).
With a real map present, a map failure means the camera is translating
through a rough patch, and translation over a near-planar scene fits a
rotation cleanly (fundamental ambiguity — measured slam rawP90 6.8→25cm
without the gate).

FINAL paired verdict (results/rot-only, 24 pairs, off→on, 8/8 unless
noted): tilt held 10.2→100%, LOST 30→0, fusedP90 77.6→2.6cm, proc
14.7→7.0ms; yaw held 5.7→100%, LOST 30→0, fusedP90 47.6→4.9cm, proc
23.5→5.5ms; slam LOST 15→0, detectionRate 0.96→1.0, mapPeak +4, fused
median tied, at +1.8cm rawP90 median tail (the parallax detector halved
the pre-detector 4.4cm ambiguity cost). All suites green including
test-slam 14/14 with blind-teleport relocalization (3.8cm from a
44-entry bank); 11-trajectory coverage: detectionRate 1.0 and LOST 0 on
every trajectory. `debug.mode = 'rot-only'`, `debug.fake_trans` when the
guard fires.

## Optimization ladder (2026-07-05, in progress) — per-step measured multiples

Baseline (experiments/bench.json, 720px/noise2, medians of 4 seeds): the
historical "60Hz collapses the map to 27% held" is GONE — the 2026-07
rounds (res-scaling, bootstrapV2, seeding, rot-only) fixed it as a side
effect; 60Hz now holds 100% and pose-age P50 is already 16.7ms. What 60Hz
costs today is ACCURACY (slam fusedP90 11.3→23.6cm) and spike tail
(procP95 77ms). Scoreboard: `node tools/opt-table.mjs`.

- **perfV1 — SHIPPED**: sub-pixel refinement on RANSAC inliers only,
  pooled hot-path arrays (per-frame GC), noisePx cold-start from the
  median of the first 5 strong frames. Verdict: tilt raw 2.49→2.15cm
  (cold-start un-poisons the gates), robustness untouched, proc flat
  in-harness (the GC relief is a device-side effect SwiftShader can't
  show).
- **fastRefresh — REJECTED (measured dead end, flag kept for the
  record)**: half-res refresh ORB + full-res sub-pixel re-snap. slam
  rawP90 12.9→27.9cm, fastpan raw 1.39→3.65cm, and NO in-harness proc
  win. The pre-subpix verdict stands: half-res keypoint SELECTION quality
  cannot be snapped back — anchors need full-res corners.
- **timeCal — REJECTED after three measured iterations** (flag kept,
  default off): converting frame-count constants to time is right in
  principle but failed twice in practice. v1: the refresh cadence bounds
  LK CHAIN DRIFT (per tracking STEP, not per second) — time-stretching it
  doubled fastpan raw error. v2 (refresh excluded): slam@60 still
  collapsed bimodally (fused P90 to 51cm on seeds) — the time-scaled jump
  allowance shrank into the map-solve NOISE band (pose noise does not
  shrink with frame rate). v3 (noise-floored allowance): still bimodal.
  Verdict: 60Hz already holds 100% at baseline with pose-age 16.7ms; the
  remaining timeCal upside was ~1.2× proc — not worth the seed-dependent
  catastrophes. The constants stay frame-calibrated; revisit only if a
  target device actually runs vision far from ~15-20Hz.
- **lkFast — SHIPPED (carry-over pyramids)**: each image is pyramidized
  once instead of twice (buildOpticalFlowPyramid ping-pong, frame-tag
  validity, runtime probe). LK-bound frames ~12% cheaper (fastpan
  16→14ms), numerically identical (paired raw errors tie exactly). The
  seeded one-level-cut rides a SEPARATE flag (`lkFastLevels`, off): it
  changes numerics for ~2-4% more proc and nudged deterministic suite
  bars — not worth it without its own verdict.
- **perfV1 cold-start, redesigned once**: leaving noisePx null for 5
  frames re-rolled test-slam's chaotic early-bootstrap window (14/14 →
  10/14 — isolation matrix pinned it to the cold-start, not the subpix
  placement). Final form: seed at frame 1 exactly as calibrated, then
  SNAP to the median of the first 5 strong samples — a repair for
  polluted starts, a near no-op on clean ones. 14/14 restored at full
  defaults.

## Worker-split v2 + tracking-honesty round (2026-07-05)

v1's A/B rejected `splitDetect` on two failure classes; root-causing them
exposed a deeper bug in the BASELINE that had been silently inflating its
scores. All fixes are flag-gated (`chainGuard`, `relocV2`) pending their
paired verdicts; split-v2 mechanics changes apply only under `splitDetect`.

### The phantom-resurrection bug (chainGuard) — baseline was cheating

The sim's slam trajectory ends with a BLIND teleport (poster hidden from
frame 125). The off-mode "recovery" that beat split in the v1 A/B was a
PHANTOM: when a track fit fails, the stale chain layout is retried next
frame (deliberate blur forgiveness) — but geometry alone re-validated it.
A homography accepts ANY coplanar texture, so after the cut the old layout
re-cohered on the WALL BEHIND the hidden poster: 66 "inliers" at 1.5px
reproj, detected=true, 11→48cm drift, map candidates triangulated off the
phantom pose. Field analog: content gluing itself to an occluder (hand,
sheet of paper) after it covers the marker.

`chainGuard` (flag): sample 8 small zero-mean gray templates at strong
fits; a fit that succeeds RIGHT AFTER >=1 failed frame (a resurrection)
must prove its pixels still match (median NCC >= 0.3) or the chain is
dropped — recovery then belongs to the descriptor-verified detect/reloc
paths. Detect-built chains reset the streak (a detect IS appearance
proof). Measured on the teleport: phantom killed, honest rot-only freeze
at ~23cm replaces fake 7-48cm "tracking"; slam rawP90 6.4→22.9 is the
LIE BEING REMOVED from the metric, not a regression (detectionRate
1.0→0.993 same reason). Templates cost 8 patch copies on strong frames;
NCC runs only on resurrection frames.

### Small-bank / off-prior relocalization (relocV2)

The split-mode teleport trace (26-entry dormant bank, prior ~25cm off)
died in reloc, and the failure ladder was instructive — each stage fixed
revealed the next:
- **Ratio-test starvation**: 0-1 of 26 bank descs ratio-matched ~1000
  scene features (popcount probe proved the desc BYTES healthy at ~140
  bits). On self-similar low texture, best ≈ second-best by construction.
  Fix: absolute-Hamming rescue tier in the SIMD matcher wrapper
  (`relocAbsHamming` 80; re-observations sit 20-75 bits, cross-match
  noise centers ~128) + bank-scaled match floor (never below 8, classic
  12 above).
- **Descriptor aging**: descs captured ~100 frames earlier under noise +
  exposure drift decorrelate. Fix: dormant-desc refresh — on detect
  frames while a pose is live, project in-view dormant points and
  re-capture their descs from the already-computed scene features (desc
  distance AND position-radius double gate; measured dR16/dR17 refreshes
  per detect frame; zero extra ORB cost).
- **Blind-DLT degeneracy**: ITERATIVE PnP without a guess needs
  non-planar >= 6; teleport-window match sets are often wall-planar.
  Fix: prior-seeded coarse→fine GN funnel — stage 1 (huber 24px/outlier
  48px, 10 iters) only has to CONVERGE from a teleport-scale prior error
  (motionOnlyGN's gross-outlier drop otherwise discards every match
  before convergence when the init is ~100px off); stage 2 re-classifies
  at tracking-grade gates scaled by `relocGnScale` 1.6 (dormant 3D
  carries frozen triangulation error) and owns acceptance. Small support
  (<10 GN inliers) additionally demands tight meanErr — a wrong reloc is
  worse than staying LOST.
- **The honest limit**: on the trace that started all this, reloc STILL
  cannot fire — the bank's 3D was drift-poisoned (the poster-truth cull
  at reacquisition killed the tracked siblings for exactly that reason;
  the parked camera then had no baseline to rebuild). That tail is
  honestly unrecoverable; both arms now report it as LOST instead of one
  arm hallucinating. KNOWN RESIDUAL: dormant entries never get
  poster-truth re-verification — an epoch-invalidation (flush dormant
  when the cull wipes a large map fraction under a strong poster) would
  keep poisoned banks from wasting reloc attempts.

### Split v2 mechanics (under `splitDetect` only)

- **Pose-critical cheap detects went back to synchronous**: fly-through
  and predicted-ROI retries are ~5-20ms targeted passes whose pose
  ANCHORS the rot-only freeze / drift snap — v1 sent them async and the
  stale-forwarded install biased the freeze anchor for a whole sweep
  (tilt raw 2.4→7.5cm, the dominant v1 rejection). The split's win was
  never these; it is the full-detect spike class (refresh, retry-abs),
  which stays async.
- **Stale-install guard**: an absorbed install may not replace a healthy
  live chain when its forwarding hop spans real motion
  (`splitInstallMaxSpanPx` 24, reply age × median flow; a clearly
  stronger reply stretches it 2× at most — an uncapped strength bypass
  re-admitted exactly the installs the guard exists to block, because
  sweeps thin the live chain while service replies stay fat). Measured:
  raising the cap to 64 made tilt WORSE (raw 3.1→4.3-9.0) — mid-sweep
  installs are inherently a downgrade vs the live sub-pixel-arrested
  chain (ORB-quantized anchors matched on blurred frames), so the guard
  blocking them is the correct behavior, not a workaround.
- **Per-frame ring forwarding**: stale replies hop through the retained
  grays one frame at a time (same conditions as the live chain's LK)
  instead of one multi-frame LK jump; side-effect-free (seed/pyramid
  state saved around the whole chain).
- **Cold-window refreshes are synchronous** (`trackingFrames <
  6`): the first refresh after (re)acquisition repairs a weak first fit
  and seeds the noisePx floor — pose-critical, like the fly-through
  class. The v1-era guard only fell back to sync while the service WASM
  was BOOTING; with the service ready at frame 0, the frame-1 refresh
  went async and its 1-frame gap was enough for the tilt sweep to carry
  the poster out of view before the reply landed — rot-only then froze
  on the 8.9cm frame-0 bias for the entire session (tilt seeds 1/2: raw
  2.5→7.4-9.0cm; the frame-1 SYNC refresh pins 1.5cm). This was the
  actual mechanism behind most of v1's "tilt regression", not the
  install hop error — the guard/sync-flythrough/ring-forwarding fixes
  each removed a real but smaller slice, and the 4-seed re-check after
  this fix reads 2.13-2.68cm (v1: 7.5-class on 4/4).
- **Same-frame-only installs**: an absorbed install unconsumed by §1
  (state was SEARCHING that frame) is discarded at end of frame — a
  frame-late adoption handed §1 stale coordinates as "current".

### Round verdicts (2026-07-06) — defaults flipped, baseline re-accepted

- **opt-f (pack value, split off, 24 paired runs)**: fastpan/tilt raw
  errors tie EXACTLY (bit-neutral where nothing triggers — the designed
  blast radius); slam P90 rises for the pre-registered reason (honest
  freeze/LOST replaces the phantom's fake 7-48cm "tracking"). chainGuard
  + relocV2 now DEFAULT ON.
- **opt-g (split off→on, pack in both arms, 24 paired runs)**: v1's
  rejection classes are GONE — tilt raw ties at 2.49 (v1: 7.5-class on
  4/4), slam fused median WINS 3/1 with fewer LOST and procP50 4/0
  faster, fastpan carries a small consistent raw cost (~0.1-0.3cm
  pairwise, residual install-hop noise). `splitDetect` STAYS default
  false: in-harness parity means the flip decision belongs to on-device
  testing, where the spike-class win (v1: same-machine procP95 91.9→37.2)
  actually lives.
- **perf-gate**: slam720 lostFrames 0→1 and procP50 ~+3ms flagged as
  expected — the LOST tail now runs real SEARCHING detects + reloc
  attempts instead of a 3ms phantom track; the cost of honesty, confined
  to the post-teleport window (fastpan/tilt held or beat the floor).
  Baseline re-accepted 2026-07-06 (slam 14.6/fastpan 15.9/tilt 6.9ms
  procP50; slam lostFrames=1 is the honest chainGuard kill frame).

Diagnostics added this round: sim `?snap=` (PNG dataURLs of the exact
degraded frames in `window.__SNAPS__`), dump columns dR (dormant
refreshes) / CHKILL (chain kills with NCC), and reloc failures report
their killing stage in `rl:` tags (m/gn[..]/far/rv + seeded).

## Drift back-propagation at reacquisition (2026-07-07, `driftComp` DEFAULT ON)

The poster snap at reacquisition MEASURES the map's accumulated VO drift
(`reacquire_drift_m`) — and then used to leave the error IN the map for
refineAndCull to execute: a 3-4cm-drift reacquisition measured 21 points
→ 0 within 3 frames, and the executed points' descriptors descended into
the dormant bank with drift-poisoned 3D (the exact chain that made the
worker-split round's teleport tail unrecoverable by any honest reloc).

`EnvMap.applyDriftCorrection` aligns the map to poster truth instead
(X' = A·X, A = T_p⁻¹·T_m), with evidence-scoped application:

- **Tracked points** move only when the correction reduces reprojection
  error against their live KLT observation (same evidence the cull uses);
  their anchor lineage moves with them so re-triangulation stays
  self-consistent. Measured: on the slam trace ZERO tracked points
  accepted the rigid snap — the map GN had absorbed the drift into the
  POSE, so their X was already truth-adjacent, and the cull was right
  about the rest. The value lives elsewhere:
- **Candidate anchors** are corrected unconditionally (candidates are
  young by construction — they mature or die within frames, so they carry
  ~the measured end-drift). This is the load-bearing piece: +tr 12 the
  same frame, map rides 18 points through the post-reacquisition stretch
  instead of 3 — the insurance a poster loss in that window needs.
- **Dormant points** have no observation to test — corrected
  unconditionally as best estimate, but only entries born in the CURRENT
  drift epoch (`ep` stamp, epoch bumped per correction): an entry stored
  before the previous correction was aligned then and its X frozen since;
  re-applying every new delta would random-walk the bank on revisit-heavy
  sessions.

Trigger: strong poster, reference map pose ≤2 frames stale (reacquisition
lands WEAK at the view edge and strengthens 1-2 frames later — the
age===0 form never fired; ≤2 frames of gap motion is cm-bounded and the
per-point gate absorbs it), drift in [1.5cm, 0.5m] (below: refinement is
cheaper; above: tracking break, not drift). Runs after the rot-anchored
flush (fake-baseline candidates are garbage, not drift).

Verdict (opt-h, 24 paired runs): EXACT ties on every deterministic axis,
zero regression, proc flat — the win is structural and trace-visible
(dump tag `DC[moved/total+dN]`). Gate passed without --accept. Watch
signature if this ever regresses: slam seed1 map count at frames 107-124
(18 with, 3 without).

## Custom SIMD LK kernel + fusion velocity rework (2026-07-07)

User mandate: reduce latency and error, custom kernels allowed. Per-stage
timers (dump tag `tm[lk|sp|fit|pnp|map|mnt|dm]`) settled where the
milliseconds actually live: **cv.calcOpticalFlowPyrLK was 9-10ms of an
~11ms tracking frame at 720px** — everything else (subpix, RANSAC fit,
PnP, map GN, maintenance) is 0.1-0.5ms. (Also surfaced: the bootstrapV2
corner-harvest pass costs ~9ms every other frame while the candidate
pipeline is hungry — a future target.)

### tools/lk.c — pyramidal Bouguet KLT in ~10KB of WASM SIMD

Same shape as the matcher kernel (standalone wasm, embedded base64 in
`lk-kernel.js`, runtime-probed, cv fallback everywhere): [1 2 1]²/16
pyramid with PAD-wide borders, Scharr-style i16 gradient planes built
lazily when an image becomes the template side, 14-bit fixed-point
bilinear (cv's exact W_BITS/W_BITS-5 scales, so G and b scale factors
cancel and delta lands in pixels), template+gradient windows interpolated
ONCE per point-level, iteration loop resamples only the current image,
`i32x4.dot_i16x8` for every window reduction with per-row f32
accumulation (full-window i32 would overflow), cv's exact delta formula,
oscillation damper, and per-pixel-L1 err scale (the pipeline's errMax
gate transfers unchanged). Slot protocol: two resident pyramids uploaded
once per frame (frame-tagged); track() pairs (frame-1, frame) and
returns null after gaps — cv covers that frame. Absorb ring-hops and
fbCheck stay on cv. Unit test `tests/test_lk_kernel.js`: recovers known
sub-pixel shifts to 0.005-0.016px median through 4 levels, seeded and
unseeded.

### The two border-semantics bugs (found by differential harness, not by eye)

`cfg.lkKernelDiff` runs kernel AND cv on identical inputs each frame and
reports survivor-set disagreement + position deltas ('cv' arm: cv drives;
'kern': kernel drives). On shared trajectories the kernel matched cv to
**d0.00px median / dis0** — yet kernel-driven runs collapsed (slam raw
1.7→7.2, mapPeak 59→37). The deltas localized to dis-spikes exactly at
the POSTER-EXIT window (frame 53: kernel kept 10 edge points cv killed) —
the chaotic-bootstrap coin lands there:

1. **Image border must be REFLECT-101, not replicate** (cv's pyramid
   border): replicate smears edge windows, their gradients and err
   collapse, and the err gate keeps half-off-image points cv kills.
2. **Derivative borders must be ZERO, not mirrored** (cv zero-pads the
   deriv pyramid): border-crossing windows must be anchored by in-image
   gradient energy ONLY — mirrored gradients injected phantom energy
   into exit-window templates (the tilt freeze-anchor 2× class: 2/4
   seeds re-rolled until this fix; after it, tilt seeds 2/3 came out
   BETTER than cv: 1.82/1.33 vs 2.57/1.48).

METHOD NOTES for future kernel work: (a) a unit test on synthetic
textures proves the math, not the SEMANTICS — the differential harness
against the reference implementation on real footage is what found both
borders; (b) never compare against a baseline trace from another code
era (a "68 vs 97 inliers at frame 2" panic dissolved when today's
baseline showed 68 too — the 97 was pre-driftComp history); (c) warmup
frames must run the exact cv sequence a kernel-less session runs
(LkKernel.init deliberately AFTER warmup), else cv's internal RNG state
shifts every subsequent RANSAC draw.

### fusionV2 — windowed weighted-LSQ velocity

The incremental (alpha-beta) velocity estimator differentiates
consecutive noisy innovation pairs — its output noise dominated fused
error (2.08cm fused vs 0.83 raw at 720px). `fusionV2` fits v by
recency-weighted linear regression over the last `velWinN` vision
positions at their CAPTURE times: ~3× less velocity noise at K=5, and
irregular correction delivery stops mattering because the fit runs on
capture timestamps. A >0.5s hole flushes the window; reset clears it.
### Round verdicts (2026-07-07) — lkKernel shipped, fusionV2 rejected

- **opt-i (lkKernel, 24 paired runs): DEFAULT ON.** Quality ties across
  slam/fastpan/tilt (held/lost/det identical on every pair, error deltas
  in the ±0.3cm noise band, tilt slightly better); procP50 wins 12/12
  pairs at −25-33% (pairwise −1.8 to −3.6ms). Perf baseline re-accepted:
  slam 14.6→8.9ms, tilt 6.9→2.9ms procP50, all quality guards intact.
- **opt-j (fusionV2, 24 paired runs): REJECTED** (flag kept for the
  record). Fused error WORSENED where it was meant to help — fastpan
  fusedMedian 1.65→1.93 (4/4 pairs), slam +0.13 — the constant-velocity
  window fit lags real accelerations (fastpan is sinusoidal) while the
  incremental estimator at predictive taus already has the bandwidth.
  Revisit only with an acceleration term or much shorter windows. Raw
  metrics tied EXACTLY (fusion never feeds back into vision) —
  confirming the harness isolation.
- **60Hz posture TRANSFORMED** (spot check, slam seed1 @60): held 100,
  fusedP90 6.64cm (bench-era 23.6), procP95 27.6ms (was 77), pose-age
  P50 16.67ms — HALF the 20Hz latency at BETTER fused accuracy. The
  "60Hz costs accuracy" finding was proc-pressure, and the kernel
  removed the pressure. index.html can now consider 60Hz capture.
- Remaining measured hot spot: the bootstrapV2 corner-harvest pass
  (~9ms every other frame while candidates are hungry) — next round's
  candidate alongside a kernel-side subpix refiner.

## Kernel round 2: FAST-9 harvest + edge hysteresis (2026-07-07)

Field-session follow-ups. The corner-harvest pass ran full cv.ORB.detect
for POSITIONS only (~9ms on device, every candidate-hungry frame — the
#2 profiled hot spot); `fast9()` now lives in the same wasm module as LK
and runs on the pyramid ALREADY RESIDENT for tracking (zero upload):
SIMD compass quick-reject (necessary condition: a 9-contiguous arc must
contain one of each opposite compass pair), scalar segment-test confirm,
3×3 NMS, Shi-Tomasi minEig scoring from the resident gradient planes.
Worst maintenance frames 27ms → 5ms; slam procP50 8.9 → 5.9 in the
single-run probe.

**Three measured iterations to get the SEMANTICS right** (same lesson as
the LK borders — the unit test proves math, the system A/B proves
meaning):
1. FAST arc-contrast scoring alone: tilt held 100→61%, mapPeak −7..−10.
   The arc score admits edge-like, weak-eigenvalue corners that die
   young in KLT.
2. minEig scoring WITH an absolute floor: tilt still collapsed (18-62%
   held). The floor culled the marginal corners rot-only needs as 2D
   flow sources, exactly in the starved regime.
3. MULTI-LEVEL detection (L0-L2 of the resident pyramid) + minEig as
   RANKING ONLY: at high pitch the view is foreshortened, blurred
   ceiling texture where level-0 FAST finds nothing while coarse levels
   fire (harvests had dwindled 17→7→2 into rot-only starvation). Tilt:
   4/4 held 100, seeds 2/3 BETTER than the ORB path.

**Verdict (opt-k 24 pairs + phone A/B): SPLIT — texture decides.**
- Sim battery: slam quality WINS (fused −0.59, raw −0.09), tilt exact
  ties, fastpan small consistent cost (raw +0.19 4/0; the `dump-run
  --sums` ledger shows EQUAL candidate productivity — churn timing).
- **Phone A/B (rich real texture): clear win** — proc spikes 79→31ms
  max, map median 3→7 pts, state transitions halved (52→26), LOST 6→1.
  The ARM ORB-vs-FAST gap is what SwiftShader understated.
- **test-slam (SMOOTH synthetic room): 14→9** — the map died
  mid-stretch (55→0 pts), froze rot-only 66cm off, and the teleport
  reloc then accepted a 109cm pose from the stretch-poisoned bank. On
  low-texture surfaces FAST corners lose to ORB's Harris/octave digging
  even above a yield-floor ORB fallback (shipped anyway: <120 corners →
  ORB that frame).

`harvestKernel` therefore ships DEFAULT-FALSE (one red suite at defaults
is a hard protocol no), field-usable TODAY via the new **index.html
`?cfg=` passthrough** (same contract as sim.html; overrides are rlogged
as `cfg-override`, making field logs config-attributable). Flip pends
low-texture parity — candidate next steps: sub-pixel corner
localization in fast9, scene-adaptive threshold floors.

**splitDetect phone verdict: REJECTED on this hardware class** — the
second WASM worker on a budget Android cost more than it saved (proc
median 25→36ms, max 277ms, fps 18→11). Mechanics remain proven in-sim;
revisit gated on hardwareConcurrency, not by default.

**edgeHysteresis DEFAULT ON** (opt-l: EXACT ties on every deterministic
axis across 24 pairs — the sim has no hover regime, so no-harm is the
provable bar): the weak-poster boundary is a band — enter MAP_TRACKING
below 30 inliers, the poster retakes the pose only at ≥38. Targets the
field-log flap class (6 TRACKING↔MAP_TRACKING transitions in 2.5s with
the poster hovering at the view edge).

## World-class iteration round (2026-07-07): texture axis, fast9 v2, zombie-suppression fix

User mandate: experiment, test in the sim, iterate. The round closed the
harness gap that let three verdict sources disagree by environment, and
pulled two structural threads out of the disagreement.

### The sim can now SEE texture (`?tex=`)

`?tex=` scales speck density AND contrast of every environment surface
(tex=1 verified ledger-identical to the classic scene; profile echoes
tex; spec.mjs passes it through). First finding: below ~0.4 is beyond
the physics floor (everyone dies); the DISCRIMINATING band is 0.5-0.8.
Second finding: single runs at low tex invert chaotically (tex 0.5
seed1: FAST held 100 / ORB 17, while test-slam's smooth room rolled the
opposite) — P(hold) over seeds is the only valid detector ranking,
which test-slam's single choreography cannot provide.

### fast9 v2: sub-pixel + scale-normalized + deep pyramid

Three upgrades, each measured: (1) one-shot Foerstner sub-pixel solve
from the same 7×7 gradient sums as the minEig score (integer FAST
corners carried 0.5px anchor quantization into triangulation; the
109cm post-teleport reloc dropped to 2.4cm with well-localized bank
3D); (2) scale-normalized scores (minEig/2^L — unnormalized, coarse
corners outranked fine ones and the strongest-first harvest went
coarse-heavy with 2-4px anchors); (3) levels L3-L4 (the far-plane
lifeline: stretched backdrops render as mush where L0-L2 starve).
**Texture battery verdict (opt-m, 24 pairs × 4 tex): fast9 ≥ ORB
everywhere, DOMINANT at low tex — tex 0.5 held 100 vs 17 (6/6 pairs,
mapPeak 46 vs 2), tex 0.65 held 100 vs 23. The default ORB pipeline was
the one collapsing in low-texture rooms.**

### The continuous-zombie suppression bug (found via test-slam's timeline)

test-slam printed 84 consecutive MAP_TRACKING frames with ZERO detect
attempts while the poster sat visible: a weak 2D chain that degrades
GRACEFULLY onto background texture (never failing a fit, so chainGuard's
resurrection gate never fires) suppressed the ENTIRE §3 recovery ladder
just by keeping `result` non-null. Fix (under `rotOnlyHuntFast`):
recovery hunting keys on POSE OWNERSHIP — while the map/rot-only owns
the pose and the poster result is weak, the retry ladder runs anyway
(plus: rot-only retries at cadence 3 instead of the lazy interval, and
every 3rd escalated attempt goes full-density/full-res — the subsampled
target cannot match small/oblique posters). Verified structurally:
timeline went M×84 → reacquisition at ~f102 with the drift metric
firing.

### Why both flags still ship default-FALSE

Every flip candidate re-rolls test-slam's chaotic TELEPORT TAIL into
reloc-variance basins: across otherwise-identical rolls the post-teleport
reloc landed at 2.4 / 41 / 57 / 109cm — the accepted pose quality is a
function of the dormant bank's triangulation history, which the current
one-shot reloc cannot verify without ground contact. That SMALL-BANK
RELOC 3D-QUALITY frontier (keyframe reloc / sliding-window BA, already
on the roadmap) now gates: harvestKernel's flip, rotOnlyHuntFast's flip,
and the tail of the honesty work. It is the next round's target. A
"reloc probation" (retract a reloc whose post-accept map-GN health
collapses) is the cheap candidate; keyframe banks are the real answer.

Suites: all green at defaults (test-slam 14/14 restored), gate passed.
Field builds get both candidates via index.html `?cfg=`.

## Reloc-quality round (2026-07-07): keyframe reloc + probation — THE STACK SHIPS

The frontier that gated everything fell. `relocV3` makes reloc pose
quality a property of GROUND-CONTACTED snapshots instead of unverifiable
bank history:

- **Keyframe tier**: right after refineAndCull under a STRONG poster
  (the metric ground-contact moment), the desc-bearing tracked points
  are deep-copied into a keyframe (ring of 3, cadence 15 strong frames).
  `_tryRelocalize` tries keyframes freshest-first before the classic
  dormant soup; telemetry tags the winning source (`reloc_src`).
- **Probation**: every accepted reloc serves an 8-frame window; two
  jump-gate fights inside it (the measured 41cm-basin signature) retract
  to honest SEARCHING — desc capital sleeps to dormant, a 10-frame
  cooldown stops accept/retract flapping.
- **Suspicion-gated hunting**: rotOnlyHuntFast's escalation (cadence 3,
  every-3rd full-density attempt, weak-zombie override) fires only when
  the fly-through has MISSED >=4 predicted-in-view attempts — a freeze
  that keeps finding its poster is healthy and hunts lazily.
  Unconditional escalation had cost tilt fusedP90 2.59→13.2; gated,
  tilt returned to EXACT ties.

**Verdicts (opt-n trio + opt-n-tex, 72 paired runs, 6 seeds):** tilt
exact ties, slam parity (small honest-retract tail trade), low texture
TRANSFORMATIONAL — tex 0.5 held 17%→100% (6/6), lost 28→2, mapPeak
2→46; tex 0.65 held 23%→100%. test-slam 14/14 WITH THE FULL STACK — the
first all-on configuration ever to pass. Accepted trade (rot-only
precedent class): fastpan fusedP90 +~1cm, mapPeak −10, proc +3.5ms —
the weakest-environment fix outranks the strongest-case tail.

**harvestKernel, rotOnlyHuntFast, relocV3 are all DEFAULT ON.** Perf
baseline re-accepted (slam 7.5ms procP50 / lost 1 = the honest
probation frame; fastpan 11.6; tilt 3.6).

### Fastpan-trade investigation (2026-07-07, closed as intrinsic)

Frame-aligned dumps of the accepted fastpan trade: poster-visible
tracking is BIT-IDENTICAL between stack and base (every posErr matches),
stack maintenance is CHEAPER per pass (7-8 vs 10-15ms — the battery's
proc medians were harness load noise; the device numbers are the real
proc story), and the entire fusedP90 delta lives in EXIT WINDOWS where
the stack's map runs 5-10 points thinner. Candidate-budget experiment
(opt-p, mapMaxCandidates 40→64, 8 paired seeds): EXACT ties — the cap
is never binding (candidates sit at 0-10). The thinness is marginal-
corner SURVIVAL through triangulation, i.e. the intrinsic
detector-margin difference, correctly priced by the batteries. Debt
closed as understood-and-accepted; revisit only alongside the
sliding-window-BA work where candidate maturation changes anyway.

### Map-density round (2026-07-07: battery-won, suite-blocked, shipped OFF)

The candidate death ledger (new, permanent: `CD[lk/tri/flush/rot/promo]`
in dumps, `EnvMap.cd`) overturned the planned multi-view-triangulation
fix in one trace: candidates were never dying (fastpan: 120 promoted vs
15 dead) — the map size is an EQUILIBRIUM of harvest inflow vs FOV-exit
deaths, throttled by ORB-era knobs (low-water 12, cadence 4, 2/cell)
that the SIMD kernels obsoleted. `mapDensity2` raises the inflow
(24/3-2/3-per-cell), scoped to translation evidence (`env.size()>0`)
and never for rot-anchored harvests (unscoped, tilt seed 5 rolled
2.75→37.8cm through the rot-only flow substrate; scoped, tilt is 12/12
raw-exact-ties).

Battery (opt-q, 12 paired seeds × 3 traj + tex-0.6 guard): slam
fusedP90 23.9→14.8cm (9/3), rawP90 24.1→17.1 (8/4), lost median 1→0;
fastpan rawP90 4.19→3.71 (7/4); mapPeak +6; known cost slam@tex0.6
rawP90 +3.2 med-pair on a ~23cm chaotic baseline (9/12).

BUT test-slam collapsed 14/14 → 5/14 with ANY density lever on, and six
interventions failed at an INVARIANT ~50cm/25°: hold-entry candidate
trim, full-parallax gate (dropping bootstrapV2's 0.75 relaxation),
size-scaled refine budget, 3-strike purge (all four kept in-tree,
flag-gated — directionally right hardenings). The invariance was the
tell that the fork model was wrong: probes A vs D produced SAME-SIZE
maps (53 pts) with opposite outcomes, isolating the true fork in the
detect SCHEDULE — density shifts refresh timing so a full detect lands
on the receding VIEW EDGE (f53), the edge fit passes the strong-poster
bar carrying ~7cm bias, refineAndCull re-anchors p.X/p.b0 against that
biased view, and the map ITSELF enters the hold warped: GN+purge then
execute the truth minority and the pose spirals 4.7→57cm in 17 frames.
Stock survives the same handoff (its schedule skips the edge detect;
its unwarped map yanks the 13cm-biased prior back to 0.8cm) but then
creeps 0.8→11cm through the hold — the bias-absorption weakness is
STOCK's; density exposes it, doesn't cause it.

Verdict: default OFF despite the battery (the 14/14 bar is the bar; a
scenario the sim grid under-samples is not noise). NEXT ROUND: harden
edge-marginal poster maintenance at stock level (gate refineAndCull/
harvest anchoring on poster viewing geometry, not just inlier count —
the code's own comment already distrusts edge PnP), then re-flip
mapDensity2 and re-run opt-q; the battery wins are banked and waiting.

### Bias-absorption round: edgeGate (2026-07-08, DEFAULT ON)

The mapDensity2 postmortem predicted it; this round built it. strongPoster
(inlier count + reproj) passes at the view edge carrying cm-scale planar-PnP
bias, and maintenance anchored there TEACHES the map the bias. `edgeGate`
v4 (four iterations, each falsified by a measured failure):

- v1 hard geometry block (containment + area + obliquity): test-slam hold
  creep 11 -> 7.2cm median, but tilt's edge-riding poster froze ALL
  maintenance (mapPeak 5 -> 0, fused tail 2.92 -> 9.52 arm on bad rolls)
  and fastpan handoffs staled.
- v2 dropped the obliquity check (measured no-op everywhere): tilt still
  frozen - containment was the blocker (pitch slides the quad to the
  frame edge), not obliquity.
- v3 "provisional growth" tier (edge may harvest, not re-anchor): the
  edge-anchored provisional points entered the handoff map and the late
  hold died on them (map 11 -> 0 at f96, max 44.8cm).
- v4 = hard block + STARVATION VALVE (maps <15 pts and >30-frame freezes
  maintain anyway: building has little to poison, tilt gets stock
  behavior - 12/12 raw-exact-ties) + keyframes minted only at healthy
  geometry + driftComp exempt (reacquisition lands at the edge by
  nature; its per-point reproject-improves gate bounds the risk) +
  reloc REVIVE-SWEEP (the GN+probation-verified pose is evidence: every
  dormant reprojecting cleanly in-view revives, not just the matched
  handful - teleport rebuild 16 -> 34 pts; the alternative "rebuild
  burst" was reverted: fresh candidates cannot triangulate inside a
  short window, physics, and arming it at SEARCHING->TRACKING re-rolled
  the frame-0 bootstrap into the drift basin).

opt-r v4 (12 paired seeds x 3 traj): slam fusedP90 medDelta -1.86
(7/12), fusedMedian -0.83, lost median 1 -> 0; tilt EXACT ties; fastpan
fused tail +0.71 med-pair (medians tie) bought back as proc -3.9ms
12/12. Suites 14/14 + 13/13 + 9/9 + twin at the new default; perf gate
passed CLEAN (fastpan seed-1 proc 11.6 -> 5.9ms). GOAL BOARD 4/13 ->
5/13: held-drift@60Hz 19.24 -> 9.67cm (the G2a target trajectory),
proc-fastpan flipped ACHIEVED. mapDensity2 re-flip stays blocked: with
edgeGate the dens2 test-slam basin shrinks 50cm/25deg -> 18cm/7deg -
better but still over the 15cm/6deg bars; the residual dense-map
away-walk drift is a later round (likely alongside sliding-window BA).

### Loop protocol: the performance gate (standing rule)

Every loop iteration ends with `node tools/perf-gate.mjs` after the
correctness suites — performance must improve or hold, NEVER regress.
The gate runs three fixed deterministic cases (slam/fastpan/tilt @720px,
seed 1), compares procP50/P95 against `perf-baseline.json` (same-machine
history; proc suspects get ONE confirmation run — load transients don't
repeat, real regressions do), and hard-fails the round on a confirmed
regression. Deterministic quality guards ride along (lostFrames, held%,
raw error) so a "perf win" can never silently pay with accuracy. After an
INTENTIONAL, A/B-justified change, `--accept` rewrites the baseline — the
floor only ever moves on purpose, and the current floor is the best known
state (baseline accepted 2026-07-05: slam 10.4ms / fastpan 15.3ms /
tilt 4.8ms procP50, all cases 0 LOST, held 100%). Quiet machine required:
never run the gate concurrently with research batteries.

### Production self-healing (shipped with this round)

The vision worker can no longer take a session down: frame exceptions
return a result-shaped "not detected" (the SDK's backpressure loop never
stalls), a 3-error streak resets the pipeline (half-mutated state), and
the SDK auto-RESTARTS the worker — bounded at 3 attempts — on hard worker
errors, 8-error streaks, or a 4s in-flight stall (watchdog), re-initing
from a retained clone of the target buffer (the original is transferred
away). `workerrestart` events reach the phone log as `worker-restart`.

## Motion sensors REMOVED (2026-07-04)

The phone IMU stack was deleted on request after the platform measured its
value (results/imu-value-rot, 24 paired runs): fused POSITION identical with
or without it (the accelerometer was never integrated); fused ROTATION error
2–3× higher without it during fast motion (0.8→2.1° median, up to 7.3° p90)
— i.e. it bought rotation smoothness only. Removed: `static/js/
device-motion.js` (deleted), all `imuManager` wiring + IMU UI in index.html,
IMU prediction/history in model-renderer.js, motion/orientation permission
requests in camera-intrinsics.js, IMU branches in the A-Frame adapter. No
motion-sensor permission prompt remains anywhere.

KEPT: `FusionEngine` (provider-agnostic; runs vision-only with no provider —
`saveSnapshot(id, null, t)` still records capture time for latency
compensation) and its `setIMUProvider` interface, which the simulator/twin
use with a SYNTHETIC IMU for research (tests/test_fusion.js 9/9). If sensors
ever return, only the provider wiring needs re-adding.

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
