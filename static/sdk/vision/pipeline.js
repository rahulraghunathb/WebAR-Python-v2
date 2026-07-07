/**
 * WebAR SDK - Vision Pipeline (runs inside the vision Web Worker)
 *
 * DETECT-THEN-TRACK architecture (the standard from the tracking literature):
 *
 *   SEARCHING --(ORB detect + match + RANSAC homography + quad checks)--> TRACKING
 *   TRACKING  --(KLT optical flow w/ forward-backward pruning + PnP)----> TRACKING
 *   TRACKING  --(too few points / bad reprojection)---------------------> LOST
 *   LOST      --(re-detect for a grace period)--------------------------> SEARCHING
 *
 * Why: full feature detection costs ~20-40ms/frame; pyramidal LK on ~60
 * anchored points costs ~2-5ms. Tracking correspondences stay ANCHORED to
 * target-image coordinates from acquisition, so the homography/PnP never
 * integrates drift - individual point drift is pruned by the forward-
 * backward check and RANSAC, and a periodic re-detection refresh re-anchors
 * everything.
 *
 * This is a faithful port of the server pipeline (src/processor.py +
 * src/pose_solver.py) - same thresholds, same validation, same coordinate
 * conversion (tests in tests/test_pose_solver.py are the reference).
 *
 * Plain worker script: expects a global `cv` (OpenCV.js) to be initialized
 * before construction.
 */

/* global cv */

const PipelineState = {
    SEARCHING: 'SEARCHING',
    TRACKING: 'TRACKING',          // poster visible (metric anchor)
    MAP_TRACKING: 'MAP_TRACKING',  // poster gone; pose from environment map
    LOST: 'LOST'
}

const PIPELINE_DEFAULTS = {
    // --- target compilation ---
    scales: [1.0, 0.5, 0.3],       // sparse external pyramid (ORB internal pyramid covers between)
    targetFeatures: 2000,          // per-scale features extracted offline
    targetActiveFeatures: 600,     // per-scale features actually MATCHED at
                                   // runtime. Matching is brute-force Hamming
                                   // and linear in this number - measured at
                                   // 92% of total detection cost at 2000.
                                   // Stride-sampled from the compiled set to
                                   // preserve spatial/scale diversity.

    // --- detection (acquisition) ---
    sceneFeatures: 600,
    minMatches: 10,
    minInliersBase: 8,
    ransacThresh: 4.0,
    minInlierRatio: 0.40,
    minInlierRatioSmall: 0.50,     // stricter for small scales

    // --- detection cost control ---
    roiPadFrac: 0.5,               // ROI padding around the predicted poster bbox
    roiMaxFrac: 0.7,               // ROI bigger than this fraction of the frame -> just go full
    roiFeatures: 300,              // ORB budget inside an ROI (vs sceneFeatures full-frame)
    searchFullEvery: 3,            // SEARCHING: every Nth attempt at full res (others half-res)

    // --- KLT tracking ---
    maxTrackPoints: 60,            // cap for per-frame LK cost. NOT lower:
                                   // poster anchors set the pose noise floor
                                   // that every map gate scales from - 40
                                   // anchors measurably degraded the map.
    minTrackPoints: 12,            // below this -> LOST
    refreshPointThreshold: 24,     // re-detect to replenish below this
    refreshInterval: 45,           // frames between forced re-anchoring detections
    fbCheck: false,                // backward-pass FB consistency. Off by
                                   // default: anchored-RANSAC + GN residual
                                   // gates provide the same drift protection
                                   // geometrically (harness-verified), at
                                   // half the LK cost. Set true to restore
                                   // the classic median-flow style check.
    fbErrorThresh: 1.5,            // forward-backward consistency (px)
    trackRansacThresh: 3.0,

    // --- pose ---
    targetPhysicalBase: 1.0,       // longest target side in meters
    minInliersPnP: 6,
    maxReprojError: 5.0,           // px
    lostFrameGrace: 15,            // frames shown as LOST before SEARCHING

    // --- environment map (MBVO; see map.js for map-internal params) ---
    mapMinTrack: 6,                // tracked map points needed to attempt map pose
    mapMinInliers: 7,              // GN inliers needed to accept a map pose
                                   // (low floor is safe: every accepted pose
                                   // also passes the physical jump gate)
    mapMaxJumpM: 0.15,             // reject map poses jumping more than this per frame
    posterRetryInterval: 12,       // frames between poster re-detect attempts in MAP_TRACKING
    resScaleMapGates: true,        // scale the map's OWN px gates (GN huber/
                                   // outlier, harvest spacing) by _resScale.
                                   // They were calibrated at 480-wide; on the
                                   // Pixel 6a at 720px the unscaled 4px GN
                                   // outlier gate mass-purged healthy points
                                   // on every accepted map pose (mapPts saw-
                                   // toothing 30->1 right after each bridge).
                                   // false reproduces that for paired A/Bs.

    // --- rotation-only fallback (the tilt/yaw gap) ---
    // Pure rotation produces ZERO baseline: the map cannot triangulate, so
    // when the poster rotates out of view there is nothing to bridge with
    // (traj-coverage: tilt held 9-10%, deterministic). But the rotation
    // itself is directly measurable from any tracked 2D flow (infinite
    // homography x' ~ K R K^-1 x). When poster AND map both fail IN THE
    // NO-MAP REGIME (sz < 12), estimate dR from the surviving flows
    // (poster + env), freeze the camera center, keep orientation live -
    // 8th Wall's "rotation fallback". DEFAULT ON since the FINAL paired
    // verdict (results/rot-only, 24 pairs, off vs on): tilt held
    // 10->100%, fusedP90 77.6->2.6cm (8/8), proc halved; yaw held
    // 5.7->100%, fusedP90 47.6->4.9cm (8/8), proc 23.5->5.5ms; slam LOST
    // 15->0, detectionRate 0.96->1.0, mapPeak +4 (8/8, the fake-trans
    // guard protects anchoring) at a KNOWN COST of +1.8cm rawP90 median
    // in would-have-been-LOST stretches (frozen center vs real
    // translation over near-planar scenes; the parallax translation
    // detector halved this from the pre-detector 4.4cm). Dead frames
    // traded for rotation-true content.
    rotOnly: true,
    rotOnlyMinPts: 8,              // flows needed to attempt / inliers to accept
    rotOnlyMaxErr: 2.5,            // px mean residual gate (x resScale)
    rotOnlyDriftDeg: 1.0,          // translation detector: candidates keep
                                   // anchor rays from BEFORE the freeze; a
                                   // static point seen from the SAME center
                                   // keeps its ray direction under pure
                                   // rotation (angle ~ noise, 0.1-0.3 deg),
                                   // while real translation grows it with
                                   // baseline/depth (3cm/frame @1.5m -> >1
                                   // deg within 1-2 frames). Median above
                                   // this -> the camera is MOVING -> exit to
                                   // honest LOST (same parallax physics the
                                   // triangulation gates trust, inverted).
    rotOnlySurvival: 0.55,         // min LK survival fraction: a viewpoint
                                   // DISCONTINUITY kills most flows at once
                                   // (teleport: 25% survived) - the zombie
                                   // minority must not seed a rotation lock;
                                   // honest LOST reopens the fast reloc path.
    rotOnlyFakeTransM: 0.015,      // rot-consistency guard: a sub-45-inlier
                                   // poster pose claiming more than this much
                                   // translation in ONE frame while the env
                                   // flow field is cleanly rotation-explained
                                   // is sliding (oblique-PnP bias), not
                                   // moving - demote it. The slide (~3cm/f in
                                   // the tilt trace) fakes baseline, poisons
                                   // triangulation AND the noisePx floor.

    // --- bootstrap survivability (research-platform verified) ---
    // Root cause of the ~30% "coin-flip" map collapse (sim campaign
    // 2026-07-04): (a) the triangulation accept gate was calibrated on the
    // POSTER's refined anchor residual (~1x noise) while fresh 2-view DLT
    // sits near 2x noise, so ripe candidates starved at exactly the handoff
    // window; (b) with the resulting small map, ONE noisy LK frame dips
    // below mapMinInliers and instant-LOST kills the KLT chain + candidate
    // bank even though the last pose was cm-accurate.
    // DEFAULT ON since the paired verdict (fix-bootstrap, 45 seed-pairs):
    // P(hold) 71% -> 100%, 14 wins 0 losses, raw error improved 3.0->2.8cm,
    // proc unchanged. Set false to reproduce the old behavior in A/Bs.
    bootstrapV2: true,             // honest tri gate + coast-on-dip + young-point
                                   // immunity + exit-window replenishment
    mapCoastMax: 3,                // max consecutive frames bridged on the prior

    // --- mapDensity2: raise the harvest equilibrium (2026-07-07) ---
    // The map size under pan is an EQUILIBRIUM (harvest inflow vs FOV-exit
    // deaths), not a cap: candidate death ledger shows 120 promotions vs 15
    // deaths on fastpan, yet the map plateaus ~40 and enters the poster-exit
    // window at ~26 points. The throttles (low-water 12, cadence 4, 2/cell)
    // date from the ORB era when every tracked point cost real LK time; the
    // SIMD kernel made points cheap. This raises inflow: low-water 24,
    // cadence 3 (2 when starved), 3 corners per 60px cell - SCOPED to
    // translation evidence (env.size()>0) and never for rot-anchored
    // harvests (unscoped v1 flooded rot-only's flow substrate: tilt seed 5
    // went 2.75->37.8cm; scoped, tilt is 12/12 raw-exact-ties).
    // BATTERY-PROVEN (opt-q, 12 paired seeds x 3 traj): slam fusedP90
    // 23.9->14.8cm (9/3), rawP90 24.1->17.1 (8/4), lost median 1->0;
    // fastpan rawP90 4.19->3.71 (7/4); mapPeak +6 everywhere it engages.
    // Known cost: slam @ tex 0.6 rawP90 medDelta +3.2 on a ~23cm chaotic
    // baseline (9/12) - rank-tail fast9 corners don't pay rent at low tex.
    // DEFAULT OFF despite the battery: test-slam's edge-biased handoff
    // (poster leaves oblique/receding) collapses 14/14 -> 5/14 with ANY
    // density lever on. Six interventions failed IDENTICALLY (~50cm/25deg:
    // hold-entry trim, full-parallax gate, size-scaled refine budget,
    // 3-strike purge - all kept, flag-gated, directionally right); the
    // invariance localized the true fork: density shifts the detect
    // SCHEDULE, a refresh detect lands on the view edge (f53), the edge fit
    // passes the strong bar carrying ~7cm bias, and refineAndCull re-anchors
    // p.X/p.b0 against that biased view - the map ITSELF enters the hold
    // warped, the truth minority gets purged, the pose spirals 4.7->57cm in
    // 17 frames. Stock survives the same handoff because its schedule skips
    // the edge detect and its map YANKS the biased prior back (13->0.8cm) -
    // but stock's own hold then creeps 0.8->11cm: the bias-absorption
    // weakness is STOCK's, density only exposes it. Flip this default only
    // after the hold-entry bias-absorption round hardens edge-marginal
    // poster maintenance at stock level.
    mapDensity2: false,

    // --- edgeGate: bias-absorption for map maintenance (2026-07-07) ---
    // strongPoster (inlier count + reproj) PASSES at the view edge /
    // oblique / far, where planar PnP carries cm-scale BIAS - and map
    // maintenance anchored there (refineAndCull re-triangulation, harvest
    // anchors, keyframes, driftComp) warps the map exactly when it is
    // about to carry a hold. Measured: the mapDensity2 basin (an edge
    // refresh detect at ~7cm bias fed refineAndCull; the hold then
    // spiraled 4.7->57cm while purge executed the unwarped minority);
    // stock's own test-slam hold creeps 0.8->11cm by the same mechanism.
    // edgeGate v4 requires poster VIEWING-GEOMETRY health (>=3 of 4 quad
    // corners inside a 2% frame margin, quad area >= 1.5% of frame; the
    // v1 obliquity check added nothing anywhere and was dropped) before
    // maintenance may anchor. Tracking itself is never gated - only what
    // the pose is allowed to TEACH the map. Package:
    //  - hard block at unhealthy geometry (v3's "provisional growth"
    //    tier let edge-anchored points into the handoff map and the
    //    late hold died on them: max err 44.8cm)
    //  - STARVATION VALVE: building maps (<15 pts: bootstrap, post-reloc)
    //    and edge-riders (>30 frames since last pass) maintain anyway -
    //    a permanent freeze built NO map on tilt (mapPeak 5->0, fused
    //    tail 2.92->9.52 arm); with the valve tilt is 12/12 raw-exact-ties
    //  - keyframes still mint ONLY at healthy geometry (reloc capital)
    //  - driftComp EXEMPT: reacquisition lands at the view edge by
    //    nature; its bias risk is already bounded per point by the
    //    reproject-improves gate
    //  - reloc REVIVE-SWEEP: the accepted (GN+probation-verified) pose is
    //    evidence - every dormant reprojecting cleanly in-view revives,
    //    not just the matched handful (teleport rebuild 16->34 pts;
    //    fresh candidates can't triangulate in short windows - physics)
    // DEFAULT ON since opt-r v4 (12 paired seeds x 3 traj): slam fusedP90
    // medDelta -1.86 (7/12), fusedMedian -0.83, lost median 1->0; tilt
    // EXACT ties; test-slam hold median 11->7.2cm, max 23.8, rebuilt 34,
    // 14/14 both flag states. Accepted cost: fastpan fused tail +0.71
    // med-pair (medians tie), bought back as proc -3.9ms 12/12 (edge
    // maintenance passes skipped).
    edgeGate: true,

    // --- purgeStrikes: 3-strike map purge at STOCK density ---
    // Single-frame purge scalps the map to each accepted pose's GN inlier
    // set; under a bias/noise transient the truth points get executed and
    // the survivor consensus drifts further (the spiral amplifier from the
    // mapDensity2 postmortem, where the strike counter shipped scoped to
    // that flag). This scopes it to the SHIPPED stack: an LK drifter only
    // gets worse and still dies 3 frames later; a good point outvoted by
    // one bad frame stays to pull the pose back. Targets the bimodal
    // bad-basin held rolls behind slam's fusedP90 arm (G2b) and the
    // reacquisition drift magnitude (G6).
    purgeStrikes: false,

    // --- precision (10x error/latency round, 2026-07-04) ---
    // Custom JS sub-pixel corner refinement (the slim WASM has no
    // cornerSubPix): snaps anchor/LK positions onto their true corners.
    // Beyond cutting the per-measurement noise floor, re-refining the LK
    // chain EVERY frame arrests its random-walk drift - which is what made
    // raw error GROW with vision rate (more steps/sec = faster walk).
    // DEFAULT ON since the precision sweep (5 paired seeds): raw 2.7->2.15cm,
    // rawP90 5.3->4.9, rotation 0.92->0.76 deg, proc unchanged. Requires a
    // target compiled with sub-pixel keypoints (preprocess_target.py does
    // this now) - refining only ONE side of an anchored pair is WORSE than
    // refining neither (measured: scene-only 2.76cm vs 1.81 baseline).
    precisionV2: true,
    subpixMinEig: 400,             // corner-strength gate: sharp corners only
    subpixClamp: 0.75,             // max px a refinement may move a point

    // --- splitDetect: asynchronous detection service ---
    // Full-density detection is the on-device spike class (100-500ms
    // frames). In split mode the TRACKING worker never runs detection
    // while tracking: refresh/re-anchor/retry detects are POSTED to a
    // detection sub-worker (its own WASM instance) and the reply - anchors,
    // harvest keypoints, reloc scene - arrives 1-3 frames stale and is
    // FORWARDED to the current frame by one LK pass from a small ring of
    // retained grays. Tracking latency becomes pure track cost; the spike
    // class leaves the pose path entirely. SEARCHING keeps synchronous
    // detection (nothing to block - there is no pose either way).
    splitDetect: false,
    splitInstallMaxSpanPx: 24,     // stale-install guard: max motion (px,
                                   // reply age x median flow/frame) an
                                   // absorbed install's LK hop may span when
                                   // a healthy chain is live and the reply
                                   // is not clearly stronger - beyond it the
                                   // hop's forwarding error exceeds the
                                   // re-anchoring benefit (v1: tilt 3x raw)

    // --- chainGuard: appearance proof for chain RESURRECTIONS ---
    // The poster KLT chain is validated only GEOMETRICALLY (homography
    // RANSAC + quad) - and any coplanar texture satisfies a homography.
    // When a fit fails, the stale layout is retried next frame (deliberate:
    // it forgives one-frame LK garbage under blur). But if the underlying
    // pixels changed IDENTITY during the failed frame (occluder slid in,
    // blind teleport cut: sim slam @125 hides the poster), the retried
    // layout can re-cohere on the NEW surface: measured 66-inlier phantom
    // "poster" tracking the wall BEHIND the hidden poster, 11->48cm drift,
    // reported as detected=true - and it outcompetes honest LOST in any
    // A/B. Guard: sample small gray templates at strong fits; a fit that
    // succeeds right after >=1 failed frame must prove its pixels still
    // match (median zero-mean NCC) or the chain is dropped - recovery then
    // belongs to the appearance-verified detect/reloc paths.
    chainGuard: true,              // DEFAULT ON (opt-f verdict: bit-neutral
                                   // on fastpan/tilt - raw errors tie
                                   // EXACTLY; slam teleport rows change
                                   // semantics only: honest LOST/freeze
                                   // replaces phantom tracking)
    chainGuardNcc: 0.3,            // min median NCC to accept a resurrection

    // --- lkKernel: custom SIMD pyramidal KLT (tools/lk.c) ---
    // cv.calcOpticalFlowPyrLK measured 9-10ms/frame at 720px - the entire
    // tracking-frame floor (2026-07-07 profile: everything else 0.1-0.5ms).
    // The kernel does Bouguet KLT with i32x4.dot_i16x8 window reductions,
    // template windows interpolated once per point-level, replicate-padded
    // pyramids. cv-faithful semantics (status/err scale, same gates) but
    // NOT bit-identical (pyramid kernel, f32 accumulation) - paired A/B
    // owns the verdict. cv fallback everywhere: absorb ring-hops, fbCheck,
    // non-resident pairs after gaps, kernel init failure.
    lkKernel: true,                // DEFAULT ON (opt-i verdict: quality
                                   // ties across slam/fastpan/tilt x 4
                                   // seeds - held/lost/det identical, error
                                   // deltas in the noise band, tilt
                                   // slightly better - and procP50 wins
                                   // 12/12 pairs at -25-33%: the LK stage
                                   // fell 9-10ms -> ~3ms)

    // --- harvestKernel: FAST-9 corner harvest via the LK kernel ---
    // The corner-harvest pass ran full ORB.detect for POSITIONS only
    // (~9ms/device on every candidate-hungry frame - profiled as the #2
    // hot spot after LK). FAST-9 + NMS + score on the already-resident
    // kernel image is ~0.5-1ms. Corners are the same FAMILY (ORB
    // keypoints ARE FAST corners) but not identical - paired verdict
    // owns the flip. Requires lkKernel (shares its resident frames).
    harvestKernel: true,           // DEFAULT ON (opt-m + opt-n-tex: fast9 >= ORB everywhere, DOMINANT low-tex - tex 0.5 held 100 vs 17, mapPeak 46 vs 2; phone: spikes 79->31ms, map med 3->7, LOST 6->1). Accepted trade: fastpan fusedP90 +~1cm / mapPeak -10 (rot-only-precedent class: weakest-environment fix beats strongest-case tail).

    // --- relocV3: keyframe reloc tier + probation ---
    // Reloc pose quality was f(dormant-bank triangulation history):
    // unverifiable one-shot, measured 2.4-109cm across rolls. Keyframes
    // snapshot the desc-bearing tracked points right after refineAndCull
    // under a STRONG poster (ground-contacted 3D by construction; ring of
    // 3, tried freshest-first before the classic soup), and every
    // accepted reloc serves an 8-frame PROBATION - two jump-gate fights
    // inside it retract to honest SEARCHING with a 10-frame cooldown.
    relocV3: true,                 // DEFAULT ON (opt-n: test-slam 14/14 with the full stack - first ever; keyframe tier makes reloc pose quality a property of ground-contacted snapshots instead of bank history; probation retracts wrong worlds honestly)

    // --- rotOnlyHuntFast: escalated reacquisition under a blind freeze ---
    // See the retry site: rot-only + poster predicted offscreen + parked
    // camera = no working recovery channel at the lazy retry cadence.
    rotOnlyHuntFast: true,         // DEFAULT ON with the SUSPICION gate (fly-through miss streak >= 4): escalation only when the freeze is provably lying. Unconditional escalation cost tilt fusedP90 2.59->13.2; gated: tilt EXACT ties, test-slam reacquire restored (M x84 zero-hunt bug dead).

    // --- edgeHysteresis: weak-poster boundary is a band ---
    // Field logs: 6 TRACKING<->MAP_TRACKING transitions in 2.5s with the
    // poster hovering at the view edge around 30 inliers. Enter weak at
    // <30 as always; while MAP_TRACKING the poster retakes the pose only
    // at >=38 (clearly recovered, not the biased edge remnant).
    edgeHysteresis: true,          // DEFAULT ON (opt-l verdict: EXACT ties
                                   // on every deterministic axis across 24
                                   // pairs - the sim has no hover regime,
                                   // so no-harm is the provable bar; the
                                   // win is the field-log flap class)

    // --- driftComp: drift back-propagation at reacquisition (opt-h) ---
    // The poster snap at reacquisition MEASURES the map's accumulated VO
    // drift; driftComp aligns the map (tracked X + anchor lineage where a
    // live observation confirms improvement, candidates/dormant as best
    // estimate) to poster truth instead of leaving the error for the cull
    // to execute. See EnvMap.applyDriftCorrection.
    driftComp: true,               // DEFAULT ON (opt-h verdict: exact ties
                                   // on every deterministic axis, zero
                                   // regression; the win is STRUCTURAL and
                                   // trace-visible - slam seed1 map rides
                                   // 18 pts vs 3 through the
                                   // post-reacquisition stretch, +tr 12
                                   // same-frame from corrected candidate
                                   // anchors, dormant 3D corrected instead
                                   // of drift-poisoned)

    // --- relocV2: small-bank / off-prior relocalization robustness ---
    // The classic reloc pipeline was calibrated for 40+ entry banks on
    // clean pixels: flat 12-match + 10-GN-inlier floors and a blind DLT
    // init. Measured failure (split-mode slam teleport, 26-entry bank,
    // prior ~25-50cm off): ratio test returned 0-1 matches while the same
    // corners sat ~50 bits away in absolute Hamming distance -> 15-frame
    // LOST tail. relocV2 = absolute-distance match rescue + bank-scaled
    // floors + prior-seeded PnP retry (blind DLT is degenerate on coplanar
    // match sets; LM from a stale prior refines planar sets fine) + a
    // tight-reprojection compensation gate whenever support is small.
    relocV2: true,                 // DEFAULT ON (opt-f verdict: inert
                                   // except where reloc fires; measured
                                   // dR16/17 dormant refreshes keep banks
                                   // matchable across exposure drift)
    relocAbsHamming: 80,           // absolute-distance rescue tier (bits);
                                   // re-observations sit ~20-60 (fresh) to
                                   // ~75 (aged), cross-match noise centers
                                   // ~128. Only read under relocV2.
    relocGnScale: 1.6,             // reloc GN gate multiplier: dormant 3D
                                   // carries FROZEN triangulation error, so
                                   // the correct pose legitimately reprojects
                                   // it a few px off; tracking-grade gates
                                   // zeroed the inlier set (measured). Only
                                   // read under relocV2.

    // --- lkFast: LK cost cuts ---
    // (a) calcOpticalFlowPyrLK rebuilds BOTH image pyramids on every call;
    //     the previous frame's pyramid is identical to the one built for
    //     the same image a frame ago. Build each frame's pyramid ONCE
    //     (buildOpticalFlowPyramid) and ping-pong two cached MatVectors -
    //     roughly halves the fixed per-frame LK cost. Runtime-probed
    //     (falls back if the WASM binding rejects pyramid inputs).
    // (b) when the pass is SEEDED, the initial guess lands within a few px
    //     of the answer, so one pyramid level less covers the residual -
    //     per-point iterations scale with levels.
    lkFast: true,                  // DEFAULT ON (opt-d verdict: LK-bound
                                   // frames ~12% cheaper (fastpan 16->14ms),
                                   // accuracy pair-tied - the pyramid path
                                   // is numerically identical)
    lkFastLevels: false,           // seeded level-cut: extra ~2-4% proc but
                                   // it nudged two deterministic test-slam
                                   // bars past their margins - OFF until a
                                   // dedicated verdict justifies it

    // --- fastRefresh: half-res re-anchoring detects ---
    // Refresh/harvest detections run on the pooled half-res frame (~4x
    // cheaper ORB - THE on-device spike class, 100-500ms) and every
    // produced coordinate is snapped back onto true full-res corners by
    // the sub-pixel refiner with a widened clamp (half-res quantization is
    // up to ~1px). The old "cheaper detect degrades the map" verdict
    // predates the sub-pixel refiner - retested behind this flag.
    // Initial acquisition (SEARCHING) keeps its full-res alternation:
    // small/far posters are invisible at half res.
    fastRefresh: false,

    // --- timeCal: time-calibrated frame-count constants ---
    // Every "N frames" constant in the pipeline (refresh cadence, LOST
    // grace, retry interval, coast budget, candidate maturity, cull
    // immunity, dormant aging, jump-gate allowance) was calibrated at the
    // 20Hz reference rate. Interpreted as raw frame counts at 60Hz they
    // all TIGHTEN 3x (measured: held collapses to 27%). With timeCal the
    // constants convert through the measured frame interval, so a "2.25s
    // refresh" stays 2.25s at any rate.
    timeCal: false,

    // --- perfV1: frame-cost + calibration hygiene bundle ---
    // (1) sub-pixel refinement runs on the RANSAC INLIERS after the fit
    //     instead of every tracked point before it (~2x cheaper precision
    //     pass; the refined survivors still become next frame's chain, so
    //     the random-walk arrest is preserved);
    // (2) hot-path JS arrays (LK merge/output/seed buffers) are pooled -
    //     they were the per-frame GC pressure;
    // (3) the noisePx floor initializes from the MEDIAN of the first 5
    //     strong frames instead of trusting frame one (a single noisy
    //     first detect once polluted a whole run's gates at 2.9px).
    perfV1: true,                  // DEFAULT ON (opt-a verdict: tilt raw
                                   // 2.49->2.15cm via cold-start, robustness
                                   // untouched, proc flat in-harness - the
                                   // pooling's GC relief is device-side)

    // --- predicted-LK seeding ---
    // Seed each LK pass with the previous frame's median flow scaled by the
    // frame-interval ratio (OPTFLOW_USE_INITIAL_FLOW). Zero-motion seeds
    // lose the chain in exactly two field cases: fast pan (displacement
    // outruns the pyramid) and the frame after a heavy detect (Pixel 6a:
    // one 154ms frame -> 3 frame-times of motion in one LK step -> LOST).
    // DEFAULT ON since the paired verdicts (results/lk-seed{,-hic}):
    // stall scenario (&hic=20) held 32.6%->100% (7 wins/0 losses),
    // detectionRate 0.77->0.90, fusedP90 25.8->14.1cm, proc FLAT; without
    // stalls: neutral (ties). Set false to reproduce unseeded LK in A/Bs.
    lkPredictSeed: true
}

class VisionPipeline {
    constructor(config) {
        this.cfg = Object.assign({}, PIPELINE_DEFAULTS, config || {})

        // Target data (set by compileTarget)
        this.targetLevels = []     // [{scale, pts: Float32Array(2N), desc: cv.Mat}]
        this.targetW = 0
        this.targetH = 0
        this.physW = 1
        this.physH = 1
        this.lastScale = 1.0

        // Detectors / matcher (scene-side ORB reused every frame)
        this.orb = new cv.ORB(this.cfg.sceneFeatures)
        this.matcher = new cv.BFMatcher(cv.NORM_HAMMING, false)

        // Camera intrinsics
        this.K = null
        this.dist = cv.Mat.zeros(4, 1, cv.CV_64F)
        this.kFingerprint = ''

        // Tracking state
        this.state = PipelineState.SEARCHING
        this.prevGray = null              // cv.Mat of previous frame
        this.trackTarget = null           // Float32Array(2N): anchored target px coords
        this.trackScene = null            // Float32Array(2N): current scene px coords
        this.framesSinceRefresh = 0
        this.lostFrames = 0
        this.trackingFrames = 0

        // PnP prior
        this.rvec = new cv.Mat(3, 1, cv.CV_64F)
        this.tvec = new cv.Mat(3, 1, cv.CV_64F)
        this.hasPrior = false
        this.ippeOk = true                // fall back to ITERATIVE if IPPE unsupported

        // Environment map (marker-bootstrapped VO). curR/curT mirror the
        // latest T_cw as plain arrays for the geometry module.
        this.env = (typeof EnvMap !== 'undefined') ? new EnvMap(this.cfg) : null
        this.Kp = null                    // {fx, fy, cx, cy} for geometry.js
        this.curR = null                  // Array(9) row-major T_cw rotation
        this.curT = null                  // Array(3)
        this.posterRetryCount = 0
        this.mapFrames = 0
        this._pendingHarvest = null
        this._envTrackedThisFrame = false
        this._envFlows = null             // this frame's env prev->cur LK flows
        this._allFlows = null             // poster + env flows (rotation estimation)
        this._lastMapPose = null          // {R, t, age, bridged} for drift-at-reacquire
        this._framesSincePose = 0         // frames since ANY accepted pose (jump-gate scaling)
        this._searchTick = 0              // SEARCHING half/full alternation
        this._mapCoast = 0                // consecutive coast frames (bootstrapV2)
        this._framesSinceHarvest = 0      // cadence for corner-only harvest passes
        this._halfGray = null             // pooled half-res Mat for cheap search
        this._lastScene = null            // {pts, desc} captured for relocalization

        // chainGuard: appearance templates from the last strong poster fit
        // + consecutive fit-failure count (a success right after failures is
        // a RESURRECTION and must prove the pixels still match)
        this._chainPatches = null
        this._fitFailStreak = 0

        // relocV3: reloc probation window + post-retraction cooldown
        this._relocProbation = null       // {left, jumps} after an accepted reloc
        this._relocCooldown = 0           // frames reloc stays blacklisted
        this._kfTick = 0                  // strong-frame keyframe cadence
        this._ftMiss = 0                  // fly-through predicted-in-view miss
                                          // streak (freeze-suspicion evidence)

        // Predicted-LK seeding state (lkPredictSeed): median flow of the
        // last LK pass + frame timebase, so the next pass starts its search
        // where constant-velocity motion puts the points. Survives exactly
        // the two killers a zero-motion seed dies on: fast pan and the
        // frame-time spike after a heavy detect (gap = several frame-times
        // of motion in one LK step).
        this._frameIdx = 0
        this._tsPrev = null               // capture timestamp of previous frame
        this._dtPrev = null               // previous frame interval (ms)
        this._dtRatio = 1                 // current/previous interval, clamped
        this._lastFlow = null             // {dx, dy, n, f}: median LK flow @ frame f
        this._lkSeedOk = null             // does the WASM accept the flags arg?
        this._flowRot = null              // per-frame pure-rotation flow fit
        this._flowRotFrame = -1
        this._wasRotOnly = false          // was the previous frame rot-only?
                                          // (engagement-transition detector)
        this._frameMs = 0                 // typical frame interval (timeCal)
        this._fscale = 1                  // 20Hz-reference frame-count factor
        this._pyrA = null                 // lkFast: carried-over LK pyramid
        this._pyrAFrame = -9
        this._pyrWin = 0
        this._pyrOk = null                // does the WASM accept pyramid inputs?

        // splitDetect (tracker side): async detection service plumbing.
        // onDetectRequest is wired by the worker; _grayRing retains the
        // last few frames so stale replies can be LK-forwarded to "now".
        this.onDetectRequest = null       // (req) => void, set by the worker
        this._detPending = null           // {frameId, kind} one in-flight max
        this._grayRing = []               // [{f, mat}] retained recent grays
        this._detReply = null             // reply parked until processFrame
        this._installedResult = null      // absorb-built chain, same-frame only

        // Measured 2D noise floor (px): running EMA of strong-pose
        // reprojection error. Synthetic renders sit ~0.6px, real phones ~2px;
        // map quality gates scale to THIS instead of a fixed constant, so
        // clean data gets strict gates and noisy data still builds a map.
        this.noisePx = null

        // Adaptive FAST threshold: ORB's default (20) misses low-contrast
        // corners in dim scenes - the phone field test showed maps starving
        // at 8-17 points in a dark room while the bright harness builds
        // 30-50. Lower sensitivity when keypoint yield is poor, restore it
        // when the scene is rich (junk-corner protection).
        this._fastThresh = 20

        this.debug = {}
    }

    // ================= Target compilation =================

    /**
     * Compile target features from an RGBA ImageData (done once at init).
     * Equivalent to preprocess_target.py but in-browser.
     */
    compileTarget(imageData) {
        const rgba = cv.matFromImageData(imageData)
        const gray = new cv.Mat()
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
        rgba.delete()

        this.targetW = gray.cols
        this.targetH = gray.rows

        // Physical size: longest side = targetPhysicalBase meters
        const aspect = this.targetW / this.targetH
        if (this.targetW >= this.targetH) {
            this.physW = this.cfg.targetPhysicalBase
            this.physH = this.cfg.targetPhysicalBase / aspect
        } else {
            this.physH = this.cfg.targetPhysicalBase
            this.physW = this.cfg.targetPhysicalBase * aspect
        }

        // High-quality extraction (offline-grade feature count)
        const orb = new cv.ORB(this.cfg.targetFeatures)
        const mask = new cv.Mat()
        const counts = []

        for (const scale of this.cfg.scales) {
            let mat = gray
            if (scale !== 1.0) {
                mat = new cv.Mat()
                cv.resize(gray, mat, new cv.Size(
                    Math.round(this.targetW * scale), Math.round(this.targetH * scale)))
            }

            const kp = new cv.KeyPointVector()
            const desc = new cv.Mat()
            orb.detectAndCompute(mat, mask, kp, desc)

            const n = kp.size()
            if (n >= 4) {
                // Full set (quality path) + stride subsample (exploration)
                const pts = new Float32Array(n * 2)
                for (let i = 0; i < n; i++) {
                    const p = kp.get(i).pt
                    pts[i * 2] = p.x / scale
                    pts[i * 2 + 1] = p.y / scale
                }
                const full = new cv.Mat(n, 32, cv.CV_8U)
                full.data.set(desc.data.subarray(0, n * 32))
                const subN = Math.min(n, this.cfg.targetActiveFeatures)
                const stride = n / subN
                const subPts = new Float32Array(subN * 2)
                const subDesc = new cv.Mat(subN, 32, cv.CV_8U)
                for (let i = 0; i < subN; i++) {
                    const j = Math.floor(i * stride)
                    subPts[i * 2] = pts[j * 2]
                    subPts[i * 2 + 1] = pts[j * 2 + 1]
                    subDesc.data.set(desc.data.subarray(j * 32, j * 32 + 32), i * 32)
                }
                this.targetLevels.push({ scale, pts, desc: full, subPts, subDesc })
                counts.push(n)
            }
            desc.delete()
            kp.delete()
            if (mat !== gray) mat.delete()
        }

        mask.delete()
        orb.delete()
        gray.delete()

        return {
            ready: this.targetLevels.length > 0,
            keypoints: counts,
            scales: this.targetLevels.map(l => l.scale),
            physical: [this.physW, this.physH]
        }
    }

    /**
     * Load a precompiled target (parsed .webart, see webart-format.js).
     * Skips in-browser ORB extraction entirely (~1.2s off init) and uses
     * the compiler's physical dimensions (which may be real printed size).
     */
    loadCompiledTarget(parsed) {
        this.targetW = parsed.imgW
        this.targetH = parsed.imgH
        this.physW = parsed.physW
        this.physH = parsed.physH

        const counts = []
        for (const lv of parsed.levels) {
            if (lv.count < 4) continue
            // Full set: the QUALITY path (tracking refreshes that anchor the
            // map). Subsampled set: the EXPLORATION path (searching/retry) -
            // matching is linear in target count, exploration just needs to
            // FIND the poster, and the next refresh rebuilds quality anchors.
            const desc = new cv.Mat(lv.count, 32, cv.CV_8U)
            desc.data.set(lv.desc)
            const pts = new Float32Array(lv.pts)
            const subN = Math.min(lv.count, this.cfg.targetActiveFeatures)
            const stride = lv.count / subN
            const subPts = new Float32Array(subN * 2)
            const subDesc = new cv.Mat(subN, 32, cv.CV_8U)
            for (let i = 0; i < subN; i++) {
                const j = Math.floor(i * stride)
                subPts[i * 2] = lv.pts[j * 2]
                subPts[i * 2 + 1] = lv.pts[j * 2 + 1]
                subDesc.data.set(lv.desc.subarray(j * 32, j * 32 + 32), i * 32)
            }
            this.targetLevels.push({ scale: lv.scale, pts, desc, subPts, subDesc })
            counts.push(lv.count)
        }

        return {
            ready: this.targetLevels.length > 0,
            compiled: true,
            keypoints: counts,
            scales: this.targetLevels.map(l => l.scale),
            physical: [this.physW, this.physH]
        }
    }

    // ================= Intrinsics =================

    setIntrinsics(fx, fy, cx, cy) {
        const fp = fx + ',' + fy + ',' + cx + ',' + cy
        if (fp === this.kFingerprint) return
        if (this.K) this.K.delete()
        this.K = cv.matFromArray(3, 3, cv.CV_64F, [fx, 0, cx, 0, fy, cy, 0, 0, 1])
        this.Kp = { fx, fy, cx, cy }
        this.kFingerprint = fp
    }

    ensureIntrinsics(w, h, fovDeg) {
        if (this.K) return
        const f = w / (2 * Math.tan((fovDeg || 60) * Math.PI / 360))
        this.setIntrinsics(f, f, w / 2, h / 2)
    }

    // ================= Per-frame entry point =================

    /**
     * Process one grayscale frame.
     * @param {cv.Mat} gray - grayscale frame (ownership stays with caller's pool)
     * @returns result object (JSON-serializable)
     */
    processFrame(gray, tsMs) {
        const t0 = performance.now()
        const w = gray.cols, h = gray.rows
        this._fw = w; this._fh = h
        this.ensureIntrinsics(w, h)

        // Frame timebase (capture ts when the caller provides one, worker
        // receive time otherwise): the interval RATIO stretches the LK seed
        // across irregular frames - a 3x-long gap means 3x the flow.
        this._frameIdx++
        const ts = (typeof tsMs === 'number' && isFinite(tsMs)) ? tsMs : t0
        if (this._tsPrev != null) {
            const dt = Math.max(1, ts - this._tsPrev)
            this._dtRatio = this._dtPrev
                ? Math.min(4, Math.max(0.5, dt / this._dtPrev)) : 1
            this._dtPrev = dt
            // typical frame interval (EMA, clamped to sane camera rates):
            // the timeCal conversions scale from this
            this._frameMs = this._frameMs
                ? 0.9 * this._frameMs + 0.1 * Math.min(100, Math.max(8, dt))
                : Math.min(100, Math.max(8, dt))
        } else this._dtRatio = 1
        this._tsPrev = ts
        // frame-count conversion factor: 1 at the 20Hz reference, ~3 at 60Hz
        this._fscale = this.cfg.timeCal && this._frameMs
            ? Math.min(6, Math.max(0.4, 50 / this._frameMs)) : 1
        if (this.env) this.env.cfg._fscale = this._fscale
        // ALL pixel-space gates were calibrated on 480-wide frames. The same
        // physical noise spans resScale x more pixels at higher processing
        // resolution - unscaled gates get effectively TIGHTER (measured on
        // Pixel 6a at 720px: inliers crashing, map starved at mapPts~0 with
        // ~100 dormant, LOST flapping -> visible jitter).
        this._resScale = Math.max(1, Math.max(w, h) / 480)

        this.debug = {
            state: this.state, mode: '-', keypoints: 0, good_matches: 0,
            inliers: 0, track_points: 0, scale_used: 0,
            map_points: this.env ? this.env.size() : 0,
            map_cands: this.env ? this.env.candidateCount() : 0,
            map_dormant: this.env ? this.env.dormantCount() : 0,
            // map point-flow ledger: every gate that adds/removes points
            // reports here, so a trace shows WHICH executioner fired
            // (LK drop / poster-truth cull / GN purge / +triangulated / +harvested)
            m_lk: 0, m_cull: 0, m_purge: 0, m_tri: 0, m_harv: 0
        }

        this._pendingHarvest = null
        this._envTrackedThisFrame = false
        this._envFlows = null             // this frame's env prev->cur LK flows
        this._allFlows = null             // poster + env flows (rotation estimation)

        // lkKernel: make this frame resident in the kernel's slot pair
        // (~0.15ms copy + pyramid). track() pairs (frame-1, frame); after
        // any gap the pair check fails and cv covers that one frame.
        if (this.cfg.lkKernel && typeof LkKernel !== 'undefined' && LkKernel.ready) {
            LkKernel.upload(gray, this._frameIdx, this._frameIdx & 1,
                this._resScale > 1.2 ? 4 : 3)
        }

        if (this._lastMapPose) this._lastMapPose.age++
        this._framesSincePose++
        this._framesSinceHarvest++
        if (this.env) this.env.tickDormant()
        if (this._relocCooldown > 0) this._relocCooldown--
        if (this._relocProbation && --this._relocProbation.left <= 0) {
            this._relocProbation = null   // probation served cleanly
        }

        // splitDetect: absorb any parked async detection reply FIRST (it
        // installs anchors/harvest/reloc-scene for THIS frame's tracking),
        // then retain this gray for forwarding future stale replies.
        if (this.cfg.splitDetect) {
            if (this._detReply) this._absorbDetReply(gray)
            this._ringPush(gray)
        }

        let result = null      // poster result
        let mapResult = null   // pose from the environment map
        let driftSnap = null   // map pose at the moment the poster came back

        // --- 1. poster KLT tracking (env points ride the same LK pass) ---
        // Also runs in MAP_TRACKING when a weak poster is still 2D-tracked:
        // its homography keeps the 2D chain alive so the poster can win back
        // the pose the moment it strengthens.
        if ((this.state === PipelineState.TRACKING || this.state === PipelineState.MAP_TRACKING) &&
            this.prevGray && this.trackScene) {
            if (this._installedResult) {
                // async detect just installed a chain AT this frame - using
                // _trackStep would LK it a second time (double shift). The
                // env set still needs its per-frame tracking though.
                result = this._installedResult
                this._installedResult = null
                if (this.env && this.env.size() + this.env.candidateCount() > 0) {
                    this._lkEnvOnly(gray)
                }
                this.debug.mode = 'track'
                this.debug.inliers = result.nInliers
                this.debug.track_points = result.nInliers
            } else {
                result = this._trackStep(gray)
            }

            // Periodic re-anchoring / replenishment while tracking.
            // Full detection costs 100-500ms on phones (a visible hitch),
            // so when tracking is RICH (plenty of inliers = negligible
            // drift) stretch the interval 3x - re-anchor mainly when the
            // point set is actually decaying.
            // Refresh logic only while genuinely TRACKING: in MAP_TRACKING a
            // weak "zombie" poster track (edge remnants) would otherwise
            // trigger needPoints refreshes every few frames whose corner
            // bbox excludes most scene points -> unfiltered full-density
            // matches at 120-160ms. Poster reacquisition during map tracking
            // belongs to the predicted-ROI retry path.
            if (result && this.state === PipelineState.TRACKING) {
                const needPoints = result.trackPoints < this.cfg.refreshPointThreshold
                // NOT time-scaled: the refresh cadence bounds LK CHAIN DRIFT,
                // which accumulates per tracking STEP, not per second - the
                // timeCal A/B measured fastpan raw error 2x worse when this
                // stretched to a fixed 2.25s at 60Hz
                const interval = result.nInliers >= 45
                    ? this.cfg.refreshInterval * 3
                    : this.cfg.refreshInterval
                // Detect frames are also the only harvest opportunity - run
                // one when the environment map is starving (its insurance
                // against poster loss is worth the occasional detect cost).
                // "Starved" must aim ABOVE the survival floor: the map loses
                // points continuously (FOV exit, FB pruning), so target a
                // healthy buffer of points+candidates, not the bare minimum -
                // map quality at poster-loss should not depend on lucky
                // harvest timing.
                // Starvation must also trigger on SIZE alone: stale
                // candidates whose anchors sit near the current camera
                // (return legs) never pass the baseline gate - they are
                // not insurance, and counting them deadlocked the refresh
                // with map=0 + 25 zombie candidates (split-mode trace).
                const mapStarved = this.env &&
                    ((this.env.size() + this.env.candidateCount()) < 25 ||
                     (this.cfg.splitDetect && this.env.size() < 8)) &&
                    this.framesSinceRefresh >= this._frames(15)
                if (needPoints || mapStarved || this.framesSinceRefresh >= interval) {
                    // RE-ANCHOR + HARVEST: full-frame, full-density DETECTION.
                    // DO NOT thin the detector on this path: cheaper variants
                    // (ROI scene, sparse target, corner-only split) were each
                    // tried in isolation and EVERY one measurably degraded
                    // the map handoff - full-quality re-anchoring pins the
                    // pose noise floor that all map gates scale from.
                    // The MATCHING however may be confined to scene points
                    // inside the known quad (where all true matches live):
                    // identical keypoints/anchors/harvest, ~3x less Hamming.
                    let matchBox
                    if (result.corners) {
                        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
                        for (const c of result.corners) {
                            if (c[0] < x0) x0 = c[0]
                            if (c[0] > x1) x1 = c[0]
                            if (c[1] < y0) y0 = c[1]
                            if (c[1] > y1) y1 = c[1]
                        }
                        const pad = 0.4 * Math.max(x1 - x0, y1 - y0)
                        matchBox = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
                    }
                    // async when the service is up (tracking continues on
                    // the existing chain; the reply installs fresh anchors
                    // in 1-3 frames); SYNCHRONOUS fallback otherwise - a
                    // silently dropped refresh let rotation-only capture
                    // the whole session at frame 1 while the service WASM
                    // was still booting.
                    // COLD WINDOW is also synchronous: the first refresh
                    // after (re)acquisition repairs a weak first fit and
                    // seeds the noisePx floor - a 1-frame async gap there
                    // let the tilt sweep exit the poster before the reply
                    // landed, freezing rot-only on the 8.9cm frame-0 bias
                    // for the whole session (v2 A/B: tilt seeds 1/2 raw
                    // 2.5 -> 7.4-9.0cm; frame-1 sync refresh pins 1.5cm).
                    if (!(this.cfg.splitDetect &&
                          this.trackingFrames >= this._frames(6) &&
                          this._requestDetect('refresh', matchBox ? { matchBox } : {}))) {
                        const det = this._detectStep(gray, {
                            matchBox: matchBox || undefined,
                            halfSnap: this.cfg.fastRefresh || undefined
                        })
                        if (det) { result = det; this.framesSinceRefresh = 0 }
                    }
                }
            }
        }

        // --- 2. map tracking: when the poster is absent OR weak ---
        // A weak poster (few homography inliers: small/oblique/at the view
        // edge) produces BIASED PnP poses - measured up to 19cm off while
        // "tracking". The map cross-checks it (see routing below).
        // edgeHysteresis: the weak boundary is a BAND, not a line - field
        // logs show TRACKING<->MAP_TRACKING flapping every 200-400ms when
        // the poster hovers near 30 inliers at the view edge. While in
        // MAP_TRACKING the poster must come back CLEARLY (>=38) to retake
        // the pose; a 31-inlier edge poster right after a map stretch is
        // exactly the biased-PnP class the weak gate exists for.
        const weakBar = (this.cfg.edgeHysteresis &&
            this.state === PipelineState.MAP_TRACKING) ? 38 : 30
        const posterWeak = result && result.nInliers < weakBar
        if ((!result || posterWeak) && this.env && this.prevGray) {
            if (!this._envTrackedThisFrame) this._lkEnvOnly(gray)
            const sz = this.env.size()
            let why = 'n=' + sz
            if (sz >= this.cfg.mapMinTrack && this.hasPrior && this.curR) {
                const _tMap = performance.now()
                const g = this.env.solvePose(this.Kp, this.curR, this.curT, this._mapGS())
                this.debug.t_map = performance.now() - _tMap
                if (g.ok && g.nInliers >= this.cfg.mapMinInliers) {
                    // Physical sanity: hand-held cameras move a few cm/frame.
                    // A larger jump means GN converged somewhere wrong -
                    // better an honest LOST than a confidently wrong pose.
                    const Cp = Geometry.invertRT(this.curR, this.curT).t
                    const Cn = Geometry.invertRT(g.R, g.t).t
                    const jump = Math.hypot(Cn[0] - Cp[0], Cn[1] - Cp[1], Cn[2] - Cp[2])
                    // The allowance scales with the PRIOR'S AGE: a rejected
                    // frame leaves the prior one frame staler, so the next
                    // "jump" includes real camera motion - a fixed gate
                    // turns one borderline rejection into a death spiral.
                    // allowance is TIME-based under timeCal (a frame at 60Hz
                    // carries a third of the motion) - but FLOORED at one
                    // 20Hz-frame's worth: pose NOISE does not shrink with
                    // frame rate, and an unfloored 5cm gate at 60Hz sat
                    // inside the map-solve jitter band (measured: bimodal
                    // seed-dependent death spirals, slam raw 2.3->10cm)
                    const allow = this.cfg.mapMaxJumpM *
                        Math.min(4, Math.max(1, this._framesSincePose / (this._fscale || 1)))
                    if (jump <= allow) {
                        mapResult = g
                    } else {
                        why += ' jump=' + jump.toFixed(3) + '>' + allow.toFixed(2)
                        // relocV3 probation: jump-gate fights right after a
                        // reloc = the accepted world is WRONG (measured
                        // signature of the 41cm basin). Two fights inside
                        // the window -> retract to honest SEARCHING; the
                        // desc capital goes dormant, a cooldown stops the
                        // accept/retract flap, and the next attempt runs
                        // against the keyframe tier first anyway.
                        if (this._relocProbation && ++this._relocProbation.jumps >= 2) {
                            this._relocProbation = null
                            this._relocCooldown = this._frames(10)
                            this._dropTracking()
                            this.env.sleep()
                            this.hasPrior = false
                            this.state = PipelineState.SEARCHING
                            this.debug.reloc_retract = 1
                            mapResult = null
                        }
                    }
                } else {
                    why += g.ok ? ' inl=' + g.nInliers : ' gn-fail'
                }
            } else if (!this.hasPrior || !this.curR) {
                why += ' no-prior'
            }
            // Rotation-only fallback: the map cannot solve (no baseline ->
            // no 3D points, or GN failed) but the 2D flows are still alive.
            // Estimate the pure camera rotation they describe, freeze the
            // camera center, keep orientation live. Ranked ABOVE coast (it
            // measures the actual rotation; coast just repeats the pose).
            // ONLY in the no-map regime (sz < 12): with a real map present,
            // a map failure means the camera is TRANSLATING through a rough
            // patch - and translation over a near-planar scene fits a
            // rotation cleanly (fundamental ambiguity, measured on slam:
            // rawP90 6.8 -> 25cm when rot-only was allowed to take those
            // frames). No map at all = no baseline ever = the tilt/yaw case.
            // No speed gate: pose jitter at real noise floors (2-5cm) is
            // indistinguishable from slow walking on any short window - a
            // speed gate flip-flopped seed-to-seed. The mid-walk ambiguity
            // capture is instead BOUNDED by the absolute-mode retry (hunts
            // every posterRetryInterval frames) and its tail cost is the
            // accepted A/B trade (slam rawP90 +4.4cm for LOST 15->0).
            if (!mapResult && this.cfg.rotOnly && sz < 12 &&
                this.hasPrior && this.curR &&
                this._allFlows && this._allFlows.n >= this.cfg.rotOnlyMinPts) {
                const rot = this._rotOnlyStep()
                if (rot) {
                    mapResult = rot
                    why += ' rot' + rot.nInliers
                } else {
                    why += ' rot-fail'
                }
            }
            // bootstrapV2 coast: a young map dipping ONE frame below the
            // inlier floor used to hard-LOST while the pose was still
            // cm-accurate - killing the KLT chain and the candidate bank.
            // Bridge up to mapCoastMax frames on the motion prior (constant
            // pose); map maintenance is SKIPPED during a coast so a stale
            // pose can never anchor new geometry.
            if (!mapResult && this.cfg.bootstrapV2 &&
                this.state === PipelineState.MAP_TRACKING &&
                this._mapCoast < this._frames(this.cfg.mapCoastMax) &&
                sz >= 4 && this.curR) {
                this._mapCoast++
                mapResult = {
                    R: this.curR.slice(), t: this.curT.slice(),
                    nInliers: 0, meanErr: -1, inliers: null, coast: true
                }
                why += ' coast' + this._mapCoast
            }
            if (!mapResult || mapResult.coast || mapResult.rotOnly) this.debug.map_dbg = why
        }

        // --- 3. poster (re)detection ---
        // rotOnlyHuntFast: recovery is keyed on POSE OWNERSHIP, not result
        // existence. A CONTINUOUS weak zombie - the 2D chain degrading
        // gracefully onto background texture without ever failing a fit
        // (so chainGuard's resurrection gate never fires) - used to
        // suppress this whole ladder just by existing: test-slam timeline
        // showed 84 straight MAP_TRACKING frames with ZERO detect
        // attempts while the real poster sat visible. While the map owns
        // the pose and the poster result is weak, hunt anyway; a detect
        // success replaces the zombie wholesale.
        const weakZombie = this.cfg.rotOnlyHuntFast && result && posterWeak && mapResult
        if (!result || weakZombie) {
            if (!mapResult) {
                // Nothing holds the pose (SEARCHING/LOST): alternate cheap
                // half-res attempts (~4x faster, more attempts/sec) with a
                // periodic full-res one (small/far posters need full res).
                // FULL first (a just-lost poster is usually re-found
                // immediately, and small/far posters are invisible at half
                // res), then alternate in cheap half-res attempts.
                this._searchTick++
                const half = (this._searchTick % this.cfg.searchFullEvery) !== 1
                const canReloc = !half && this.env && this.env.relocCount() >= 10 &&
                    (typeof SimdMatcher !== 'undefined') && SimdMatcher.ready
                if (this.env) this.debug.map_dbg = (this.debug.map_dbg || '') +
                    ' rc=' + this.env.relocCount() + (half ? 'h' : 'F')
                this._lastScene = null
                result = this._detectStep(gray, {
                    half: half || undefined, subTarget: true,
                    keepScene: canReloc || undefined
                })
                this.framesSinceRefresh = 0

                // Poster not found: try to RELOCALIZE against the map's
                // descriptor-bearing points (the same scene features the
                // failed detect just computed - no extra ORB pass). Restores
                // MAP_TRACKING without the poster ever entering the view.
                if (!result && canReloc && this._lastScene) {
                    mapResult = this._tryRelocalize()
                }
                this._lastScene = null
            } else {
                // Map holds the pose. Run detection when due:
                //  - first map frame + whenever the map is starving: the view
                //    is moving into unmapped territory and needs fresh
                //    candidates (detection stashes keypoints for harvest)
                //  - periodically: poster retry = the loop closure that
                //    zeroes accumulated VO drift
                // Harvest in newly visible territory: corner-only pass.
                // PROACTIVE: during a pan the map loses points to FOV exit
                // faster than candidates can mature (age + baseline gates
                // need 2-3 frames), so keep the candidate pipeline FULL -
                // waiting for starvation is structurally too late.
                if (this.mapFrames === 0 ||
                    (this.env.candidateCount() < 12 && this._framesSinceHarvest >= this._frames(4))) {
                    this._harvestOnlyStep(gray, null)
                    this._framesSinceHarvest = 0
                }
                // Poster retry: the map pose PREDICTS where the poster is.
                // Offscreen -> skip entirely (this killed the dominant
                // MAP_TRACKING cost: full re-detections of a poster that
                // isn't even in view).
                // Rot-only fly-through catcher: the ROTATION is measured and
                // trustworthy, so the poster's predicted DIRECTION is good
                // even with a frozen center. When the poster is predicted
                // in view, check EVERY frame with a cheap targeted ROI
                // detect - a tilt swings the poster through the frame in a
                // ~6-frame window and the cadence-12 retry missed it
                // entirely (second tilt half then died unrecoverable).
                // async reloc scene delivered by a prior retry: run the
                // relocalization now, against the forwarded descriptors
                if (this._asyncRelocReady) {
                    this._asyncRelocReady = false
                    if (this.env.relocCount() >= 10 &&
                        (typeof SimdMatcher !== 'undefined') && SimdMatcher.ready) {
                        const rr = this._tryRelocalize()
                        if (rr) mapResult = rr
                    }
                    this._lastScene = null
                }

                if (mapResult.rotOnly && !result) {
                    const roiFT = this._posterRoiFromPose(w, h)
                    if (roiFT) {
                        const ftOpts = roiFT.full
                            ? { subTarget: true }
                            : { roi: roiFT, nearLevels: true, subTarget: true }
                        // ALWAYS synchronous, even under splitDetect: this
                        // is a cheap targeted pass (~5-20ms, ROI+nearLevels)
                        // whose pose ANCHORS the rot-only freeze - v1 sent
                        // it async and the stale-forwarded install biased
                        // the freeze anchor for the entire sweep (tilt raw
                        // 2.4->7.5cm). The split's win is the full-detect
                        // spike class (refresh/retry-abs), not this.
                        const detFT = this._detectStep(gray, ftOpts)
                        if (detFT) {
                            result = detFT
                            driftSnap = mapResult
                            this.posterRetryCount = 0
                            this.framesSinceRefresh = Math.max(0, this.cfg.refreshInterval - 6)
                            this._ftMiss = 0
                        } else {
                            // predicted IN VIEW yet not found: evidence the
                            // freeze is LYING (finding its poster here is
                            // the fly-through's whole job). The streak
                            // feeds the hunt escalation; predicted-out
                            // frames are no evidence and do not count.
                            this._ftMiss = (this._ftMiss || 0) + 1
                        }
                    }
                }

                this.posterRetryCount++
                // rotOnlyHuntFast: escalate ONLY when the freeze is SUSPECT
                // (fly-through predicted the poster in view and missed >=4
                // consecutive attempts - the test-slam wrong-freeze hunted
                // the wrong spot for 17 frames while one lazy absolute
                // attempt fired). UNCONDITIONAL escalation made benign
                // freezes PAY: tilt fusedP90 2.59 -> 13.2 and proc 2x from
                // cadence-3 full-density hunts during healthy sweeps. The
                // map is dead by the sz<12 engagement gate, so escalated
                // absolute detects cannot mistrack anything.
                const freezeSuspect = (this._ftMiss || 0) >= this._frames(4)
                const retryDue = this._frames(
                    (this.cfg.rotOnlyHuntFast && mapResult.rotOnly && freezeSuspect)
                        ? 3 : this.cfg.posterRetryInterval)
                if ((!result || weakZombie) && this.posterRetryCount >= retryDue) {
                    this.posterRetryCount = 0
                    let det = null
                    if (mapResult.rotOnly) {
                        // Rot-only position is FROZEN/untrusted, so the ROI
                        // prediction is too: after a viewpoint jump a zombie
                        // rotation lock predicted the poster offscreen
                        // FOREVER and reloc never got a chance (test-slam
                        // teleport, 76cm, permanent). Hunt in ABSOLUTE mode
                        // instead - alternating half/full detects plus
                        // dormant relocalization, exactly like SEARCHING.
                        this._rotRetryTick = (this._rotRetryTick || 0) + 1
                        const full = (this._rotRetryTick % 3) === 0
                        // rotOnlyHuntFast: every third escalated attempt
                        // goes FULL-DENSITY full-res. The subsampled target
                        // (600 features) cannot match a small/oblique
                        // poster that the map-era predicted-ROI path (near
                        // scale levels) could - measured: 15+ absolute
                        // attempts failing on a VISIBLE parked poster while
                        // frozen 22deg off. The occasional expensive detect
                        // is the honest price of a dead freeze.
                        const blast = this.cfg.rotOnlyHuntFast && freezeSuspect &&
                            (this._rotRetryTick % 3) === 2
                        const canReloc = (full || blast) && this.env.relocCount() >= 10 &&
                            (typeof SimdMatcher !== 'undefined') && SimdMatcher.ready
                        const absOpts = {
                            half: (!full && !blast) || undefined,
                            subTarget: !blast || undefined,
                            keepScene: canReloc || undefined
                        }
                        if (!(this.cfg.splitDetect && this._requestDetect('retry-abs', absOpts))) {
                            this._lastScene = null
                            det = this._detectStep(gray, absOpts)
                            if (!det && canReloc && this._lastScene) {
                                const rr = this._tryRelocalize()
                                if (rr) mapResult = rr   // absolute fix replaces the frozen pose
                            }
                            this._lastScene = null
                        }
                    } else {
                        const roi = this._posterRoiFromPose(w, h)
                        const roiOpts = roi && roi.full
                            ? { subTarget: true }
                            : roi ? { roi, nearLevels: true, subTarget: true } : null
                        if (roiOpts) {
                            // poster predicted large/centered: cheap full-frame
                            // exploration pass (no level restriction - lastScale
                            // may be stale after a long map-only stretch).
                            // Synchronous even under splitDetect: reacquisition
                            // poses seed the drift-snap and refresh scheduling;
                            // a hop-forwarded stale install here lands the
                            // reacquire on edge-biased coordinates (same class
                            // as the fly-through anchor bias).
                            det = this._detectStep(gray, roiOpts)
                        }
                    }
                    if (det) {
                        result = det
                        driftSnap = mapResult  // measure drift against this
                        // Reacquire often happens at the view edge via a
                        // sparse ROI detect - schedule a near-term refresh so
                        // the anchor set is rebuilt once the poster centers,
                        // instead of coasting on edge-biased anchors.
                        this.framesSinceRefresh = Math.max(0, this.cfg.refreshInterval - 6)
                    }
                }
            }
        }

        // --- 4. pose solving + TRUST ROUTING ---
        // The poster is absolute truth only when STRONG. A weak poster pose
        // (edge of view) is cross-checked against the physical motion prior;
        // if it jumps implausibly while a healthy map pose exists, the map
        // wins and the weak poster is ignored for pose purposes.
        const priorC = this.curR ? Geometry.invertRT(this.curR, this.curT).t : null
        const priorR = this.curR ? this.curR.slice() : null
        const priorT = this.curT ? this.curT.slice() : null
        const poseGap = this._framesSincePose   // frames since last accepted pose

        let posterPose = null
        if (result) {
            const _tPnp = performance.now()
            posterPose = this._solvePose(result.targetPts, result.scenePts, result.nInliers)
            this.debug.t_pnp = performance.now() - _tPnp
        }
        // "Strong" is calibrated to the measured noise floor: real phones
        // sit at ~2px reprojection even when the pose is excellent, while
        // synthetic renders sit at ~0.6px - a fixed constant is wrong on one
        // of them. The floor learns ONLY from unimpeachable frames (>= 45
        // inliers); a pose then qualifies as strong when its reproj is
        // within ~2x the floor (clamped) and it has enough inliers.
        const rs = this._resScale || 1
        if (posterPose && result.nInliers >= 45 && posterPose.reproj_error < 3 * rs) {
            this.noisePx = this.noisePx === null
                ? posterPose.reproj_error
                : 0.9 * this.noisePx + 0.1 * posterPose.reproj_error
            // perfV1 cold-start CORRECTION: seeding stays at frame 1 (the
            // early bootstrap gates must behave exactly as calibrated -
            // leaving the floor null for 5 frames re-rolled test-slam's
            // chaotic early window, 14/14 -> 10/14), but the first 5 strong
            // samples are collected and the floor SNAPS to their median
            // once available. Clean run: median ~ EMA, near no-op. Polluted
            // frame 1 (measured 3.07px once): repaired before it mis-scales
            // every downstream gate.
            if (this.cfg.perfV1 && this._nzSamples !== null) {
                const s = (this._nzSamples = this._nzSamples || [])
                s.push(posterPose.reproj_error)
                if (s.length >= 5) {
                    s.sort((a, b) => a - b)
                    // repair ONLY actual pollution: on a clean start the
                    // median tracks the EMA and the floor stays BIT-
                    // IDENTICAL to the calibrated baseline (any tiny delta
                    // re-rolls chaotic-window outcomes on canonical seeds)
                    if (Math.abs(s[2] - this.noisePx) > 0.3) this.noisePx = s[2]
                    this._nzSamples = null
                }
            }
        }
        const strongThresh = this.noisePx === null
            ? 1.2 * rs : Math.min(3.0 * rs, Math.max(1.2 * rs, 2.0 * this.noisePx))
        const strongPoster = !!(posterPose && result.nInliers >= 30 &&
            posterPose.reproj_error <= strongThresh)
        this.debug.strong = strongPoster ? 1 : 0
        if (posterPose) this.debug.reproj = Math.round(posterPose.reproj_error * 100) / 100

        // ROT-CONSISTENCY GUARD: an oblique/degraded poster chain does not
        // fail loudly - it SLIDES (few cm of fake translation per frame,
        // under the jump gate), fakes baseline, and poisons triangulation +
        // the noisePx floor, which then loosens strongThresh (a feedback
        // loop measured at 25cm on tilt). The env flow field arbitrates:
        // if it is cleanly explained by pure rotation while a sub-45-inlier
        // poster pose claims real translation this frame, the translation
        // is fake - the flow-measured rotation takes the frame instead.
        // >= 45-inlier poses are exempt (same bar as noisePx learning):
        // a rich frontal chain must never be demoted by a far-scene
        // rotation ambiguity.
        let posterFakeTrans = false
        if (posterPose && this.cfg.rotOnly && result.nInliers < 45 &&
            (!this.env || this.env.size() < 12) &&
            priorC && priorR && this.curR) {
            const fr = this._flowRotation()
            if (fr && fr.clean) {
                const Cn = Geometry.invertRT(this.curR, this.curT).t
                const dC = Math.hypot(Cn[0] - priorC[0], Cn[1] - priorC[1], Cn[2] - priorC[2])
                if (dC > this.cfg.rotOnlyFakeTransM) {
                    if (!mapResult) mapResult = this._rotOnlyStep(priorR, priorT)
                    if (mapResult) {
                        posterFakeTrans = true
                        this.debug.fake_trans = Math.round(dC * 1000) / 1000
                    }
                }
            }
        }

        let kind = null
        if (posterFakeTrans && mapResult) {
            kind = 'map'
        } else if (posterPose && (strongPoster || !mapResult)) {
            kind = 'poster'
        } else if (posterPose && mapResult) {
            const Cn = Geometry.invertRT(this.curR, this.curT).t
            const posterJump = priorC ? Math.hypot(
                Cn[0] - priorC[0], Cn[1] - priorC[1], Cn[2] - priorC[2]) : 0
            kind = posterJump > this.cfg.mapMaxJumpM ? 'map' : 'poster'
            if (kind === 'map') this.debug.poster_rejected_jump = Math.round(posterJump * 1000) / 1000
        } else if (mapResult) {
            kind = 'map'
        }

        // --- 5. state bookkeeping ---
        const prevState = this.state
        if (kind === 'poster') {
            if (prevState === PipelineState.SEARCHING || prevState === PipelineState.LOST) {
                // Acquisition used the cheap exploration set - schedule a
                // near-term FULL refresh to rebuild quality anchors (the
                // map's noise floor is set by poster pose quality)
                this.framesSinceRefresh = Math.max(this.framesSinceRefresh,
                    this.cfg.refreshInterval - 3)
            }
            this.state = PipelineState.TRACKING
            this.lostFrames = 0
            this.trackingFrames++
            this._framesSincePose = 0
            this._searchTick = 0
            this._mapCoast = 0
            this._ftMiss = 0
        } else if (kind === 'map') {
            this.state = PipelineState.MAP_TRACKING
            this.lostFrames = 0
            this.mapFrames++
            // mapDensity2: hold entered - burn off the dense candidate
            // inventory down to the classic stream (see trimCandidates)
            if (this.cfg.mapDensity2 && this.mapFrames === 1 && this.env)
                this.debug.cand_trim = this.env.trimCandidates(12)
            // A coast is NOT a measured pose: the jump-gate allowance must
            // keep growing with the prior's true age or the first real solve
            // after a coast gets rejected for containing 2-3 frames of motion.
            if (!(mapResult && mapResult.coast)) {
                this._framesSincePose = 0
                this._mapCoast = 0
            }
        } else {
            this._dropTracking()
            if (this.state === PipelineState.TRACKING || this.state === PipelineState.MAP_TRACKING) {
                this.state = PipelineState.LOST
                this.lostFrames = 1
            } else if (this.state === PipelineState.LOST) {
                this.lostFrames++
                if (this.lostFrames > this._frames(this.cfg.lostFrameGrace)) {
                    this.state = PipelineState.SEARCHING
                    this.hasPrior = false
                    // KLT chains are broken, but descriptor-bearing points
                    // stay DORMANT for relocalization (the map is no longer
                    // disposable VO state)
                    if (this.env) this.env.sleep()
                }
            }
            this.trackingFrames = 0
            this.mapFrames = 0
        }

        // Keep current frame for next LK step. copyTo into a persistent Mat,
        // NOT clone(): on emscripten-6 builds (slim) Mat.clone() returns a
        // buffer ALIAS, so cloning the worker's reused gray Mat would make
        // prevGray see the NEXT frame's pixels - LK then compares a frame
        // against itself and tracking silently freezes.
        if (!this.prevGray) this.prevGray = new cv.Mat()
        gray.copyTo(this.prevGray)

        // An install is only valid for the frame it was absorbed on. If §1
        // did not consume it (state was SEARCHING/LOST this frame), a later
        // frame must NOT adopt those now-stale coordinates as "current".
        this._installedResult = null

        this.debug.state = this.state

        // --- 6. final pose + map maintenance ---
        let pose = null
        let confidence = 0

        if (kind === 'poster') {
            pose = posterPose
            confidence = Math.min(1.0, result.nInliers / 20.0)

            if (this.env) {
                // Drift-at-reacquire: distance between the map's camera
                // center and the poster-measured one (the honest end-to-end
                // VO quality metric, logged by the app). Survives a short
                // LOST gap between map death and poster return - the metric
                // then includes the gap's real motion; the gap size is logged.
                const snapRef = (driftSnap && { R: driftSnap.R, t: driftSnap.t, age: 0, bridged: this.mapFrames }) ||
                    (this._lastMapPose && this._lastMapPose.age <= this._frames(15) ? this._lastMapPose : null)
                if (snapRef && strongPoster) {
                    const Cm = Geometry.invertRT(snapRef.R, snapRef.t).t
                    const Cp = Geometry.invertRT(this.curR, this.curT).t
                    const driftM = Math.hypot(
                        Cm[0] - Cp[0], Cm[1] - Cp[1], Cm[2] - Cp[2])
                    this.debug.reacquire_drift_m = Math.round(driftM * 1000) / 1000
                    this.debug.map_frames_bridged = snapRef.bridged
                    if (snapRef.age > 0) this.debug.reacquire_gap_frames = snapRef.age
                    this._lastMapPose = null
                    // A >10cm snap invalidates rot-only's frozen-center
                    // assumption retroactively: candidates anchored during
                    // the stretch would fake snap-sized baselines and
                    // triangulate garbage. Flush THOSE - and only those.
                    // (A full sleep() was tried here and starved reloc: it
                    // wiped tracked points whose world-X was still valid,
                    // and a parked camera can never rebuild them - the
                    // dormant+tracked descriptor bank is reloc capital.)
                    if (driftM > 0.1) this.env.dropRotAnchored()
                    // Drift BACK-PROPAGATION (driftComp): the snap just
                    // MEASURED the map's accumulated error - align the map
                    // to poster truth instead of letting refineAndCull
                    // execute it below (a 3-4cm drift measured 21->0 points
                    // in 3 frames; the executed points' descriptors then
                    // sat in the dormant bank with drift-poisoned 3D,
                    // unrecoverable by any honest reloc). Runs AFTER the
                    // rot-anchored flush (fake-baseline candidates are
                    // garbage, not drift). The reference map pose may be up
                    // to 2 frames stale - reacquisition lands WEAK at the
                    // view edge and only strengthens a frame or two later,
                    // by which time driftSnap is gone (measured: the age===0
                    // form never fired). At <=2 frames the gap motion inside
                    // "drift" is cm-bounded and the per-point
                    // reproject-improves gate rejects unhelpful corrections;
                    // after a real LOST gap (age > 2) the measure is
                    // gap-motion, not drift - skip. Bounds: below 1.5cm
                    // refinement handles it cheaper; above 0.5m it is a
                    // tracking break, not drift.
                    // NOT edgeGate-gated (v3): reacquisition LANDS at the
                    // view edge by nature - gating driftComp on geometry
                    // health blocks it at exactly its firing moment (the
                    // age<=2 window expires before the poster re-centers;
                    // measured: test-slam max err 30->44.8cm). Its bias
                    // risk is already bounded per point by the
                    // reproject-improves gate inside applyDriftCorrection.
                    if (this.cfg.driftComp && strongPoster && snapRef.age <= 2 &&
                        driftM > 0.015 && driftM < 0.5) {
                        const dc = this.env.applyDriftCorrection(
                            this.Kp, this.curR, this.curT, snapRef.R, snapRef.t)
                        this.debug.drift_comp = dc.moved + '/' + dc.total + '+d' + dc.dorm
                    }
                }
                this.mapFrames = 0
                // Map maintenance ONLY under a STRONG poster pose: at the
                // view edge (few inliers, oblique) PnP is biased, and
                // refining/anchoring against a biased pose CORRUPTS good map
                // depths exactly when the map is about to be needed.
                // edgeGate v4: HARD block at unhealthy geometry (v3's
                // "provisional growth" tier let edge-anchored points into
                // the handoff map and the late hold died on them: map
                // 11->0 at f96, max err 44.8cm) PLUS a STARVATION VALVE -
                // tilt-class poses ride the frame edge ALL run, and a
                // permanent freeze builds no map at all (opt-r v1: tilt
                // mapPeak 5->0, fused tail 2.92->9.52 arm on bad rolls).
                // One biased-anchored full pass per ~1.5s beats
                // starvation; the valve never opens while healthy frames
                // keep the clock fresh.
                const _geomOK = strongPoster &&
                    (!this.cfg.edgeGate || this._posterGeomOK(result, w, h))
                // Starved = BUILDING (map < 15 pts: bootstrap and
                // post-reloc rebuild have little to poison and everything
                // to gain - stock always built at any geometry) or FROZEN
                // too long (tilt-class edge-riders, one pass per ~1.5s).
                const _mntStarved = (this.env && this.env.size() < 15) ||
                    this._frameIdx - (this._lastMntF || -1e9) > this._frames(30)
                if (strongPoster && this.cfg.edgeGate && !_geomOK && !_mntStarved) {
                    this.debug.edge_block = 1
                }
                if (strongPoster && (_geomOK || _mntStarved)) {
                    this._lastMntF = this._frameIdx
                    const _tMnt = performance.now()
                    this.debug.m_cull += this.env.refineAndCull(this.Kp, this.curR, this.curT,
                        this._cullPx())
                    // relocV3 keyframes: capture AFTER the cull - the
                    // surviving desc-points were verified against poster
                    // truth THIS FRAME, so this snapshot's 3D is ground-
                    // contacted by construction (keyframes are never
                    // drift-corrected: they were taken AT truth moments).
                    // Never minted from an edge-biased frame (edgeGate).
                    this._kfTick = (this._kfTick || 0) + 1
                    if (this.cfg.relocV3 && _geomOK && this._kfTick >= this._frames(15)) {
                        if (this.env.snapshotKeyframe(this._frameIdx)) this._kfTick = 0
                    }
                    // bootstrapV2: proactive corner-only replenishment DURING
                    // poster tracking (it was MAP_TRACKING-only). The traces
                    // show candidates pinned at 0 through the poster-exit
                    // window while KLT bleeds map points - that starvation is
                    // what decided the bootstrap coin flip. ~8ms, cheap pass,
                    // only when the candidate pipeline runs low.
                    // mapDensity2 engages only once the map has POINTS:
                    // promotion requires baseline, so size()>0 is direct
                    // evidence of translation. Under rotation-dominant motion
                    // (tilt: mapPeak 0) candidates cannot mature - boosting
                    // harvest there just floods rot-only's 2D flow substrate
                    // with young churn (measured: tilt seed 5 held 100->51%,
                    // 2.75->37.8cm, from a 34-candidate view-edge burst).
                    const _dens = this.cfg.mapDensity2 && this.env.size() > 0
                    const _hLow = _dens ? 24 : 12
                    const _hCad = _dens
                        ? ((this.env.candidateCount() < 8) ? 2 : 3)
                        : ((this.cfg.rotOnly && this.env.candidateCount() < 8) ? 2 : 4)
                    if (this.cfg.bootstrapV2 && !this._pendingHarvest &&
                        this.env.candidateCount() < _hLow &&
                        this._framesSinceHarvest >= this._frames(_hCad)) {
                        this._harvestOnlyStep(gray, result && result.corners ? result.corners : null)
                        this._framesSinceHarvest = 0
                    }
                    if (this._pendingHarvest) {
                        this._refreshDormantDescs(w, h)
                        this.debug.m_harv += this.env.harvest(this._pendingHarvest.pts, this._pendingHarvest.corners,
                            this.curR, this.curT, w, h, this._pendingHarvest.desc, this._mapGS(),
                            false, /* trusted: */ true)
                        this._pendingHarvest = null
                    }
                    // bootstrapV2: with the poster anchoring the pose (metric
                    // truth, no VO drift) triangulation can afford LESS
                    // baseline/parallax - candidates mature ~4 frames sooner,
                    // so the poster-exit handoff finds a populated map. The
                    // admitted depth noise is corrected by refine-before-cull
                    // + young-point immunity.
                    this.debug.m_tri += this.env.triangulate(this.Kp, this.curR, this.curT, this._triMaxPx(),
                        // bootstrapV2's 0.75 parallax relaxation exists to
                        // beat exit starvation - but under mapDensity2 the
                        // dense inventory solves starvation, and KEEPING the
                        // relaxation is poison: a fat queue means candidates
                        // hit the minimal gate the moment they age in, so
                        // the whole map promotes at minimum parallax with
                        // correlated shallow-depth bias. Away-walks (depth/
                        // rotation-ambiguous) then lock a coherently warped
                        // pose (test-slam: 27 deg median on a SURVIVING
                        // 69-pt map). Density affords full parallax demand.
                        this.cfg.bootstrapV2 && !this.cfg.mapDensity2 ? 0.75 : undefined)
                    this.debug.t_mnt = performance.now() - _tMnt
                }
            }
        } else if (kind === 'map') {
            if (this.debug.mode !== 'reloc') {
                this.debug.mode = mapResult.coast ? 'map-coast'
                    : mapResult.rotOnly ? 'rot-only' : 'map-track'
            }
            this.debug.inliers = mapResult.nInliers
            this.debug.track_points = mapResult.nInliers
            this._adoptRt(mapResult.R, mapResult.t)  // also repairs a prior
                                                     // poisoned by a weak poster solve
            if (mapResult.reloc) {
                // A relocalization IS a viewpoint discontinuity. Any poster
                // KLT chain from before it is a ZOMBIE: LK can lock its stale
                // anchors onto background texture and emit a self-consistent
                // pose at the PRE-jump location (measured 55cm off, and its
                // maintenance then culled the whole freshly-relocated map).
                // The poster must be re-acquired by a fresh, descriptor-
                // validated DETECTION.
                this._dropTracking()
            }
            // no purge on rot-only: its inlier set is over FLOWS, not 3D points
            if (!mapResult.reloc && !mapResult.coast && !mapResult.rotOnly) {
                this.debug.m_purge += this.env.purgeOutliers(mapResult.inliers)
            }
            if (!mapResult.coast) {
                this._lastMapPose = {
                    R: mapResult.R.slice(), t: mapResult.t.slice(),
                    age: 0, bridged: this.mapFrames
                }
            }
            pose = this._poseFromRt(mapResult.R, mapResult.t,
                mapResult.nInliers, this.env.size(), mapResult.meanErr)
            // rot-only: orientation is live but the center is frozen -
            // confidence stays low so consumers treat position as coarse
            confidence = mapResult.coast ? 0.15
                : mapResult.rotOnly ? 0.25
                : Math.min(1.0, mapResult.nInliers / 30.0)

            // Map maintenance continues WITHOUT the poster: harvest from any
            // detection run this frame (anchored at the map pose - drifty but
            // metric) and triangulate matured candidates, so the map extends
            // into newly visible territory instead of starving. NEVER during
            // a coast: a stale pose must not anchor new geometry.
            if (!mapResult.coast) {
                // rot-only lifeline: the mode lives on tracked 2D flows, and
                // during a sustained rotation those exit the FOV faster than
                // anything replenishes them (the Â§3 harvest path needs the
                // poster result to be absent). Corner-only harvest keeps the
                // substrate alive; the frozen center means zero baseline, so
                // these candidates cannot triangulate until real translation
                // resumes - exactly right.
                // EARLY threshold (24, not 12): a sustained rotation sweeps
                // 2-3 candidates out of the FOV per frame; the first tilt
                // died at 12-cands-then-too-late while the second half,
                // which happened to start at 40, rode through fine. At
                // critical starvation (<8) drop the cadence to every-2nd
                // frame - the mode is about to lose its substrate entirely.
                if (mapResult.rotOnly && !this._pendingHarvest &&
                    (this.env.size() + this.env.candidateCount()) < 24 &&
                    this._framesSinceHarvest >=
                        this._frames(this.env.candidateCount() < 8 ? 2 : 3)) {
                    this._harvestOnlyStep(gray, null)
                    this._framesSinceHarvest = 0
                }
                if (this._pendingHarvest) {
                    this._refreshDormantDescs(w, h)
                    this.debug.m_harv += this.env.harvest(this._pendingHarvest.pts, null,
                        this.curR, this.curT, w, h, this._pendingHarvest.desc, this._mapGS(),
                        !!mapResult.rotOnly)
                    this._pendingHarvest = null
                }
                const gateScale = 1 + Math.min(1, this.mapFrames / this._frames(45))
                this.debug.m_tri += this.env.triangulate(this.Kp, this.curR, this.curT, this._triMaxPx(), gateScale)
            }
        }

        // Translation-speed tracker (rot-only engagement gate): EMA of the
        // center displacement per frame across consecutive ABSOLUTE poses.
        // Coast repeats the prior and rot-only freezes it - neither measures
        // speed, and SKIPPING them preserves the pre-engagement speed, so a
        // mid-walk capture cannot re-qualify itself by self-freezing.
        this._wasRotOnly = (kind === 'map' && !!mapResult.rotOnly)

        this.debug.map_points = this.env ? this.env.size() : 0
        this.debug.map_cands = this.env ? this.env.candidateCount() : 0
        if (this.env) {
            const cd = this.env.cd
            this.debug.m_cd = cd.lk + '/' + cd.tri + '/' + cd.flush + '/' + cd.rot + '/' + cd.promo
        }
        this.debug.noise_px = this.noisePx === null
            ? null : Math.round(this.noisePx * 100) / 100

        const procMs = performance.now() - t0

        // DEV-ONLY map visualization payload. Production (debugMap unset)
        // pays exactly one boolean check - no copies, no transfer bytes.
        // Stride 8 per point: [X, Y, Z, kind, residualPx, sigmaZ, obs, baseline]
        //   kind: 1 tracked / 0 dormant
        //   residualPx: current-view reprojection residual (-1 if no pose)
        //   sigmaZ: depth std-dev estimate sigma_Z ~ Z^2 * sigma_px / (f * b)
        //   obs: refineAndCull observation count; baseline: anchor baseline m
        let mapViz
        if (this.cfg.debugMap && this.env) {
            const tracked = this.env.points
            const dormant = this.env.dormant
            const pts = new Float32Array((tracked.length + dormant.length) * 8)
            const havePose = !!(this.curR && this.hasPrior)
            const sigPx = this.noisePx === null ? 1.0 : this.noisePx
            const fx = this.Kp ? this.Kp[0] : 400
            let o = 0
            for (const p of tracked) {
                pts[o++] = p.X[0]; pts[o++] = p.X[1]; pts[o++] = p.X[2]; pts[o++] = 1
                let res = -1, sig = -1
                if (havePose) {
                    const pr = Geometry.project(this.Kp, this.curR, this.curT, p.X)
                    if (pr[2] > 0.01) {
                        res = Math.hypot(pr[0] - p.u, pr[1] - p.v)
                        const b = p.b0
                        if (b && isFinite(b) && b > 1e-4) {
                            sig = (pr[2] * pr[2] * sigPx) / (fx * b)
                        }
                    }
                }
                pts[o++] = res; pts[o++] = sig
                pts[o++] = p.obs || 0
                pts[o++] = (p.b0 && isFinite(p.b0)) ? p.b0 : -1
            }
            for (const d of dormant) {
                pts[o++] = d.X[0]; pts[o++] = d.X[1]; pts[o++] = d.X[2]; pts[o++] = 0
                pts[o++] = -1; pts[o++] = -1; pts[o++] = 0; pts[o++] = -1
            }
            mapViz = { pts, stride: 8, tracked: tracked.length, dormant: dormant.length,
                       cands: this.env.candidateCount() }
        }

        if (!pose) {
            const out0 = { detected: false, frameSize: [w, h], debug: this._debugOut(procMs) }
            if (mapViz) out0.mapViz = mapViz
            return out0
        }

        const out = {
            detected: true,
            frameSize: [w, h],
            confidence,
            debug: this._debugOut(procMs)
        }
        if (mapViz) out.mapViz = mapViz
        if (kind === 'poster' && result.corners) out.corners = result.corners
        out.pose = pose
        out.debug.tracking_state = this.state
        out.debug.tracking_confidence = pose.confidence
        return out
    }

    _debugOut(procMs) {
        return Object.assign({}, this.debug, { proc_ms: Math.round(procMs * 10) / 10 })
    }

    // ================= Async detection service (splitDetect) =================

    /**
     * SERVICE SIDE (runs in the detection sub-worker's own pipeline
     * instance): execute one detection with the TRACKER's learned gate
     * state and package every side product as plain transferable data.
     */
    serveDetect(gray, opts, state) {
        if (state) {
            if (state.fastThresh) this._fastThresh = state.fastThresh
            if (state.lastScale) this.lastScale = state.lastScale
            if (state.noisePx != null) this.noisePx = state.noisePx
        }
        this._resScale = Math.max(1, Math.max(gray.cols, gray.rows) / 480)
        this._pendingHarvest = null
        this._lastScene = null
        this.debug = {}
        const det = this._detectStep(gray, opts || {})
        const out = { det: null, harvest: null, scene: null, fastThresh: this._fastThresh }
        if (det) {
            out.det = {
                targetPts: new Float32Array(det.targetPts),
                scenePts: new Float32Array(det.scenePts),
                nInliers: det.nInliers,
                corners: det.corners
            }
        }
        if (this._pendingHarvest) {
            out.harvest = {
                pts: new Float32Array(this._pendingHarvest.pts),
                desc: this._pendingHarvest.desc ? new Uint8Array(this._pendingHarvest.desc) : null
            }
        }
        if (this._lastScene) {
            out.scene = {
                pts: new Float32Array(this._lastScene.pts),
                desc: new Uint8Array(this._lastScene.desc)
            }
        }
        this._pendingHarvest = null
        this._lastScene = null
        return out
    }

    /**
     * TRACKER SIDE: post a detection request (one in flight at a time).
     * The worker owns the transport; the pipeline only describes the work.
     */
    _requestDetect(kind, opts) {
        if (!this.onDetectRequest) return false
        if (this._detPending) return true   // in flight: the request IS handled
        this._detPending = { frameId: this._frameIdx, kind }
        const sent = this.onDetectRequest({
            frameId: this._frameIdx,
            kind,
            opts: opts || {},
            state: {
                fastThresh: this._fastThresh,
                lastScale: this.lastScale,
                noisePx: this.noisePx
            }
        })
        if (sent === false) {
            // transport not ready (service still booting its WASM): tell
            // the call site to run its SYNCHRONOUS fallback this frame
            this._detPending = null
            return false
        }
        return true
    }

    /** Worker delivers the sub-worker's reply here; absorbed next frame. */
    applyDetectResult(reply) {
        this._detReply = reply
    }

    /**
     * Absorb a parked detection reply at the top of processFrame: forward
     * every returned coordinate from the request frame to the CURRENT
     * frame by LK-hopping through the retained gray ring one frame at a
     * time, then install anchors / harvest / reloc scene exactly as a
     * synchronous detect would have. Stale beyond the ring (or
     * LK-unforwardable) replies are discarded - the next cadence tick
     * simply re-requests.
     */
    _absorbDetReply(gray) {
        const reply = this._detReply
        this._detReply = null
        const pend = this._detPending
        this._detPending = null
        if (!reply || !reply.res) return

        const age = this._frameIdx - reply.frameId
        const src = this._grayRing.find(r => r.f === reply.frameId)
        if (age > 0 && !src) return                    // too stale to forward
        const res = reply.res

        // Collect every coordinate set that must ride to the current frame
        const sets = []
        if (res.det) sets.push({ key: 'det', pts: res.det.scenePts })
        if (res.harvest) sets.push({ key: 'harvest', pts: res.harvest.pts })
        if (res.scene) sets.push({ key: 'scene', pts: res.scene.pts })
        if (!sets.length) return

        if (age > 0) {
            let total = 0
            for (const s of sets) total += s.pts.length / 2
            let flat = new Float32Array(total * 2)
            let o = 0
            for (const s of sets) { flat.set(s.pts, o); o += s.pts.length }
            // Forward request-frame coords to "now" one RETAINED FRAME AT A
            // TIME (ring[idx] -> ring[idx+1] -> ... -> gray). v1 did the
            // whole span in a single LK jump; under fast rotation that jump
            // is exactly where the forwarding error lived (tilt: installs
            // biased the rot-only freeze anchor, raw 2.4->7.5cm). Per-frame
            // hops run under the same conditions as the live chain's LK.
            // The passes must be SIDE-EFFECT FREE: the prediction seed and
            // pyramid carry belong to the frame-to-frame chain, not here.
            const idx = this._grayRing.indexOf(src)
            const saveA = this._pyrA; this._pyrA = null
            const saveFlow = this._lastFlow; this._lastFlow = null
            const savePrev = this.prevGray
            const okAll = new Uint8Array(total).fill(1)
            for (let k = idx; k < this._grayRing.length; k++) {
                const from = this._grayRing[k].mat
                const to = (k + 1 < this._grayRing.length) ? this._grayRing[k + 1].mat : gray
                this.prevGray = from
                const lk = this._lkAll(to, flat)
                if (this._pyrA && this._pyrA !== saveA) { this._pyrA.delete(); this._pyrA = null }
                this._lastFlow = null
                for (let i = 0; i < total; i++) {
                    if (!lk.ok[i]) okAll[i] = 0
                    // dead points ride along at their last position (cheap,
                    // keeps indices aligned); they are filtered by okAll
                }
                flat = lk.next.slice ? lk.next.slice(0) : new Float32Array(lk.next)
            }
            this.prevGray = savePrev
            this._pyrA = saveA
            this._pyrAFrame = -9
            this._lastFlow = saveFlow
            let p = 0
            for (const s of sets) {
                const n = s.pts.length / 2
                s.fwd = flat.slice(p * 2, (p + n) * 2)
                s.ok = okAll.subarray(p, p + n)
                p += n
            }
        } else {
            for (const s of sets) { s.fwd = s.pts; s.ok = null }
        }

        // Install the poster anchor chain (target coords are frame-free).
        // The forwarded positions are AT THE CURRENT FRAME - they must NOT
        // be LK'd again from prevGray this frame (double shift). Complete
        // the fit here (mirroring _trackStep's tail) and hand §1 a ready
        // result; the env set is tracked separately by the caller.
        //
        // STALE-INSTALL GUARD (split v2): the multi-frame LK hop is the
        // error source, and its error scales with how much MOTION the hop
        // spans - v1 measured tilt raw 2.49->7.54cm from age-2/3 installs
        // replacing a healthy live chain during fast rotation. When a
        // healthy chain is tracking, only install a reply whose hop spans
        // little motion (age * median flow), or one clearly STRONGER than
        // the live chain (a full re-anchor after decay). Skipped installs
        // still deliver harvest/reloc-scene; the next cadence re-requests.
        let allowInstall = true
        if (res.det && this.trackScene &&
            this.trackScene.length / 2 >= this.cfg.refreshPointThreshold &&
            (this.state === PipelineState.TRACKING || this.state === PipelineState.MAP_TRACKING)) {
            const liveN = this.trackScene.length / 2
            const flowMag = this._lastFlow
                ? Math.hypot(this._lastFlow.dx, this._lastFlow.dy) : 0
            const spanPx = age * flowMag
            // A clearly stronger reply (full re-anchor after chain decay)
            // may stretch the span allowance - but only 2x: during a fast
            // sweep the live chain thins while service replies stay fat,
            // and an uncapped strength bypass re-admits exactly the stale
            // installs the guard exists to block (tilt: raw 2.4 -> 4.6cm).
            const stronger = res.det.nInliers >= liveN * 1.25 &&
                spanPx <= this.cfg.splitInstallMaxSpanPx * 2
            if (spanPx > this.cfg.splitInstallMaxSpanPx && !stronger) {
                allowInstall = false
                this.debug.det_async = (pend ? pend.kind : '?') + '-skip' + age
            }
        }
        if (res.det && allowInstall) {
            const d = sets.find(s => s.key === 'det')
            const t = [], sc = []
            for (let i = 0; i < d.fwd.length / 2; i++) {
                if (d.ok && !d.ok[i]) continue
                t.push(res.det.targetPts[i * 2], res.det.targetPts[i * 2 + 1])
                sc.push(d.fwd[i * 2], d.fwd[i * 2 + 1])
            }
            if (t.length / 2 >= this.cfg.minTrackPoints) {
                const src2 = new Float32Array(t)
                const dst2 = new Float32Array(sc)
                if (this.cfg.precisionV2) this._subpixRefine(gray, dst2)
                const fit = this._homographyFit(src2, dst2,
                    this.cfg.trackRansacThresh * (this._resScale || 1))
                if (fit) {
                    const corners = this._projectCorners(fit.H)
                    const quadOk = this._validateQuad(corners, this.lastScale)
                    fit.H.delete()
                    if (quadOk && fit.inlierIdx.length >= this.cfg.minTrackPoints) {
                        const nIn = fit.inlierIdx.length
                        const tKeep = new Float32Array(nIn * 2)
                        const sKeep = new Float32Array(nIn * 2)
                        for (let j = 0; j < nIn; j++) {
                            const i = fit.inlierIdx[j]
                            tKeep[j * 2] = src2[i * 2]; tKeep[j * 2 + 1] = src2[i * 2 + 1]
                            sKeep[j * 2] = dst2[i * 2]; sKeep[j * 2 + 1] = dst2[i * 2 + 1]
                        }
                        this.trackTarget = tKeep
                        this.trackScene = sKeep
                        // descriptor-verified fresh chain (see _detectStep)
                        this._fitFailStreak = 0
                        this._chainPatches = null
                        this.framesSinceRefresh = age
                        this.posterRetryCount = 0
                        this._installedResult = {
                            targetPts: tKeep, scenePts: sKeep,
                            nInliers: nIn, corners, trackPoints: nIn
                        }
                        this.debug.det_async = (pend ? pend.kind : '?') + '+' + age
                    }
                }
            }
        }

        // Harvest keypoints -> candidate bank, anchored at the CURRENT pose
        if (res.harvest && this.env && this.curR && this.hasPrior) {
            const h = sets.find(s => s.key === 'harvest')
            const keep = []
            for (let i = 0; i < h.fwd.length / 2; i++) {
                if (h.ok && !h.ok[i]) continue
                keep.push(i)
            }
            if (keep.length) {
                const pts = new Float32Array(keep.length * 2)
                const desc = res.harvest.desc ? new Uint8Array(keep.length * 32) : null
                for (let j = 0; j < keep.length; j++) {
                    const i = keep[j]
                    pts[j * 2] = h.fwd[i * 2]; pts[j * 2 + 1] = h.fwd[i * 2 + 1]
                    if (desc) desc.set(res.harvest.desc.subarray(i * 32, i * 32 + 32), j * 32)
                }
                this._pendingHarvest = { pts, corners: null, desc }
            }
        }

        // Reloc scene: forwarded positions + descriptors, consumed by the
        // caller's normal reloc path this frame
        if (res.scene) {
            const s = sets.find(x => x.key === 'scene')
            const keep = []
            for (let i = 0; i < s.fwd.length / 2; i++) {
                if (s.ok && !s.ok[i]) continue
                keep.push(i)
            }
            if (keep.length >= 8) {
                const pts = new Float32Array(keep.length * 2)
                const desc = new Uint8Array(keep.length * 32)
                for (let j = 0; j < keep.length; j++) {
                    const i = keep[j]
                    pts[j * 2] = s.fwd[i * 2]; pts[j * 2 + 1] = s.fwd[i * 2 + 1]
                    desc.set(res.scene.desc.subarray(i * 32, i * 32 + 32), j * 32)
                }
                this._lastScene = { pts, desc }
                this._asyncRelocReady = true
            }
        }
    }

    /** Retain the current gray for stale-reply forwarding (ring of 4). */
    _ringPush(gray) {
        const RING = 4
        let slot
        if (this._grayRing.length >= RING) {
            slot = this._grayRing.shift()
        } else {
            slot = { f: -1, mat: new cv.Mat() }
        }
        gray.copyTo(slot.mat)
        slot.f = this._frameIdx
        this._grayRing.push(slot)
    }

    // ================= Detection (acquisition / re-anchoring) =================

    /**
     * Poster detection with cost control:
     *   opts.roi        - {x,y,width,height}: detect only where the poster is
     *                     predicted to be (re-anchor / retry: ~5x cheaper)
     *   opts.nearLevels - match only the target level(s) near lastScale
     *                     (re-anchor: the scale is already known; ~3x fewer
     *                     Hamming comparisons)
     *   opts.half       - run on a pooled half-res frame (SEARCHING: ~4x
     *                     cheaper per attempt; far/small posters need the
     *                     periodic full-res attempt the caller alternates in)
     */
    _detectStep(gray, opts) {
        opts = opts || {}
        this.debug.mode = 'detect'

        let src = gray
        let view = null
        let offX = 0, offY = 0, coordScale = 1

        if (opts.half || opts.halfSnap) {
            if (!this._halfGray) this._halfGray = new cv.Mat()
            cv.resize(gray, this._halfGray, new cv.Size(gray.cols >> 1, gray.rows >> 1))
            src = this._halfGray
            coordScale = 2
        } else if (opts.roi) {
            view = gray.roi(new cv.Rect(opts.roi.x, opts.roi.y, opts.roi.width, opts.roi.height))
            src = view
            offX = opts.roi.x
            offY = opts.roi.y
        }

        this.orb.setMaxFeatures(opts.roi ? this.cfg.roiFeatures : this.cfg.sceneFeatures)
        this.orb.setFastThreshold(this._fastThresh)

        const tOrb = performance.now()
        const kp = new cv.KeyPointVector()
        const desc = new cv.Mat()
        const mask = new cv.Mat()
        this.orb.detectAndCompute(src, mask, kp, desc)
        mask.delete()
        if (view) view.delete()
        this.debug.det_orb_ms = Math.round((performance.now() - tOrb) * 10) / 10

        const nScene = kp.size()
        this.debug.keypoints = nScene
        if (!opts.roi && !opts.half && !opts.halfSnap) this._adaptFast(nScene)
        if (nScene < 8) { kp.delete(); desc.delete(); return null }

        // Scene points as flat array, in FULL-RES frame coordinates
        const scenePts = new Float32Array(nScene * 2)
        for (let i = 0; i < nScene; i++) {
            const p = kp.get(i).pt
            scenePts[i * 2] = p.x * coordScale + offX
            scenePts[i * 2 + 1] = p.y * coordScale + offY
        }
        kp.delete()

        // halfSnap: pull the 2px-quantized half-res coordinates onto true
        // FULL-res corners before anything (anchors, harvest, matching
        // geometry) consumes them. Widened clamp: quantization is ~1px.
        if (opts.halfSnap && this.cfg.precisionV2) {
            this._subpixRefine(gray, scenePts, 1.5)
        }

        // Stash keypoints for environment harvesting REGARDLESS of whether
        // the poster matches below - during MAP_TRACKING the poster is gone
        // but newly visible regions must still seed candidates, or the map
        // starves as the view moves into unmapped territory.
        // (Skipped for half-res: 2px-quantized anchors poison triangulation.)
        if (!opts.half) {
            this._pendingHarvest = {
                pts: scenePts,
                corners: null,
                // descriptor bytes ride along: harvested candidates become
                // RELOCALIZABLE map points (19KB copy on detect frames only)
                desc: new Uint8Array(desc.data.subarray(0, nScene * 32))
            }
            if (!opts.roi) this._framesSinceHarvest = 0
        }

        // Scene features for relocalization: only captured when the caller
        // asks (LOST/SEARCHING full-res attempts with a relocalizable map) -
        // zero cost otherwise.
        if (opts.keepScene) {
            this._lastScene = {
                pts: scenePts,
                desc: new Uint8Array(desc.data.subarray(0, nScene * 32))
            }
        }

        // matchBox: prune IMPOSSIBLE match candidates. Unlike the (failed)
        // ROI-detection variants, this leaves the detector untouched - same
        // keypoints, same anchors, same harvest - and only restricts the
        // brute-force matching to scene keypoints inside the known poster
        // quad, where every true match lives. Matching is the measured
        // bottleneck and linear in scene count (~600 -> ~200 rows).
        let matchDesc = desc
        let sceneIdxMap = null
        if (opts.matchBox && !opts.half && !opts.roi) {
            const b = opts.matchBox
            const idx = []
            for (let i = 0; i < nScene; i++) {
                const x = scenePts[i * 2], y = scenePts[i * 2 + 1]
                if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) idx.push(i)
            }
            if (idx.length >= this.cfg.minMatches) {
                matchDesc = new cv.Mat(idx.length, 32, cv.CV_8U)
                for (let r = 0; r < idx.length; r++) {
                    matchDesc.data.set(desc.data.subarray(idx[r] * 32, idx[r] * 32 + 32), r * 32)
                }
                sceneIdxMap = idx
            } else {
                // Almost no scene points inside the known quad: the poster is
                // leaving the view. A full-density match here cannot anchor
                // anything useful (the boundary frame measured 50-120ms doing
                // exactly that) - fail fast; the map/LOST paths take over.
                desc.delete()
                this.debug.det_match_ms = 0
                return null
            }
        }

        let best = null
        const tMatch = performance.now()

        for (const level of this._scaleOrder(opts.nearLevels)) {
            // Exploration (searching/retry) matches the subsampled target set
            // (~3x cheaper, only needs to FIND); quality-path refreshes match
            // the full set (their anchors feed the map).
            const tDesc = opts.subTarget ? level.subDesc : level.desc
            const tPts = opts.subTarget ? level.subPts : level.pts
            const m = this._match(tDesc, matchDesc)
            if (m.length < this.cfg.minMatches) continue

            // Build correspondence arrays (map filtered indices back)
            const src = new Float32Array(m.length * 2)
            const dst = new Float32Array(m.length * 2)
            for (let i = 0; i < m.length; i++) {
                const si = sceneIdxMap ? sceneIdxMap[m[i].t] : m[i].t
                src[i * 2] = tPts[m[i].q * 2]
                src[i * 2 + 1] = tPts[m[i].q * 2 + 1]
                dst[i * 2] = scenePts[si * 2]
                dst[i * 2 + 1] = scenePts[si * 2 + 1]
            }

            const fit = this._homographyFit(src, dst, this.cfg.ransacThresh * (this._resScale || 1))
            if (!fit) continue

            const { H, inlierIdx, reproj } = fit
            const nIn = inlierIdx.length

            // Threshold checks (ported from processor.py)
            const minInliers = Math.max(this.cfg.minInliersBase, Math.round(12 * level.scale))
            const ratio = nIn / m.length
            const reqRatio = level.scale < 0.5 ? this.cfg.minInlierRatioSmall : this.cfg.minInlierRatio
            const maxErr = 3.0 + (1.0 - level.scale) * 4.0

            if (nIn < minInliers || ratio < reqRatio || reproj > maxErr) { H.delete(); continue }

            const corners = this._projectCorners(H)
            if (!this._validateQuad(corners, level.scale)) { H.delete(); continue }

            // Score (same weights as server pipeline)
            const score = nIn * 0.4 + ratio * 20 + (1.0 / Math.max(0.5, reproj)) * 5
            if (!best || score > best.score) {
                if (best) best.H.delete()
                best = { H, inlierIdx, src, dst, corners, score, nIn, ratio, reproj, scale: level.scale, nMatches: m.length }
            } else {
                H.delete()
            }

            // Early exit if excellent
            if (nIn >= 15 && ratio >= 0.5 && reproj < 2.0) break
            if (this.state === PipelineState.TRACKING && nIn >= 12 && ratio >= 0.45 && reproj < 3.5) break
        }

        if (sceneIdxMap) matchDesc.delete()
        desc.delete()
        this.debug.det_match_ms = Math.round((performance.now() - tMatch) * 10) / 10
        if (!best) return null

        // Build anchored tracking set from inliers (uniform subsample to cap)
        const n = best.inlierIdx.length
        const step = Math.max(1, Math.floor(n / this.cfg.maxTrackPoints))
        const tPts = [], sPts = []
        for (let i = 0; i < n; i += step) {
            const idx = best.inlierIdx[i]
            tPts.push(best.src[idx * 2], best.src[idx * 2 + 1])
            sPts.push(best.dst[idx * 2], best.dst[idx * 2 + 1])
        }
        this.trackTarget = new Float32Array(tPts)
        this.trackScene = new Float32Array(sPts)
        // A detect-built chain is descriptor-verified appearance: it is not
        // a resurrection, and templates from the OLD chain must not veto it.
        this._fitFailStreak = 0
        this._chainPatches = null
        // precisionV2: ORB keypoint positions are pyramid-quantized - refine
        // the fresh anchors to sub-pixel (full-res detects only; half-res
        // coordinates live in a different pixel grid)
        if (this.cfg.precisionV2 && !opts.half) this._subpixRefine(gray, this.trackScene)
        // Half-res shifts the apparent scale: a level matching at s on the
        // half image corresponds to ~2s at full res - record THAT, so the
        // next full-res near-level pass picks the right pyramid level.
        this.lastScale = (opts.half || opts.halfSnap) ? Math.min(1.0, best.scale * 2) : best.scale

        this.debug.mode = 'detect'
        this.debug.good_matches = best.nMatches
        this.debug.inliers = best.nIn
        this.debug.scale_used = best.scale
        this.debug.track_points = this.trackTarget.length / 2

        const out = {
            targetPts: this.trackTarget,
            scenePts: this.trackScene,
            nInliers: best.nIn,
            corners: best.corners,
            trackPoints: this.trackTarget.length / 2
        }
        best.H.delete()

        // Poster matched: exclude its quad from harvesting. Half-res detects
        // intentionally set NO pending harvest (quantized anchors poison
        // triangulation) - writing unconditionally crashed the worker on any
        // successful half-res reacquisition.
        if (this._pendingHarvest) this._pendingHarvest.corners = best.corners
        return out
    }

    _scaleOrder(nearOnly) {
        const near = [], far = []
        for (const l of this.targetLevels) {
            (Math.abs(l.scale - this.lastScale) < 0.15 ? near : far).push(l)
        }
        far.sort((a, b) => a.scale - b.scale)
        if (nearOnly && near.length) return near
        return near.concat(far)
    }

    /**
     * Corner-only pass for environment harvesting: ORB.detect WITHOUT
     * descriptor computation or matching (those were measured at 92% of a
     * full detect's cost; harvesting needs only positions). ~8ms vs ~32ms.
     */
    /**
     * edgeGate: is the poster's VIEWING GEOMETRY strong enough to anchor
     * map maintenance? Inlier count + reproj (strongPoster) still pass at
     * the view edge / oblique / far, where planar PnP carries cm-scale
     * bias. Three cheap physical checks; see the edgeGate flag docs.
     */
    _posterGeomOK(result, w, h) {
        if (!result || !result.corners || result.corners.length < 4) return false
        const cs = result.corners
        const m = 0.02 * w
        let inside = 0
        for (const c of cs) {
            if (c[0] >= m && c[0] <= w - m && c[1] >= m && c[1] <= h - m) inside++
        }
        if (inside < 3) return false
        let area = 0
        for (let i = 0; i < 4; i++) {
            const a = cs[i], b = cs[(i + 1) % 4]
            area += a[0] * b[1] - b[0] * a[1]
        }
        if (Math.abs(area) / 2 < 0.015 * w * h) return false
        // NO obliquity check (v2): opt-r measured it freezing tilt's map
        // entirely (mapPeak 5->0, fused tail arm-median 2.92->9.52 on bad
        // rolls) - tilt's +/-68 deg pitch keeps the poster oblique but
        // CENTERED and large, and stock proves oblique-centered
        // maintenance is safe. The bias class lives at the frame EDGE
        // (containment) and at receding/far views (area), which the two
        // checks above own.
        return true
    }

    _harvestOnlyStep(gray, corners) {
        const t0 = performance.now()
        // harvestKernel: FAST-9 on the frame ALREADY RESIDENT in the LK
        // kernel (uploaded once per frame under lkKernel - zero extra
        // copy). The cv path below runs full ORB.detect (FAST + Harris +
        // pyramid + orientation) for corner POSITIONS only: ~9ms on
        // device vs ~0.5-1ms here. Strongest-first ordering + the same
        // capped count keeps _adaptFast's operating band comparable.
        if (this.cfg.harvestKernel && this.cfg.lkKernel &&
            typeof LkKernel !== 'undefined' && LkKernel.ready) {
            const tri = LkKernel.fast9(this._frameIdx, this._fastThresh, 2048)
            if (tri) {
                const n = tri.length / 3
                const idx = Array.from({ length: n }, (_, i) => i)
                idx.sort((a, b) => tri[b * 3 + 2] - tri[a * 3 + 2])
                // strongest-first + 4px grid dedup: the multi-level pass
                // reports a strong corner once per level it fires at.
                // (Spatially-bucketed round-robin selection was tried for
                // far-cell coverage and only re-rolled the chaotic
                // bootstrap basin - it needs its own paired battery before
                // it can claim the slot; see the round notes.)
                const seen = new Set()
                const outPts = []
                for (const i of idx) {
                    if (outPts.length >= this.cfg.sceneFeatures * 2) break
                    const x = tri[i * 3], y = tri[i * 3 + 1]
                    const key = ((x >> 2) << 12) | (y >> 2)
                    if (seen.has(key)) continue
                    seen.add(key)
                    outPts.push(x, y)
                }
                const keep = Math.min(outPts.length / 2, this.cfg.sceneFeatures)
                // LOW-TEXTURE FALLBACK: on smooth scenes FAST-9 starves
                // where ORB's Harris + octave retention digs out subtle
                // corners (test-slam's synthetic room: map died mid-stretch
                // at 55 -> 0 pts, freezing rot-only 66cm off and poisoning
                // the reloc bank). Below the yield floor, fall through to
                // the ORB path THIS frame - the 9ms cost returns exactly
                // when the map is desperate for quality candidates, which
                // beats starving; texture-rich frames (the common field
                // case, phone-verified) keep the fast path.
                if (keep >= 120) {
                    const pts = new Float32Array(outPts.slice(0, keep * 2))
                    this._adaptFast(keep)
                    this._pendingHarvest = { pts, corners: corners || null }
                    this.debug.harvest_ms = Math.round((performance.now() - t0) * 10) / 10
                    return
                }
                this.debug.harvest_fallback = keep
            }
        }
        this.orb.setMaxFeatures(this.cfg.sceneFeatures)
        this.orb.setFastThreshold(this._fastThresh)
        const kp = new cv.KeyPointVector()
        const mask = new cv.Mat()
        this.orb.detect(gray, kp, mask)
        mask.delete()
        const n = kp.size()
        const pts = new Float32Array(n * 2)
        for (let i = 0; i < n; i++) {
            const p = kp.get(i).pt
            pts[i * 2] = p.x
            pts[i * 2 + 1] = p.y
        }
        kp.delete()
        this._adaptFast(n)
        this._pendingHarvest = { pts, corners: corners || null }
        this.debug.harvest_ms = Math.round((performance.now() - t0) * 10) / 10
    }

    /** Scene-adaptive FAST sensitivity (full-frame passes only). */
    _adaptFast(yieldCount) {
        if (yieldCount < 250 && this._fastThresh > 8) {
            this._fastThresh -= 2          // dim/low-texture: dig deeper
        } else if (yieldCount > 450 && this._fastThresh < 20) {
            this._fastThresh += 2          // rich scene: stay selective
        }
        this.debug.fast_thresh = this._fastThresh
    }

    /** Padded, clamped detection ROI around a known poster quad. null -> use full frame. */
    _roiFromCorners(corners, w, h) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const c of corners) {
            if (c[0] < minX) minX = c[0]
            if (c[0] > maxX) maxX = c[0]
            if (c[1] < minY) minY = c[1]
            if (c[1] > maxY) maxY = c[1]
        }
        const pad = this.cfg.roiPadFrac * Math.max(maxX - minX, maxY - minY)
        const x0 = Math.max(0, Math.floor(minX - pad))
        const y0 = Math.max(0, Math.floor(minY - pad))
        const x1 = Math.min(w, Math.ceil(maxX + pad))
        const y1 = Math.min(h, Math.ceil(maxY + pad))
        const rw = x1 - x0, rh = y1 - y0
        if (rw < 64 || rh < 64) return null
        if (rw * rh > this.cfg.roiMaxFrac * w * h) return null   // barely cheaper than full
        return { x: x0, y: y0, width: rw, height: rh }
    }

    /**
     * Predict the poster's ROI from the CURRENT pose (map tracking). Returns
     * null when the poster is behind the camera or (mostly) outside the
     * frame - the caller then SKIPS the retry, which kills the single
     * biggest waste in MAP_TRACKING: ~100-300ms re-detections of a poster
     * that is not even in view.
     */
    _posterRoiFromPose(w, h) {
        if (!this.curR || !this.Kp) return null
        const hw = this.physW / 2, hh = this.physH / 2
        const cornersW = [[-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0]]
        const proj = []
        for (const X of cornersW) {
            const p = Geometry.project(this.Kp, this.curR, this.curT, X)
            if (p[2] < 0.05) return null          // behind the camera
            proj.push([p[0], p[1]])
        }
        // Require a meaningful overlap between the predicted quad and the frame
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const c of proj) {
            if (c[0] < minX) minX = c[0]
            if (c[0] > maxX) maxX = c[0]
            if (c[1] < minY) minY = c[1]
            if (c[1] > maxY) maxY = c[1]
        }
        const ixw = Math.min(maxX, w) - Math.max(minX, 0)
        const ixh = Math.min(maxY, h) - Math.max(minY, 0)
        if (ixw <= 0 || ixh <= 0) return null
        const visFrac = (ixw * ixh) / Math.max(1, (maxX - minX) * (maxY - minY))
        if (visFrac < 0.25) return null           // mostly offscreen: don't bother
        // Distinguish "offscreen" (null - skip the retry) from "on-screen
        // but too big for an ROI to pay off" ({full}) - a large centered
        // poster is the MOST reacquirable case, not a skippable one.
        return this._roiFromCorners(proj, w, h) || { full: true }
    }

    /** kNN match + Lowe ratio test. Returns [{q, t}] (query/train indices). */
    _match(targetDesc, sceneDesc, ratio) {
        ratio = ratio || 0.8
        // SIMD Hamming kernel when available: bit-identical results,
        // measured 7x faster than the (unvectorized) wasm BFMatcher -
        // matching was 92% of total detection cost.
        if (typeof SimdMatcher !== 'undefined' && SimdMatcher.ready) {
            return SimdMatcher.match(targetDesc, sceneDesc, ratio)
        }
        const out = []
        if (sceneDesc.rows < 2) return out
        const matches = new cv.DMatchVectorVector()
        this.matcher.knnMatch(targetDesc, sceneDesc, matches, 2)
        const n = matches.size()
        for (let i = 0; i < n; i++) {
            const pair = matches.get(i)
            if (pair.size() === 2) {
                const m = pair.get(0), nn = pair.get(1)
                if (m.distance < ratio * nn.distance) {
                    out.push({ q: m.queryIdx, t: m.trainIdx })
                }
            }
            pair.delete()
        }
        matches.delete()
        return out
    }

    /**
     * RANSAC homography fit returning H, inlier indices, mean inlier
     * reprojection error.
     */
    _homographyFit(src, dst, thresh) {
        const n = src.length / 2
        const srcMat = cv.matFromArray(n, 1, cv.CV_32FC2, src)
        const dstMat = cv.matFromArray(n, 1, cv.CV_32FC2, dst)
        const inlierMask = new cv.Mat()
        let H = null
        try {
            // Cap RANSAC iterations: the default (2000) only ever runs to
            // exhaustion on LOW-inlier junk - exactly the candidates that
            // get rejected downstream anyway. A true poster at >=40% inliers
            // converges in < 150 iterations (k = log(1-p)/log(1-w^4));
            // 500 @ 0.995 confidence keeps a 3x margin and halves the
            // worst-case detect frames.
            H = cv.findHomography(srcMat, dstMat, cv.RANSAC, thresh, inlierMask, 500, 0.995)
        } catch (e) {
            H = null
        }
        if (!H || H.empty()) {
            srcMat.delete(); dstMat.delete(); inlierMask.delete()
            if (H) H.delete()
            return null
        }

        const inlierIdx = []
        for (let i = 0; i < n; i++) if (inlierMask.data[i]) inlierIdx.push(i)
        inlierMask.delete()
        if (inlierIdx.length < 4) {
            srcMat.delete(); dstMat.delete(); H.delete()
            return null
        }

        // Mean reprojection error over inliers
        const proj = new cv.Mat()
        cv.perspectiveTransform(srcMat, proj, H)
        let errSum = 0
        for (const i of inlierIdx) {
            const dx = proj.data32F[i * 2] - dst[i * 2]
            const dy = proj.data32F[i * 2 + 1] - dst[i * 2 + 1]
            errSum += Math.sqrt(dx * dx + dy * dy)
        }
        proj.delete(); srcMat.delete(); dstMat.delete()

        return { H, inlierIdx, reproj: errSum / inlierIdx.length }
    }

    _projectCorners(H) {
        const c = cv.matFromArray(4, 1, cv.CV_32FC2,
            [0, 0, this.targetW, 0, this.targetW, this.targetH, 0, this.targetH])
        const out = new cv.Mat()
        cv.perspectiveTransform(c, out, H)
        const corners = [
            [out.data32F[0], out.data32F[1]],
            [out.data32F[2], out.data32F[3]],
            [out.data32F[4], out.data32F[5]],
            [out.data32F[6], out.data32F[7]]
        ]
        c.delete(); out.delete()
        return corners
    }

    /** Strict quad validation (port of processor._validate_quad). */
    _validateQuad(corners, scale) {
        // Shoelace area
        let area = 0
        for (let i = 0; i < 4; i++) {
            const [x1, y1] = corners[i]
            const [x2, y2] = corners[(i + 1) % 4]
            area += x1 * y2 - x2 * y1
        }
        area = Math.abs(area) / 2
        if (area < Math.max(500, 1500 * scale)) return false

        // Convexity: all cross products must share a sign
        let sign = 0
        for (let i = 0; i < 4; i++) {
            const a = corners[i], b = corners[(i + 1) % 4], c = corners[(i + 2) % 4]
            const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
            const s = Math.sign(cross)
            if (s === 0) return false
            if (sign === 0) sign = s
            else if (s !== sign) return false
        }

        // Edge lengths + aspect
        const edges = []
        for (let i = 0; i < 4; i++) {
            const a = corners[i], b = corners[(i + 1) % 4]
            edges.push(Math.hypot(b[0] - a[0], b[1] - a[1]))
        }
        const minEdge = Math.min(...edges), maxEdge = Math.max(...edges)
        if (minEdge < Math.max(20, 30 * scale)) return false
        if (maxEdge / minEdge > 6) return false

        // Interior angles ~17Â°..160Â°
        for (let i = 0; i < 4; i++) {
            const p = corners[i]
            const pn = corners[(i + 1) % 4]
            const pp = corners[(i + 3) % 4]
            const v1 = [pn[0] - p[0], pn[1] - p[1]]
            const v2 = [pp[0] - p[0], pp[1] - p[1]]
            const dot = v1[0] * v2[0] + v1[1] * v2[1]
            const den = Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) + 1e-6
            const ang = Math.acos(Math.max(-1, Math.min(1, dot / den)))
            if (ang < 0.3 || ang > 2.8) return false
        }
        return true
    }

    // ================= KLT tracking =================

    /**
     * Forward + backward pyramidal LK with FB-consistency over a flat 2N
     * point array. ONE call per frame: poster, map and candidate points all
     * ride the same pyramids (a second LK call would rebuild them).
     * @returns {next: Float32Array(2N), ok: Uint8Array(N)}
     */
    _lkAll(gray, flat, viaKernel) {
        const n = flat.length / 2
        const prevPts = cv.matFromArray(n, 1, cv.CV_32FC2, flat)
        let nextPts = new cv.Mat()
        const status = new cv.Mat()
        const err = new cv.Mat()
        // LK window + pyramid depth are RELATIVE quantities: 21px at 480-wide
        // covers 1.5x less of the image at 720 (Pixel 6a: map points died en
        // masse at 720px). Scale the window and add a pyramid level so the
        // same physical patch and the same physical max-displacement hold at
        // every processing resolution.
        const rsLK = this._resScale || 1
        const wpx = Math.round(21 * rsLK) | 1   // odd
        const winSize = new cv.Size(wpx, wpx)
        const lkLevels = rsLK > 1.2 ? 4 : 3
        const criteria = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 30, 0.01)

        // Predicted seed: start the search where last frame's median flow
        // (stretched by the frame-interval ratio) puts the points. Seeds
        // must be fresh (<=2 frames old: a LOST gap invalidates the flow)
        // and meaningful (>=1.5px: below that the zero seed is equivalent).
        let seeded = false
        const fl = this.cfg.lkPredictSeed ? this._lastFlow : null
        if (fl && this._lkSeedOk !== false && this._frameIdx - fl.f <= 2) {
            const fx = fl.dx * this._dtRatio, fy = fl.dy * this._dtRatio
            const mag = Math.hypot(fx, fy)
            if (mag >= 1.5 && mag <= 0.4 * Math.max(gray.cols, gray.rows)) {
                let guess
                if (this.cfg.perfV1) {
                    if (!this._seedBuf || this._seedBuf.length < n * 2) {
                        this._seedBuf = new Float32Array(Math.ceil(n * 3))
                    }
                    guess = this._seedBuf.subarray(0, n * 2)
                } else {
                    guess = new Float32Array(n * 2)
                }
                for (let i = 0; i < n; i++) {
                    guess[i * 2] = Math.min(gray.cols - 2, Math.max(1, flat[i * 2] + fx))
                    guess[i * 2 + 1] = Math.min(gray.rows - 2, Math.max(1, flat[i * 2 + 1] + fy))
                }
                nextPts.delete()
                nextPts = cv.matFromArray(n, 1, cv.CV_32FC2, guess)
                seeded = true
            }
        }

        const FLAGS = (typeof cv.OPTFLOW_USE_INITIAL_FLOW === 'number') ? cv.OPTFLOW_USE_INITIAL_FLOW : 4
        if (this.cfg.lkPredictSeed) {
            // trace surface: 1 seeded, 0 no seed this frame, -1 wasm lacks the overload
            this.debug.lk_seed = seeded ? 1 : (this._lkSeedOk === false ? -1 : 0)
        }

        // lkKernel: the custom SIMD KLT (lk-kernel.js). Engaged ONLY on the
        // per-frame hot path (viaKernel: _trackStep/_lkEnvOnly) where the
        // image pair is guaranteed to be (frame-1 -> frame) and resident in
        // the kernel's slots; absorb ring-hops and fbCheck keep the cv
        // path. Wrapper returns null when the pair is not resident (e.g.
        // the frame after a SEARCHING gap) - cv covers that frame.
        if (viaKernel && this.cfg.lkKernel && !this.cfg.fbCheck &&
            typeof LkKernel !== 'undefined' && LkKernel.ready) {
            const kr = LkKernel.track(
                this._frameIdx - 1, this._frameIdx, flat,
                seeded ? nextPts.data32F : null, wpx, lkLevels, 30)
            // lkKernelDiff (diagnostic): run BOTH and report deltas.
            //   'cv'  (or true): cv results drive the system
            //   'kern': kernel results drive the system (cv is reference)
            if (kr && this.cfg.lkKernelDiff) {
                this._lkDiffPending = {
                    next: kr.next.slice(0, n * 2), ok: kr.ok.slice(0, n),
                    err: kr.err.slice(0, n),
                    useKern: this.cfg.lkKernelDiff === 'kern'
                }
            } else if (kr) {
                prevPts.delete(); nextPts.delete(); status.delete(); err.delete()
                let ok, next
                if (this.cfg.perfV1) {
                    if (!this._lkNextBuf || this._lkNextBuf.length < n * 2) {
                        this._lkNextBuf = new Float32Array(Math.ceil(n * 3))
                        this._lkOkBuf = new Uint8Array(Math.ceil(n * 1.5))
                    }
                    next = this._lkNextBuf.subarray(0, n * 2)
                    ok = this._lkOkBuf.subarray(0, n)
                    ok.fill(0)
                } else {
                    ok = new Uint8Array(n)
                    next = new Float32Array(n * 2)
                }
                const errMax = 28 * (this._resScale || 1)
                for (let i = 0; i < n; i++) {
                    next[i * 2] = kr.next[i * 2]
                    next[i * 2 + 1] = kr.next[i * 2 + 1]
                    if (!kr.ok[i]) continue
                    if (kr.err[i] > errMax) continue
                    ok[i] = 1
                }
                if (this.cfg.lkPredictSeed) {
                    const dxs = [], dys = []
                    for (let i = 0; i < n; i++) {
                        if (!ok[i]) continue
                        dxs.push(next[i * 2] - flat[i * 2])
                        dys.push(next[i * 2 + 1] - flat[i * 2 + 1])
                    }
                    if (dxs.length >= 8) {
                        dxs.sort((a, b) => a - b); dys.sort((a, b) => a - b)
                        this._lastFlow = { dx: dxs[dxs.length >> 1], dy: dys[dys.length >> 1],
                                           n: dxs.length, f: this._frameIdx }
                    } else this._lastFlow = null
                }
                this.debug.lk_kern = 1
                return { next, ok }
            }
        }

        // lkFast (a): carry-over pyramids - this frame's pyramid is next
        // frame's "previous", so each image is pyramidized exactly once.
        // Fresh MatVectors each frame (ownership is explicit; the contained
        // Mats are freed on delete); a frame-index tag invalidates the
        // carry-over whenever a frame passed without an LK run.
        let srcA = this.prevGray, srcB = gray
        let pyrNew = null, pyrTmp = null
        if (this.cfg.lkFast && this._pyrOk !== false) {
            try {
                pyrNew = new cv.MatVector()
                cv.buildOpticalFlowPyramid(gray, pyrNew, winSize, lkLevels)
                if (this._pyrA && this._pyrAFrame === this._frameIdx - 1 &&
                    this._pyrWin === wpx) {
                    srcA = this._pyrA
                } else {
                    pyrTmp = new cv.MatVector()
                    cv.buildOpticalFlowPyramid(this.prevGray, pyrTmp, winSize, lkLevels)
                    srcA = pyrTmp
                }
                srcB = pyrNew
                this._pyrOk = true
            } catch (e) {
                this._pyrOk = false
                if (pyrNew) { pyrNew.delete(); pyrNew = null }
                if (pyrTmp) { pyrTmp.delete(); pyrTmp = null }
                srcA = this.prevGray; srcB = gray
            }
        }
        // lkFast (b): a seeded pass starts within a few px of the answer -
        // one level less covers the residual at lower per-point cost.
        // Separately flagged: the cut is the only numerics-changing part of
        // lkFast (the pyramid carry is bit-identical), and it nudged two
        // deterministic test-slam bars over their margins.
        const levelsUse = (this.cfg.lkFastLevels && seeded)
            ? Math.max(2, lkLevels - 1) : lkLevels

        if (seeded) {
            try {
                cv.calcOpticalFlowPyrLK(srcA, srcB, prevPts, nextPts, status, err, winSize, levelsUse, criteria, FLAGS)
                this._lkSeedOk = true
            } catch (e) {
                // WASM build without the flags overload: disable seeding for good
                this._lkSeedOk = false
                seeded = false
                nextPts.delete(); nextPts = new cv.Mat()
                cv.calcOpticalFlowPyrLK(srcA, srcB, prevPts, nextPts, status, err, winSize, lkLevels, criteria)
            }
        } else {
            cv.calcOpticalFlowPyrLK(srcA, srcB, prevPts, nextPts, status, err, winSize, lkLevels, criteria)
        }

        let ok, next
        if (this.cfg.perfV1) {
            // pooled outputs: consumers only use these within the frame
            if (!this._lkNextBuf || this._lkNextBuf.length < n * 2) {
                this._lkNextBuf = new Float32Array(Math.ceil(n * 3))
                this._lkOkBuf = new Uint8Array(Math.ceil(n * 1.5))
            }
            next = this._lkNextBuf.subarray(0, n * 2)
            ok = this._lkOkBuf.subarray(0, n)
            ok.fill(0)
        } else {
            ok = new Uint8Array(n)
            next = new Float32Array(n * 2)
        }

        if (this.cfg.fbCheck) {
            // Classic forward-backward consistency: a second full LK pass
            // (doubles LK cost - 4 pyramid builds per frame).
            let backPts = new cv.Mat()
            const backStatus = new cv.Mat()
            const backErr = new cv.Mat()
            if (seeded && this._lkSeedOk) {
                // natural backward seed: the points came FROM their original positions
                backPts.delete()
                backPts = cv.matFromArray(n, 1, cv.CV_32FC2, flat)
                cv.calcOpticalFlowPyrLK(srcB, srcA, nextPts, backPts, backStatus, backErr, winSize, lkLevels, criteria, FLAGS)
            } else {
                cv.calcOpticalFlowPyrLK(srcB, srcA, nextPts, backPts, backStatus, backErr, winSize, lkLevels, criteria)
            }
            const fbMax = this.cfg.fbErrorThresh
            for (let i = 0; i < n; i++) {
                next[i * 2] = nextPts.data32F[i * 2]
                next[i * 2 + 1] = nextPts.data32F[i * 2 + 1]
                if (!status.data[i] || !backStatus.data[i]) continue
                const fbx = backPts.data32F[i * 2] - flat[i * 2]
                const fby = backPts.data32F[i * 2 + 1] - flat[i * 2 + 1]
                if (fbx * fbx + fby * fby > fbMax * fbMax) continue
                ok[i] = 1
            }
            backPts.delete(); backStatus.delete(); backErr.delete()
        } else {
            // GEOMETRIC validation instead: this architecture re-validates
            // every tracked point each frame against fixed references -
            // poster points by RANSAC against ANCHORED target coords
            // (coherent drift breaks reprojection there), map points by GN
            // residuals against 3D structure plus poster-truth culling. The
            // backward pass duplicates those guarantees; LK 'err' (patch
            // SSD) plus the geometric gates carries the same protection at
            // half the LK cost. Verified equivalent on the ground-truth
            // harness before enabling.
            const errMax = 28 * (this._resScale || 1)  // LK patch residual gate (per-pixel avg SSD)
            for (let i = 0; i < n; i++) {
                next[i * 2] = nextPts.data32F[i * 2]
                next[i * 2 + 1] = nextPts.data32F[i * 2 + 1]
                if (!status.data[i]) continue
                if (err.data32F[i] > errMax) continue
                ok[i] = 1
            }
        }

        // lkKernelDiff: cv just produced truth on the same inputs - report
        // where the kernel deviates (median/max px over both-ok points)
        if (this._lkDiffPending) {
            const kd = this._lkDiffPending
            this._lkDiffPending = null
            const ds = []
            const errMaxD = 28 * (this._resScale || 1)
            let okCv = 0, okK = 0, setDis = 0
            for (let i = 0; i < n; i++) {
                const keff = (kd.ok[i] && kd.err[i] <= errMaxD) ? 1 : 0
                if (ok[i]) okCv++
                if (keff) okK++
                if (ok[i] !== keff) setDis++
                if (ok[i] && keff) {
                    ds.push(Math.hypot(kd.next[i * 2] - next[i * 2],
                                       kd.next[i * 2 + 1] - next[i * 2 + 1]))
                }
            }
            ds.sort((a, b) => a - b)
            this.debug.lk_diff = 'n' + n + ' cv' + okCv + ' k' + okK + ' dis' + setDis +
                (ds.length ? ' d' + ds[ds.length >> 1].toFixed(2) +
                    '/' + ds[Math.floor(ds.length * 0.9)].toFixed(2) +
                    '/' + ds[ds.length - 1].toFixed(2) : '')
            if (kd.useKern) {
                // kernel results drive the system this run
                const errMaxK = 28 * (this._resScale || 1)
                ok.fill(0)
                for (let i = 0; i < n; i++) {
                    next[i * 2] = kd.next[i * 2]
                    next[i * 2 + 1] = kd.next[i * 2 + 1]
                    if (kd.ok[i] && kd.err[i] <= errMaxK) ok[i] = 1
                }
            }
        }

        prevPts.delete(); nextPts.delete(); status.delete(); err.delete()

        // lkFast (a): carry this frame's pyramid over, release the rest
        if (pyrNew) {
            if (this._pyrA) this._pyrA.delete()
            if (pyrTmp) pyrTmp.delete()
            this._pyrA = pyrNew
            this._pyrAFrame = this._frameIdx
            this._pyrWin = wpx
        }

        // Median flow of the survivors -> next frame's seed. Median (not
        // mean): outlier tracks and independently moving objects must not
        // steer the seed.
        if (this.cfg.lkPredictSeed) {
            const dxs = [], dys = []
            for (let i = 0; i < n; i++) {
                if (!ok[i]) continue
                dxs.push(next[i * 2] - flat[i * 2])
                dys.push(next[i * 2 + 1] - flat[i * 2 + 1])
            }
            if (dxs.length >= 8) {
                dxs.sort((a, b) => a - b); dys.sort((a, b) => a - b)
                this._lastFlow = { dx: dxs[dxs.length >> 1], dy: dys[dys.length >> 1],
                                   n: dxs.length, f: this._frameIdx }
            } else this._lastFlow = null
        }

        return { next, ok }
    }

    /** Track only the environment points (poster set empty / failed). */
    _lkEnvOnly(gray) {
        const env = this.env.trackXY()
        const n = env.nPoints + env.nCandidates
        if (!n) return
        const _tLk = performance.now()
        const lk = this._lkAll(gray, env.flat, true)
        this.debug.t_lk = (this.debug.t_lk || 0) + performance.now() - _tLk
        // keep this frame's flows: the rotation-only fallback reads them
        // (env.flat holds the PRE-track positions; applyTrack mutates the
        // point objects, not this array)
        this._envFlows = { prev: env.flat, next: lk.next, ok: lk.ok, n }
        this._allFlows = this._envFlows
        const dr = this.env.applyTrack(lk.next, lk.ok, env.nPoints, env.nCandidates)
        if (dr) this.debug.m_lk += dr.dropP
        this._envTrackedThisFrame = true
    }

    _trackStep(gray) {
        this.debug.mode = 'track'
        const nPoster = this.trackScene.length / 2
        if (nPoster < this.cfg.minTrackPoints) {
            // poster set too thin to bother, but the map must keep tracking
            if (this.env && this.env.size() + this.env.candidateCount() > 0) this._lkEnvOnly(gray)
            return null
        }

        // Unified LK: [poster | map points | candidates]
        let flat = this.trackScene
        let envInfo = null
        if (this.env) {
            envInfo = this.env.trackXY()
            const nEnv = envInfo.nPoints + envInfo.nCandidates
            if (nEnv > 0) {
                const need = (nPoster + nEnv) * 2
                if (this.cfg.perfV1) {
                    if (!this._mergeBuf || this._mergeBuf.length < need) {
                        this._mergeBuf = new Float32Array(Math.ceil(need * 1.5))
                    }
                    flat = this._mergeBuf.subarray(0, need)
                } else {
                    flat = new Float32Array(need)
                }
                flat.set(this.trackScene, 0)
                flat.set(envInfo.flat, nPoster * 2)
            }
        }

        const _tLk = performance.now()
        const lk = this._lkAll(gray, flat, true)
        this.debug.t_lk = (this.debug.t_lk || 0) + performance.now() - _tLk

        // ALL flows (poster + env): raw LK measurements are valid rotation
        // evidence regardless of what RANSAC/PnP later think of the poster
        // chain - and at the poster->rot-only handoff they are usually the
        // ONLY flows alive (the candidate bank builds 4+ frames later).
        this._allFlows = { prev: flat, next: lk.next, ok: lk.ok, n: flat.length / 2 }

        if (envInfo && (envInfo.nPoints + envInfo.nCandidates) > 0) {
            const nEnv = envInfo.nPoints + envInfo.nCandidates
            this._envFlows = {
                prev: flat.subarray(nPoster * 2),
                next: lk.next.subarray(nPoster * 2),
                ok: lk.ok.subarray(nPoster),
                n: nEnv
            }
            const dr = this.env.applyTrack(
                this._envFlows.next, this._envFlows.ok,
                envInfo.nPoints, envInfo.nCandidates)
            if (dr) this.debug.m_lk += dr.dropP
            this._envTrackedThisFrame = true
        }

        const keptTarget = [], keptScene = []
        for (let i = 0; i < nPoster; i++) {
            if (!lk.ok[i]) continue
            keptTarget.push(this.trackTarget[i * 2], this.trackTarget[i * 2 + 1])
            keptScene.push(lk.next[i * 2], lk.next[i * 2 + 1])
        }

        if (keptTarget.length / 2 < this.cfg.minTrackPoints) {
            this._fitFailStreak++
            return null
        }

        // Homography from ANCHORED target coords -> current scene (no drift integration)
        const src = new Float32Array(keptTarget)
        const dst = new Float32Array(keptScene)
        // precisionV2: snap the LK chain back onto true corners BEFORE the
        // fit - refined points feed RANSAC/PnP and become next frame's
        // chain, so the random-walk drift is arrested every frame.
        // (An inliers-only variant was tried under perfV1: proc was flat
        // in-harness and the numeric delta re-rolled canonical-suite seeds
        // - reverted.)
        const _tSp = performance.now()
        if (this.cfg.precisionV2) this._subpixRefine(gray, dst)
        const _tFit = performance.now()
        this.debug.t_sp = (this.debug.t_sp || 0) + _tFit - _tSp
        const fit = this._homographyFit(src, dst, this.cfg.trackRansacThresh * (this._resScale || 1))
        this.debug.t_fit = (this.debug.t_fit || 0) + performance.now() - _tFit
        if (!fit) { this._fitFailStreak++; return null }

        const corners = this._projectCorners(fit.H)
        if (!this._validateQuad(corners, this.lastScale)) {
            fit.H.delete()
            this._fitFailStreak++
            return null
        }
        fit.H.delete()

        // Keep only RANSAC inliers as the live tracking set
        const nIn = fit.inlierIdx.length
        const tKeep = new Float32Array(nIn * 2)
        const sKeep = new Float32Array(nIn * 2)
        for (let j = 0; j < nIn; j++) {
            const i = fit.inlierIdx[j]
            tKeep[j * 2] = src[i * 2]; tKeep[j * 2 + 1] = src[i * 2 + 1]
            sKeep[j * 2] = dst[i * 2]; sKeep[j * 2 + 1] = dst[i * 2 + 1]
        }

        // chainGuard: this fit succeeded right after >=1 failed frame - a
        // RESURRECTION. Geometry cannot tell a recovered poster from the
        // stale layout re-cohered on whatever texture now sits under it
        // (both are planes); demand appearance proof against the templates
        // sampled at the last strong fit. Reject -> drop the chain and let
        // the descriptor-verified detect/reloc paths own the recovery.
        if (this.cfg.chainGuard && this._fitFailStreak > 0 && this._chainPatches) {
            const ncc = this._chainNcc(gray, tKeep, sKeep)
            if (ncc !== null) this.debug.chain_ncc = Math.round(ncc * 100) / 100
            if (ncc !== null && ncc < this.cfg.chainGuardNcc) {
                this.debug.chain_kill = 1
                this._dropTracking()
                return null
            }
        }
        this._fitFailStreak = 0

        this.trackTarget = tKeep
        this.trackScene = sKeep
        this.framesSinceRefresh++

        // Refresh the appearance templates while the fit is STRONG (a weak
        // fit may already be partially off-poster; strong = trustworthy
        // pixels). Cost: 8 small patch copies, only on strong frames.
        if (this.cfg.chainGuard && nIn >= 30) this._samplePatches(gray, tKeep, sKeep)

        this.debug.inliers = nIn
        this.debug.track_points = nIn
        this.debug.scale_used = this.lastScale

        return {
            targetPts: tKeep,
            scenePts: sKeep,
            nInliers: nIn,
            corners,
            trackPoints: nIn
        }
    }

    _dropTracking() {
        this.trackTarget = null
        this.trackScene = null
        this._chainPatches = null
        this._fitFailStreak = 0
    }

    /**
     * chainGuard: sample small zero-mean gray templates at up to 8 spread
     * chain points. Flat patches carry no identity and are skipped; the set
     * is only adopted when at least 4 usable templates exist.
     */
    _samplePatches(gray, tgt, scn) {
        const n = tgt.length / 2
        const C = 8, R = 6
        const step = Math.max(1, Math.floor(n / C))
        const data = gray.data, W = gray.cols, H = gray.rows
        const out = []
        for (let j = 0; j < n && out.length < C; j += step) {
            const x = Math.round(scn[j * 2]), y = Math.round(scn[j * 2 + 1])
            if (x < R || y < R || x >= W - R || y >= H - R) continue
            const patch = new Float32Array((2 * R + 1) * (2 * R + 1))
            let s = 0, p = 0
            for (let dy = -R; dy <= R; dy++) {
                const row = (y + dy) * W + x
                for (let dx = -R; dx <= R; dx++) { const v = data[row + dx]; patch[p++] = v; s += v }
            }
            const mean = s / patch.length
            let sq = 0
            for (let k = 0; k < patch.length; k++) { patch[k] -= mean; sq += patch[k] * patch[k] }
            const sd = Math.sqrt(sq / patch.length)
            if (sd < 4) continue
            for (let k = 0; k < patch.length; k++) patch[k] /= sd
            out.push({ tx: tgt[j * 2], ty: tgt[j * 2 + 1], patch })
        }
        if (out.length >= 4) this._chainPatches = out
    }

    /**
     * chainGuard: median NCC of the stored templates against the current
     * gray at the resurrected chain's positions. Template points are looked
     * up by TARGET coordinate (anchored coords ride the kept-arrays
     * verbatim, so identity is exact float equality). Returns null when
     * fewer than 3 templates land in the surviving set (cannot judge).
     */
    _chainNcc(gray, tgt, scn) {
        const tpl = this._chainPatches
        const n = tgt.length / 2
        const R = 6, L = (2 * R + 1) * (2 * R + 1)
        const data = gray.data, W = gray.cols, H = gray.rows
        const scores = []
        for (const t of tpl) {
            let sx = -1, sy = -1
            for (let j = 0; j < n; j++) {
                if (tgt[j * 2] === t.tx && tgt[j * 2 + 1] === t.ty) {
                    sx = Math.round(scn[j * 2]); sy = Math.round(scn[j * 2 + 1])
                    break
                }
            }
            if (sx < R || sy < R || sx >= W - R || sy >= H - R) continue
            let s = 0, p = 0
            const cur = this._nccBuf || (this._nccBuf = new Float32Array(L))
            for (let dy = -R; dy <= R; dy++) {
                const row = (sy + dy) * W + sx
                for (let dx = -R; dx <= R; dx++) { const v = data[row + dx]; cur[p++] = v; s += v }
            }
            const mean = s / L
            let sq = 0, dot = 0
            for (let k = 0; k < L; k++) { const d = cur[k] - mean; sq += d * d }
            const sd = Math.sqrt(sq / L)
            if (sd < 2) { scores.push(0); continue }   // flat now: identity gone
            for (let k = 0; k < L; k++) dot += t.patch[k] * ((cur[k] - mean) / sd)
            scores.push(dot / L)
        }
        if (scores.length < 3) return null
        scores.sort((a, b) => a - b)
        return scores[scores.length >> 1]
    }

    /**
     * The pure-rotation interpretation of this frame's surviving env flows,
     * computed at most ONCE per frame (both the fallback pose and the
     * rot-consistency guard read it).
     *
     * Translation must not masquerade as rotation: a translating camera
     * produces depth-DEPENDENT parallax that a global rotation cannot fit -
     * it betrays itself through the inlier fraction and mean residual;
     * `clean` encodes both gates. A distant/planar scene under slow
     * translation is the known blind spot (fundamental ambiguity); freezing
     * the center there is still visually correct to first order.
     */
    _flowRotation() {
        if (this._flowRotFrame === this._frameIdx) return this._flowRot
        this._flowRotFrame = this._frameIdx
        this._flowRot = null
        const f = this._allFlows
        if (!f || !this.Kp) return null

        const prev = [], cur = []
        for (let i = 0; i < f.n; i++) {
            if (!f.ok[i]) continue
            prev.push(f.prev[i * 2], f.prev[i * 2 + 1])
            cur.push(f.next[i * 2], f.next[i * 2 + 1])
        }
        const m = prev.length / 2
        if (m < this.cfg.rotOnlyMinPts) return null

        const rs = this._resScale || 1
        const r = Geometry.rotationOnlyGN(this.Kp, prev, cur, {
            huberPx: 2.0 * rs,
            outlierPx: 4.0 * rs,
            minInliers: this.cfg.rotOnlyMinPts
        })
        if (!r.ok) return null
        // Discontinuity signal: LK survival fraction. Measured on the ENV
        // flows when there are enough of them - at the poster->rot-only
        // handoff the POSTER flows die legitimately (oblique exit) and must
        // not read as a discontinuity; a real viewpoint jump kills the env
        // set too (teleport: 25% survived).
        let surv = m / f.n
        const fe = this._envFlows
        if (fe && fe !== f && fe.n >= 8) {
            let okE = 0
            for (let i = 0; i < fe.n; i++) if (fe.ok[i]) okE++
            surv = okE / fe.n
        }
        this._flowRot = {
            dR: r.R, nIn: r.nInliers, m, meanErr: r.meanErr,
            clean: r.nInliers >= m * 0.5 &&
                   r.meanErr <= this.cfg.rotOnlyMaxErr * rs &&
                   surv >= this.cfg.rotOnlySurvival
        }
        return this._flowRot
    }

    /**
     * Rotation-only pose: compose the flow-measured dR onto a base pose,
     * keeping the camera center exactly fixed (R' = dR R, t' = dR t).
     * Base defaults to the current prior; the rot-consistency guard passes
     * the PRE-solve prior explicitly (the poster solve already overwrote
     * this.curR by the time it runs).
     */
    _rotOnlyStep(baseR, baseT) {
        const fr = this._flowRotation()
        if (!fr || !fr.clean) return null
        const R0 = baseR || this.curR
        const t0 = baseT || this.curT
        const R = Geometry.matMul3(fr.dR, R0)
        const t = Geometry.matVec3(fr.dR, t0)

        // ENGAGEMENT: rebase all candidate anchors onto the freeze pose -
        // their pre-freeze anchors carry the slide's phantom baseline, which
        // false-fired the translation detector on a genuinely parked tilt.
        if (!this._wasRotOnly && this.env) this.env.rebaseCandidates(R, t)

        // TRANSLATION DETECTOR: a static point seen from an UNMOVED center
        // keeps its ray direction under any rotation; real translation
        // grows the anchor-ray angle with baseline/depth. Median across the
        // freeze-anchored candidates above the gate means the camera is
        // really moving - the frozen-center model is wrong; exit to honest
        // LOST instead of sliding (the planar-scene flow ambiguity is
        // invisible to the residual gates, but not to this).
        if (this._wasRotOnly && this.env) {
            const angs = []
            for (const cd of this.env.candidates) {
                if (!cd.rotAnchor || !cd.R0 || cd.age < 2) continue
                angs.push(Geometry.rayAngleDeg(this.Kp, cd.R0, cd.u0, cd.v0, R, cd.u, cd.v))
                if (angs.length >= 20) break
            }
            if (angs.length >= 5) {
                angs.sort((a, b) => a - b)
                if (angs[angs.length >> 1] > this.cfg.rotOnlyDriftDeg) return null
            }
        }

        return {
            R, t,
            nInliers: fr.nIn, meanErr: fr.meanErr,
            inliers: null, rotOnly: true
        }
    }

    /**
     * Custom sub-pixel corner refinement (Forstner/cornerSubPix-style):
     * for each point, iteratively solve the 2x2 gradient-normal system
     * over an 11x11 window so q satisfies sum(gradI gradI^T)(p_i - q) = 0.
     * Runs directly on the gray Mat's bytes; ~<1ms for 100 points.
     * Refines IN PLACE; skips weak-texture patches (min-eigenvalue gate)
     * and rejects jumps > 1.5px (never snap onto a DIFFERENT corner).
     */
    _subpixRefine(gray, pts, clampPx) {
        const W = gray.cols, H = gray.rows, data = gray.data
        const win = 5, maxIter = 4
        const clamp = clampPx || this.cfg.subpixClamp
        const n = pts.length / 2
        for (let k = 0; k < n; k++) {
            let x = pts[k * 2], y = pts[k * 2 + 1]
            const x0 = x, y0 = y
            for (let it = 0; it < maxIter; it++) {
                const cx = Math.round(x), cy = Math.round(y)
                if (cx < win + 1 || cy < win + 1 || cx >= W - win - 1 || cy >= H - win - 1) break
                let a = 0, b = 0, c = 0, bx = 0, by = 0
                for (let dy = -win; dy <= win; dy++) {
                    const row = (cy + dy) * W + cx
                    for (let dx = -win; dx <= win; dx++) {
                        const i = row + dx
                        const ix = (data[i + 1] - data[i - 1]) * 0.5
                        const iy = (data[i + W] - data[i - W]) * 0.5
                        a += ix * ix; b += ix * iy; c += iy * iy
                        bx += ix * ix * (cx + dx) + ix * iy * (cy + dy)
                        by += ix * iy * (cx + dx) + iy * iy * (cy + dy)
                    }
                }
                const det = a * c - b * b
                if (det < 1e-3) break
                const tr = a + c
                const minEig = (tr - Math.sqrt(Math.max(0, tr * tr - 4 * det))) / 2
                if (minEig < this.cfg.subpixMinEig) break   // weak structure: keep LK's answer
                const nx = (c * bx - b * by) / det
                const ny = (a * by - b * bx) / det
                const mvx = nx - x, mvy = ny - y
                x = nx; y = ny
                if (mvx * mvx + mvy * mvy < 0.001) break
            }
            const jx = x - x0, jy = y - y0
            if (jx * jx + jy * jy <= clamp * clamp) { pts[k * 2] = x; pts[k * 2 + 1] = y }
        }
    }

    // ================= Pose (PnP + coordinate conversion) =================

    /**
     * Solve 6DoF pose from anchored target<->scene correspondences.
     * Port of pose_solver.py (IPPE acquisition, ITERATIVE+prior tracking,
     * OpenCV -> Three.js conversion).
     */
    _solvePose(targetPts, scenePts, nInliers) {
        const n = targetPts.length / 2
        if (n < 4) return null

        // Map target px -> 3D plane meters (port of _map_2d_to_3d)
        const obj = new Float64Array(n * 3)
        for (let i = 0; i < n; i++) {
            obj[i * 3] = (targetPts[i * 2] / this.targetW - 0.5) * this.physW
            obj[i * 3 + 1] = (targetPts[i * 2 + 1] / this.targetH - 0.5) * this.physH
            obj[i * 3 + 2] = 0
        }

        const objMat = cv.matFromArray(n, 3, cv.CV_64F, obj)
        const imgArr = new Float64Array(n * 2)
        for (let i = 0; i < n * 2; i++) imgArr[i] = scenePts[i]
        const imgMat = cv.matFromArray(n, 2, cv.CV_64F, imgArr)

        let ok = false
        try {
            if (this.hasPrior) {
                // Tracking: refine from prior (fast, stable)
                ok = cv.solvePnP(objMat, imgMat, this.K, this.dist,
                    this.rvec, this.tvec, true, cv.SOLVEPNP_ITERATIVE)
            } else {
                // Acquisition: IPPE is purpose-built for planar targets
                let flags = this.ippeOk ? cv.SOLVEPNP_IPPE : cv.SOLVEPNP_ITERATIVE
                try {
                    ok = cv.solvePnP(objMat, imgMat, this.K, this.dist,
                        this.rvec, this.tvec, false, flags)
                } catch (e) {
                    this.ippeOk = false
                    ok = cv.solvePnP(objMat, imgMat, this.K, this.dist,
                        this.rvec, this.tvec, false, cv.SOLVEPNP_ITERATIVE)
                }
            }
        } catch (e) {
            ok = false
        }

        if (!ok) {
            objMat.delete(); imgMat.delete()
            this.hasPrior = false
            return null
        }

        // Reprojection error check
        const proj = new cv.Mat()
        cv.projectPoints(objMat, this.rvec, this.tvec, this.K, this.dist, proj)
        let errSum = 0
        for (let i = 0; i < n; i++) {
            const dx = proj.data64F[i * 2] - imgArr[i * 2]
            const dy = proj.data64F[i * 2 + 1] - imgArr[i * 2 + 1]
            errSum += Math.sqrt(dx * dx + dy * dy)
        }
        const reproj = errSum / n
        proj.delete(); objMat.delete(); imgMat.delete()

        if (reproj > this.cfg.maxReprojError * (this._resScale || 1) * (this.hasPrior ? 1.5 : 1.0)) {
            this.hasPrior = false
            return null
        }
        this.hasPrior = true

        // Mirror T_cw as plain arrays for the geometry/map modules
        const Rm = new cv.Mat()
        cv.Rodrigues(this.rvec, Rm)
        const rd = Rm.data64F
        this.curR = [rd[0], rd[1], rd[2], rd[3], rd[4], rd[5], rd[6], rd[7], rd[8]]
        Rm.delete()
        this.curT = [this.tvec.data64F[0], this.tvec.data64F[1], this.tvec.data64F[2]]

        return this._poseFromRt(this.curR, this.curT, nInliers, n, reproj)
    }

    /**
     * relocV2: re-capture the descriptors of IN-VIEW dormant points from
     * the scene features a detect just computed (reads _pendingHarvest
     * before consumption - zero extra ORB cost). Dormant descs age badly:
     * exposure drift + per-capture noise decorrelate ORB bits within ~100
     * frames (measured: 26-entry bank produced 0-1 ratio matches at the
     * teleport despite 18 strong frames staring at the SAME wall moments
     * earlier). A refreshed desc turns post-loss reloc from a cross-epoch
     * match into a few-frame match. Double gate (desc distance AND
     * projected-position radius) keeps repetitive texture from rebinding a
     * point to the wrong corner.
     */
    _refreshDormantDescs(w, h) {
        if (!this.cfg.relocV2 || !this.env || !this.env.dormant.length) return
        const ph = this._pendingHarvest
        if (!ph || !ph.desc || !ph.pts || !this.curR || !this.hasPrior || !this.Kp) return
        if (typeof SimdMatcher === 'undefined' || !SimdMatcher.ready) return
        const R = this.curR, T = this.curT, K = this.Kp
        const cand = []
        for (const d of this.env.dormant) {
            const X = d.X
            const zc = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + T[2]
            if (zc < 0.05) continue
            const u = K.fx * ((R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + T[0]) / zc) + K.cx
            const v = K.fy * ((R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + T[1]) / zc) + K.cy
            if (u < 0 || v < 0 || u >= w || v >= h) continue
            cand.push({ d, u, v })
        }
        if (!cand.length) return
        const q = new Uint8Array(cand.length * 32)
        for (let i = 0; i < cand.length; i++) q.set(cand[i].d.desc, i * 32)
        const matches = SimdMatcher.match(
            { rows: cand.length, data: q },
            { rows: ph.desc.length / 32, data: ph.desc },
            0.85, this.cfg.relocAbsHamming)
        const rad = 14 * (this._resScale || 1)
        let refreshed = 0
        for (const m of matches) {
            const c = cand[m.q]
            const su = ph.pts[m.t * 2], sv = ph.pts[m.t * 2 + 1]
            if (Math.hypot(su - c.u, sv - c.v) > rad) continue
            c.d.desc = new Uint8Array(ph.desc.subarray(m.t * 32, m.t * 32 + 32))
            c.d.age = 0
            refreshed++
        }
        if (refreshed) this.debug.drm_refresh = refreshed
    }

    /**
     * Poster-free relocalization (LOST/SEARCHING): match the current frame's
     * ORB descriptors (already computed by the failed poster detect) against
     * the map's descriptor-bearing points, solve PnP from scratch (DLT init,
     * no prior; relocV2 adds a prior-seeded retry), refine with robust GN,
     * revive the inliers as the tracked map. ~0.25ms matching through the
     * SIMD kernel; runs only on frames that were already paying for a full
     * search detect.
     */
    _tryRelocalize() {
        const ls = this._lastScene
        if (!ls) return null
        // reloc cooldown: a PROBATION retraction (see below) means the
        // last accepted reloc was wrong - re-attempting immediately against
        // the same capital would flap accept/retract forever
        if (this._relocCooldown > 0) return null
        // failure-stage telemetry: which gate killed the attempt (rides the
        // map_dbg string into &dump=1 traces)
        const rdbg = (s) => {
            this.debug.map_dbg = (this.debug.map_dbg || '') + ' rl:' + s
        }

        // Tier 1 (relocV3): KEYFRAME snapshots, freshest first. Captured
        // right after refineAndCull under a STRONG poster, their 3D is
        // ground-contacted by construction - the dormant soup's
        // triangulation history is unverifiable and one-shot reloc
        // against it measured anywhere from 2.4 to 109cm across rolls.
        if (this.cfg.relocV3 && this.env.keyframes && this.env.keyframes.length) {
            for (const kf of this.env.keyframes) {
                const entries = Array.from({ length: kf.n }, (_, i) => ({
                    X: [kf.pts3[i * 3], kf.pts3[i * 3 + 1], kf.pts3[i * 3 + 2]],
                    desc: kf.desc.subarray(i * 32, i * 32 + 32)
                }))
                const r = this._relocAttempt(ls,
                    { n: kf.n, pts3: kf.pts3, desc: kf.desc, entries },
                    'kf' + kf.f, rdbg)
                if (r) return r
            }
        }

        // Tier 2: the classic desc-bearing soup (tracked + dormant)
        const rs = this.env.relocSet()
        if (!rs || rs.n < 10) return null
        return this._relocAttempt(ls, rs, 'soup', rdbg)
    }

    /** One reloc attempt against a {n, pts3, desc, entries} source. */
    _relocAttempt(ls, rs, srcTag, rdbg) {

        const V2 = this.cfg.relocV2

        const t0 = performance.now()
        // relocV2 rescue tier: the Lowe ratio mass-kills on self-similar
        // low-texture scenes (sim teleport: 26-entry bank, 0-1 ratio
        // survivors while the SAME corners sat ~50 bits from their stored
        // descs in ABSOLUTE distance). The extra outliers this admits are
        // absorbed by the Huber GN + inlier/meanErr gates below.
        const matches = SimdMatcher.match(
            { rows: rs.n, data: rs.desc },
            { rows: ls.desc.length / 32, data: ls.desc },
            0.8, V2 ? this.cfg.relocAbsHamming : 0)
        // relocV2: a small bank cannot produce 12 matches (46% of a 26-entry
        // bank!) - scale the floor with bank size, never below 8, never
        // above the classic 12.
        const matchFloor = V2 ? Math.max(8, Math.min(12, Math.round(rs.n * 0.3))) : 12
        if (matches.length < matchFloor) {
            rdbg(srcTag + ':m' + matches.length)
            return null
        }

        const nM = matches.length
        const pts3 = new Float64Array(nM * 3)
        const pts2 = new Float64Array(nM * 2)
        const matchQ = new Array(nM)
        const matchPos = new Float32Array(nM * 2)
        for (let i = 0; i < nM; i++) {
            const q = matches[i].q, t = matches[i].t
            matchQ[i] = q
            pts3[i * 3] = rs.pts3[q * 3]
            pts3[i * 3 + 1] = rs.pts3[q * 3 + 1]
            pts3[i * 3 + 2] = rs.pts3[q * 3 + 2]
            pts2[i * 2] = ls.pts[t * 2]
            pts2[i * 2 + 1] = ls.pts[t * 2 + 1]
            matchPos[i * 2] = ls.pts[t * 2]
            matchPos[i * 2 + 1] = ls.pts[t * 2 + 1]
        }

        // GN acceptance floor: scales with match count under relocV2 (7 =
        // the revived-count floor below; a smaller GN support could never
        // survive relocApply anyway), classic flat 10 otherwise.
        const gnFloor = V2
            ? Math.min(10, Math.max(7, Math.round(nM * 0.6)))
            : 10

        // One PnP+GN attempt. ITERATIVE without an extrinsic guess runs
        // OpenCV's internal DLT initialization (needs non-planar >= 6 -
        // DEGENERATE when the surviving matches are coplanar, e.g. all on
        // one wall). relocV2 adds a PRIOR-SEEDED retry: a stale/frozen
        // prior tens of cm off is still an excellent LM starting point,
        // and planar match sets refine fine FROM A GUESS.
        // relocV2: dormant 3D positions carry FROZEN triangulation error
        // (refine-before-cull only corrects points while tracked) - at real
        // noise floors the correct pose reprojects them several px off, so
        // the tracking-grade gates zero out the inlier set. Reloc gates are
        // scaled up; the small-support meanErr gate below still bounds the
        // accepted pose quality.
        const gnScale = V2 ? (this.cfg.relocGnScale || 1) : 1
        let gnBest = ''
        // Blind tier: ITERATIVE PnP without an extrinsic guess runs
        // OpenCV's internal DLT init (needs non-planar >= 6; degenerate on
        // coplanar match sets), then robust GN - the classic reloc path.
        const attempt = () => {
            const objMat = cv.matFromArray(nM, 3, cv.CV_64F, pts3)
            const imgMat = cv.matFromArray(nM, 2, cv.CV_64F, pts2)
            const rv = new cv.Mat(3, 1, cv.CV_64F)
            const tv = new cv.Mat(3, 1, cv.CV_64F)
            let ok = false
            try {
                ok = cv.solvePnP(objMat, imgMat, this.K, this.dist, rv, tv,
                    false, cv.SOLVEPNP_ITERATIVE)
            } catch (e) { ok = false }
            objMat.delete(); imgMat.delete()
            if (!ok) { rv.delete(); tv.delete(); gnBest += 'Dpnpx '; return null }

            const Rm = new cv.Mat()
            cv.Rodrigues(rv, Rm)
            const rd = Rm.data64F
            const R0 = [rd[0], rd[1], rd[2], rd[3], rd[4], rd[5], rd[6], rd[7], rd[8]]
            const t0v = [tv.data64F[0], tv.data64F[1], tv.data64F[2]]
            Rm.delete(); rv.delete(); tv.delete()

            // Robust refinement: descriptor matches carry 10-30% outliers;
            // the Huber IRLS + hard rejection in GN absorbs them
            const g = Geometry.motionOnlyGN(this.Kp, R0, t0v, pts3, pts2, {
                huberPx: this._cullPx() * 0.75 * gnScale,
                outlierPx: this._cullPx() * gnScale
            })
            gnBest += 'D' + (g.ok ? g.nInliers + 'e' + g.meanErr.toFixed(1) : 'x') + ' '
            return (g.ok && g.nInliers >= gnFloor) ? g : null
        }

        let g = attempt()
        let seeded = false
        if (!g && V2 && this.hasPrior && this.curR) {
            // Prior-seeded tier, coarse -> fine. A teleport-scale prior
            // error projects the bank ~100px off; GN's gross-outlier drop
            // (2.5x outlierPx after iteration 1) would discard EVERY match
            // before convergence, and LM PnP over unfiltered matches drags
            // toward outliers. Stage 1 only has to CONVERGE (loose Huber
            // funnel, nothing hard-dropped inside 2.5x its outlier gate);
            // stage 2 re-classifies at tracking grade and owns acceptance.
            const rsc = this._resScale || 1
            const g1 = Geometry.motionOnlyGN(this.Kp, this.curR, this.curT,
                pts3, pts2, {
                    huberPx: 24 * rsc, outlierPx: 48 * rsc, iterations: 10
                })
            if (g1.ok) {
                const g2 = Geometry.motionOnlyGN(this.Kp, g1.R, g1.t, pts3, pts2, {
                    huberPx: this._cullPx() * 0.75 * gnScale,
                    outlierPx: this._cullPx() * gnScale
                })
                gnBest += 'S' + (g2.ok ? g2.nInliers + 'e' + g2.meanErr.toFixed(1) : 'x') + ' '
                if (g2.ok && g2.nInliers >= gnFloor) { g = g2; seeded = true }
            } else {
                gnBest += 'S0 '
            }
        }
        if (!g) { rdbg(srcTag + ':gn[' + gnBest.trim() + ']'); return null }

        // Small support demands CLEAN support: below the classic 10-inlier
        // floor the pose must also reproject tightly, or a lucky coherent
        // outlier subset could teleport the camera to a wrong place (worse
        // than staying LOST).
        if (g.nInliers < 10 && g.meanErr > this._cullPx() * 0.6 * gnScale) {
            rdbg(srcTag + ':gn' + g.nInliers + 'e' + g.meanErr.toFixed(1))
            return null
        }

        // Physical sanity (no motion prior exists to jump-gate against)
        const C = Geometry.invertRT(g.R, g.t).t
        if (Math.hypot(C[0], C[1], C[2]) > 25) { rdbg(srcTag + ':far'); return null }

        // edgeGate: pass the accepted pose so relocApply can revive-sweep
        // the whole reprojection-consistent bank, not just the matched
        // subset (the matcher finds a HANDFUL; the GN+probation-verified
        // pose is evidence for every dormant that lands cleanly in view)
        const revived = this.cfg.edgeGate
            ? this.env.relocApply(rs.entries, matchQ, matchPos, g.inliers,
                this.Kp, g.R, g.t, this._fw, this._fh)
            : this.env.relocApply(rs.entries, matchQ, matchPos, g.inliers)
        if (revived < this.cfg.mapMinInliers) { rdbg(srcTag + ':rv' + revived); return null }

        this.debug.mode = 'reloc'
        this.debug.reloc_ms = Math.round((performance.now() - t0) * 10) / 10
        this.debug.reloc_revived = revived
        this.debug.reloc_src = srcTag
        if (seeded) this.debug.reloc_seeded = 1
        // relocV3 PROBATION: an accepted reloc is provisional. A wrong
        // world reveals itself within frames as the map solve FIGHTING the
        // jump gate (the 41cm-basin signature); two fights inside the
        // window retract the reloc to honest SEARCHING instead of tracking
        // a confidently wrong pose (hook at the §2 jump-gate site).
        if (this.cfg.relocV3) {
            this._relocProbation = { left: this._frames(8), jumps: 0 }
        }
        return {
            R: g.R, t: g.t, nInliers: g.nInliers,
            meanErr: g.meanErr, reloc: true
        }
    }

    /** Triangulation reprojection gate scaled to the measured noise floor. */
    _triMaxPx() {
        const rs = this._resScale || 1
        if (this.cfg.bootstrapV2) {
            // The noise floor is measured on REFINED poster anchors; a fresh
            // 2-view DLT point legitimately sits near 2x that. Gating at
            // 1.25x starved the map right at the poster-exit window (the
            // measured coin-flip collapse). Depth error admitted here is
            // corrected by refine-before-cull; baseline + parallax gates
            // (the drift protection) are unchanged.
            return this.noisePx === null ? 2.0 * rs : Math.max(2.6 * rs, 2.0 * this.noisePx)
        }
        return this.noisePx === null ? 1.5 * rs : Math.max(1.5 * rs, 1.25 * this.noisePx)
    }

    /** Map-point cull gate scaled to the measured noise floor. */
    _cullPx() {
        const rs = this._resScale || 1
        return this.noisePx === null ? 3.0 * rs : Math.max(3.0 * rs, 2.0 * this.noisePx)
    }

    /**
     * Gate scale handed to the map's OWN px thresholds (GN huber/outlier,
     * harvest spacing). Separate from _cullPx/_triMaxPx, which are computed
     * pipeline-side and passed pre-scaled.
     */
    _mapGS() {
        return this.cfg.resScaleMapGates ? (this._resScale || 1) : 1
    }

    /** Convert a 20Hz-reference frame count to the current frame rate. */
    _frames(nRef) {
        return this._fscale === 1 ? nRef : Math.max(1, Math.round(nRef * this._fscale))
    }

    /** Write a geometry-module pose (T_cw arrays) back into the cv prior. */
    _adoptRt(R, t) {
        this.curR = R.slice()
        this.curT = t.slice()
        const Rm = cv.matFromArray(3, 3, cv.CV_64F, R)
        cv.Rodrigues(Rm, this.rvec)
        Rm.delete()
        this.tvec.data64F[0] = t[0]
        this.tvec.data64F[1] = t[1]
        this.tvec.data64F[2] = t[2]
        this.hasPrior = true
    }

    /**
     * T_cw (row-major R, t) -> output pose dict for the renderer.
     * OpenCV -> Three.js conversion (port of _build_pose_data).
     */
    _poseFromRt(r, t, nInliers, total, reproj) {
        // R_cam = R^T ; t_cam = -R^T t
        const Rc = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]]
        const tc = [
            -(Rc[0] * t[0] + Rc[1] * t[1] + Rc[2] * t[2]),
            -(Rc[3] * t[0] + Rc[4] * t[1] + Rc[5] * t[2]),
            -(Rc[6] * t[0] + Rc[7] * t[1] + Rc[8] * t[2])
        ]

        // C = diag(1,-1,-1): R_gl = C * R_cam * C ; t_gl = C * t_cam
        // (flips signs of elements where exactly one index is in {1,2})
        const Rgl = [
            Rc[0], -Rc[1], -Rc[2],
            -Rc[3], Rc[4], Rc[5],
            -Rc[6], Rc[7], Rc[8]
        ]
        const tgl = [tc[0], -tc[1], -tc[2]]

        // Column-major 4x4 for Three.js
        const matrix = [
            Rgl[0], Rgl[3], Rgl[6], 0,
            Rgl[1], Rgl[4], Rgl[7], 0,
            Rgl[2], Rgl[5], Rgl[8], 0,
            tgl[0], tgl[1], tgl[2], 1
        ]

        const distance = Math.hypot(t[0], t[1], t[2])
        const confidence = this._confidence(nInliers, reproj, total)

        return {
            matrix,
            position: { x: tgl[0], y: tgl[1], z: tgl[2] },
            rotation: this._eulerDegrees(Rgl),
            distance,
            inlier_count: nInliers,
            reproj_error: reproj,
            state: this.state === PipelineState.SEARCHING ? PipelineState.TRACKING : this.state,
            confidence
        }
    }

    _confidence(inliers, reproj, total) {
        const inlierScore = Math.min(1.0, inliers / 20.0)
        const reprojScore = Math.max(0.0, 1.0 - reproj / this.cfg.maxReprojError)
        const coverageScore = Math.min(1.0, total / 30.0)
        return Math.max(0, Math.min(1, 0.4 * inlierScore + 0.4 * reprojScore + 0.2 * coverageScore))
    }

    /** Rotation matrix (row-major 9) -> XYZ Euler degrees. */
    _eulerDegrees(R) {
        const sy = Math.sqrt(R[0] * R[0] + R[3] * R[3])
        let x, y, z
        if (sy >= 1e-6) {
            x = Math.atan2(R[7], R[8])
            y = Math.atan2(-R[6], sy)
            z = Math.atan2(R[3], R[0])
        } else {
            x = Math.atan2(-R[5], R[4])
            y = Math.atan2(-R[6], sy)
            z = 0
        }
        const d = 180 / Math.PI
        return { x: x * d, y: y * d, z: z * d }
    }

    reset() {
        this.state = PipelineState.SEARCHING
        this.lostFrames = 0
        this.trackingFrames = 0
        this.mapFrames = 0
        this.hasPrior = false
        this.curR = null
        this.curT = null
        this._searchTick = 0
        this._framesSinceHarvest = 0
        this._framesSincePose = 0
        this._mapCoast = 0
        this._lastMapPose = null
        this._tsPrev = null
        this._dtPrev = null
        this._dtRatio = 1
        this._frameMs = 0
        this._fscale = 1
        this._lastFlow = null
        this._wasRotOnly = false
        this._detPending = null
        this._detReply = null
        this._asyncRelocReady = false
        this._dropTracking()
        if (this.env) this.env.reset()
        if (this.prevGray) { this.prevGray.delete(); this.prevGray = null }
    }
}

// Worker-global export
self.VisionPipeline = VisionPipeline
self.PipelineState = PipelineState
