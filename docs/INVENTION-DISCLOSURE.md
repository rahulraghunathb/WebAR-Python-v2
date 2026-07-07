# Invention Disclosure — Marker-Anchored WebAR Tracking with Flow-Arbitrated Multi-Mode Trust

**Status:** CONFIDENTIAL — do not publish, demo publicly, or distribute before
consulting patent counsel. Public disclosure starts novelty clocks worldwide
and immediately destroys rights in absolute-novelty jurisdictions (EU, CN, JP).

**Prepared:** 2026-07-05.
**Applicant / inventor determination:** to be completed with counsel. The
mechanisms below were developed through iterative human-directed engineering
with AI assistance; inventorship (which must be natural persons in most
jurisdictions) should be determined with counsel before filing.

**Current disclosure exposure:** development testing only, via a private
tunnel to the developer's own device. No public demo, publication, or sale
offer has been made. Recommendation: file a provisional before any external
demo.

---

## 1. Field of the invention

Browser-based (WebAR) six-degree-of-freedom camera tracking from a single
RGB camera without inertial sensors, using a known planar image (a
"marker" / poster) as the metric anchor, extended with an environment map
so tracking continues when the marker leaves the view.

## 2. The problem

A monocular, IMU-free tracker has three structural failure classes that
standard pipelines (marker tracking + PnP; keypoint SLAM) do not solve
together:

1. **Oblique-marker pose slide.** As the marker becomes oblique or exits
   the view, its pose solution does not fail loudly — it slides by a few
   cm per frame (under any plausible jump gate). The slid poses fake
   camera baseline, which triangulates garbage 3D structure, which then
   *confirms* the slid position: a self-reinforcing feedback loop
   (measured: 25 cm stable error). The slide also inflates any learned
   noise model, loosening the very thresholds that should have rejected it.
2. **The no-baseline regime.** Pure camera rotation (user looks up/down
   or left/right without moving) produces zero triangulation baseline —
   an environment map cannot exist, so when the marker rotates out of
   view there is nothing to bridge with (measured: 90–95% of frames
   untracked on rotation-only paths).
3. **Rotation/translation ambiguity.** Over near-planar scenes, camera
   translation produces an optical-flow field that fits a pure rotation
   with low residual. Any "rotation fallback" that freezes position will
   therefore mis-track real walking (measured: 61.9 cm), and no residual
   gate can detect it — the ambiguity is geometric, not statistical.

## 3. Summary of the invention

A tracking pipeline in which **the raw optical-flow field arbitrates trust
between pose sources** (marker PnP, environment-map solve, rotation-only
estimation), and in which **candidate map anchors carry validity lineage**
that later absolute fixes can retroactively honor or revoke. Six
cooperating mechanisms; the system behavior (measured, N=24-48 paired
seeded trials per verdict, deterministic simulation of the real production
code):

| Capability | Before | After |
|---|---|---|
| Pure-pitch tracking (tilt) | 10.2% held, 30 lost frames | 100% held, 0 lost, fused P90 77.6→2.6 cm |
| Pure-yaw tracking | 5.7% held | 100% held, fused P90 47.6→5.3 cm |
| Oblique-slide error | 25 cm frozen bias | 3.6 cm |
| Mid-walk ambiguity capture | 61.9 cm / unbounded | bounded ≈ 2 frames (parallax exit) |
| Blind-viewpoint-jump recovery | relocalization bank starved (fails) | relocalizes at 3.8 cm from a 44-entry bank |
| Processing cost on rotation paths | 14.7–23.5 ms/frame (thrashing) | 5.2–5.5 ms/frame |

## 4. The mechanisms

### M1 — Flow-arbitrated marker trust ("fake-translation guard")

*Problem:* mechanism for failure class 1 (the slide).
*Mechanism:* every frame, a 3-parameter Gauss–Newton fit of the **pure
rotation** that best explains the surviving optical-flow correspondences
(the infinite homography x′ ~ K·R·K⁻¹·x; depth-free by construction;
Huber-robust). When the flow field is cleanly rotation-explained (inlier
fraction ≥ 0.5, residual within the learned noise budget) but a
sub-threshold-confidence marker pose claims more than ~1.5 cm of
translation in one frame, the translation is declared fake: the frame's
pose is taken from the flow-measured rotation composed onto the prior with
the camera center held fixed. Because the center freezes, the fake
baseline never forms and the triangulation-poisoning loop is broken at its
source. High-confidence marker poses (≥ 45 inliers) are exempt, so genuine
translation with a well-tracked marker is never blocked.
*Evidence:* frozen-bias 25 cm → 3.6 cm; side effect: map peak +4 points on
8/8 translation-path trials (cleaner anchors).
*Failed alternatives (non-obviousness):* per-frame jump gates (slide is
below any plausible per-frame threshold); pose-covariance gating (the slid
solution is internally consistent); demoting all low-inlier poses
(destroys legitimate edge tracking, measured earlier in development).

### M2 — Rotation-only tracking scoped to the no-map regime

*Problem:* failure class 2.
*Mechanism:* when marker and map both fail **and** the environment map is
fundamentally absent (fewer than ~12 points — the signature of a
no-baseline session rather than a rough patch), the flow-rotation fit of
M1 becomes the pose source: orientation propagates by the measured per-
frame rotation; the camera center is held. The scope gate matters: with a
real map present, a map failure usually means the camera is translating
through a degraded stretch, and (failure class 3) the flow fit would
accept it — measured cost of omitting the gate: translation-path 90th-
percentile error 6.8 → 25 cm.
*Evidence:* tilt 10.2%→100% held; yaw 5.7%→100%; processing cost halved to
quartered on those paths (the mode replaces futile full re-detection).

### M3 — Anchor-rebased parallax exit (the translation detector)

*Problem:* failure class 3 — bounding M2 when the user actually walks.
*Mechanism:* at the moment rotation-only engages, every stored map
candidate's anchor observation is **rebased onto the freeze pose**; from
then on, the median angle between each candidate's anchor ray and its
current ray is a direct physical translation detector: from an unmoved
center, a static point's ray direction is invariant under any rotation,
while real translation grows the angle with baseline over depth. Median
above ~1° → exit to an honest LOST (which re-opens absolute
re-localization) instead of sliding. This uses the same parallax physics
the map's triangulation gates already trust — inverted into a mode-exit
criterion. The rebase step is essential: pre-freeze anchors carry the
slide's phantom baseline and false-fire the detector (measured on parked
rotation).
*Evidence:* bounds mid-walk capture to ≈2 frames; halved the residual
translation-path tail cost of M2 (rawP90 +4.4 → +1.8 cm).
*Failed alternatives:* engagement speed gates from pose history — two
designs (EMA and windowed displacement) both failed measurably because
pose jitter at real noise floors (2–5 cm) is indistinguishable from slow
walking on any short window, and the oblique slide itself feeds the speed
estimate (deadlock).

### M4 — Retroactive anchor-validity accounting

*Problem:* candidates harvested during rotation-only carry anchors whose
camera center was *assumed* frozen. If a later absolute fix (marker
re-detection) reveals the center actually jumped, those anchors would fake
jump-sized baselines and triangulate garbage — which then descends,
descriptor-attached, into the relocalization bank and poisons it.
*Mechanism:* candidates born under a frozen-center pose carry a lineage
tag. On marker reacquisition, the measured drift-snap distance decides
their fate: small snap (true pure rotation — the center really was still)
→ anchors are valid, keep; large snap (> ~10 cm) → flush exactly the
tagged candidates. Critically, tracked map points are **not** flushed:
their world positions remain valid (the camera moved, not the world) and
they are the relocalization capital. (A full map reset here was tried and
measurably starved relocalization: a subsequently parked camera can never
rebuild what was thrown away.)
*Evidence:* blind-viewpoint-jump relocalization restored — converges at
3.8 cm from a 44-entry bank where the naive variants left 7–15 entries and
failed.

### M5 — Direction-trusted reacquisition during frozen-center tracking

*Problem:* while rotation-only holds, the marker may sweep back through
the view in a handful of frames (a "fly-through"); interval-based
re-detection misses the window (measured: a ~6-frame window missed by a
12-frame cadence → the session died unrecoverably). Conversely, after a
viewpoint jump a zombie rotation lock predicts the marker somewhere it is
not — forever.
*Mechanism:* exploit the asymmetric trust structure of the rotation-only
pose: the **rotation is measured** (trustworthy) while the **position is
assumed** (untrusted). Therefore the marker's predicted *bearing* is
reliable even when its predicted *distance* is not: when the marker is
predicted in-view, run a cheap targeted region-of-interest detection
**every frame**; when predicted out-of-view, fall back to a sparse
absolute-mode retry that alternates half/full-frame detection with
descriptor relocalization against the dormant bank (the zombie-lock
escape).
*Evidence:* tilt second-half recovery: unrecoverable → 100%;
viewpoint-jump escape ≤ 7 frames.

### M6 — Marker-as-noise-oracle adaptive gating

*Problem:* every quality gate in a mapping pipeline is a pixel threshold,
and fixed thresholds are wrong on at least one of {synthetic ~0.6 px, real
phone ~2 px} noise floors — and wrong again at every processing
resolution.
*Mechanism:* the marker provides per-frame ground-truth-quality
reprojection residuals whenever it is strongly tracked; an exponentially
averaged noise floor learned **only from unimpeachable marker frames**
(≥ 45 inliers), cold-start-repaired by a median-of-first-5 snap that fires
only when the seed was polluted, scales *every* downstream gate:
triangulation acceptance, map-point culling, Gauss–Newton outlier
rejection, pose-strength thresholds — and all of it multiplied by the
processing-resolution ratio, so one calibration serves every device
class. The guard of M1 additionally protects the oracle itself from
learning the slide's inflated residuals (a measured feedback loop:
polluted floor → loosened strength threshold → more slide admitted).
*Evidence:* map survival through marker-exit windows 71% → 100% (45
paired seeds) in combination with the survivability ensemble below; the
resolution-scaling corollary alone took an on-device torture case from 15
lost frames to 0.

### Supporting mechanisms (weaker standalone, part of the system)

- **Survivability ensemble** ("bootstrapV2"): triangulation gates honest
  to 2× the learned noise (fresh two-view DLT sits at ~2× the refined-
  anchor residual); coast-on-dip with maintenance frozen; young-point
  cull immunity below a catastrophic bound; exit-window corner-only
  replenishment. Map-hold coin-flip 71% → 100%, 14 wins / 0 losses.
- **Interval-ratio-stretched flow seeding:** each Lucas–Kanade pass is
  seeded with the previous pass's median flow scaled by the measured
  frame-interval ratio, so a processing stall (one 154 ms frame = three
  frame-times of motion) lands the search where the points actually went.
  Stall scenario: 32.6% → 100% held.
- **Mass-flow-death discontinuity gate:** a viewpoint discontinuity kills
  most flow tracks in one frame (measured 25% survival at a teleport);
  the surviving zombie minority is refused as rotation evidence, forcing
  the honest LOST that re-opens relocalization.

## 5. Informal claim sketch (for counsel — not claim language)

A method of camera tracking comprising: tracking a known planar marker
and an environment point map from monocular video; computing, per frame, a
pure-rotation interpretation of surviving optical-flow correspondences;
**(a)** demoting a marker pose whose implied translation exceeds a bound
while the flow field is rotation-explained (M1); **(b)** when both marker
and map fail and the map is below a population threshold, emitting a pose
that composes the measured rotation onto the prior with fixed camera
center (M2); **(c)** rebasing stored candidate anchors onto the engagement
pose and exiting the fixed-center mode when median anchor-ray parallax
exceeds a bound (M3); **(d)** tagging candidates anchored under the
fixed-center assumption and flushing exactly those upon a subsequent
absolute fix whose correction exceeds a bound (M4); **(e)** scheduling
marker re-detection by predicted bearing derived from the measured
rotation notwithstanding untrusted position (M5); and **(f)** scaling
map-quality gates by a noise floor learned exclusively from
high-confidence marker residuals and by processing resolution (M6).

## 6. Prior art known to the developers (disclose to counsel)

- Marker/fiducial tracking + PnP: ARToolKit lineage; OpenCV (RANSAC
  homography, IPPE, iterative PnP) — used as primitives, decades old.
- Keypoint SLAM: PTAM (Klein & Murray 2007), ORB-SLAM 1–3 (incl. its
  recent-map-point culling and constant-velocity LK seeding), DSO;
  marker+keypoint hybrids (e.g., UcoSLAM).
- Rotation-only fallbacks exist in commercial AR (8th Wall's rotation
  fallback; ARKit/ARCore "limited tracking" states) — the *existence* of a
  rotation mode is prior art; the arbitration/lineage/exit mechanisms
  above are the candidate-novel subject matter.
- Lucas–Kanade optical flow (1981), OPTFLOW_USE_INITIAL_FLOW seeding as an
  OpenCV facility, forward-backward consistency checks.
- Commercial WebAR: Niantic/8th Wall hold active browser-AR patents — a
  freedom-to-operate search is required before commercial sale,
  independent of this filing.

## 7. Reduction to practice / enablement pointers

Working production implementation in this repository:
`static/sdk/vision/pipeline.js` (M1: rot-consistency guard; M2: rotation-
only step + scope gate; M3: `_flowRotation`/rebase/parallax exit; M5:
fly-through catcher + absolute retry; M6: noisePx oracle + `_resScale`/
`_mapGS`), `static/sdk/vision/map.js` (M4: `rotAnchor` lineage,
`dropRotAnchored`, `rebaseCandidates`), `static/sdk/vision/geometry.js`
(`rotationOnlyGN`). Deterministic evidence: `results/rot-only`,
`results/map-res-gates`, `results/lk-seed-hic`, `results/fix-bootstrap`,
`results/traj-coverage` (JSONL + self-contained HTML reports; seeded,
reproducible). Unit tests `tests/test_geometry.js` (rotation estimator:
0.009° recovery, outlier robustness, translation self-betrayal).

## 8. Development chronology note

Each mechanism was preceded by at least one plausible alternative that was
implemented and **measurably failed** (speed gates ×2, full map reset,
aggressive retry cadence, unscoped rotation fallback, naive prior
composition). These negative results are documented in the repository
history and strengthen the non-obviousness narrative: the final designs
were not the first designs a skilled practitioner would try.
