# GOALS — the world-class gate

**The standing loop runs until `node tools/goal-gate.mjs` prints ALL GOALS
ACHIEVED.** Targets live in [goals.json](goals.json) and are FIXED: never
lower a target to pass it; raise one only with a rationale added here.

Protocol per round (unchanged parts stay unchanged):

1. Rounds are still flag-gated, battery-proven (paired A/B over seeds),
   suite-guarded (test-slam 14/14 is a hard bar), and closed by
   `tools/perf-gate.mjs` (hard-fails regressions — the floor).
2. `tools/goal-gate.mjs` then scores the round against this file (the
   ceiling). It never fails a round; it decides when the LOOP is done.
3. A goal flipping to ACHIEVED needs the round's battery as shipping
   evidence — the board is the finish line, batteries are the proof.
4. Goals measure fixed deterministic cases (seed 1, default degradation
   profile) so the board is comparable round to round.

## The physics walls (never targets — nobody passes these)

| Wall | Value | Why |
|---|---|---|
| Metric scale, camera-only | unobservable | Monocular projection is scale-invariant (math, not engineering). The poster anchor is what licenses metric claims. |
| Drift with poster gone | > 0% always | No absolute reference ⇒ random walk. Only slowable; loop closure (re-seeing the poster) is the only reset. |
| True measured pose age | ≥ ~10-15 ms | Exposure (~5-16ms) + rolling-shutter readout (~10ms). Sub-zero effective latency exists only via prediction. |
| Handheld position accuracy | ≥ ~1 mm | Physiological tremor is 0.2-1mm @ 8-12Hz. Math floor (0.1px corners, f≈1108px @1.5m, N-point averaging) is ~0.1-0.4mm — unmeasurable handheld. |
| Tracking through fast pan, no IMU | ≲ 200°/s | ~27px smear at 8ms exposure: the image contains zero corner signal. (Ceiling reopens if optional IMU returns.) |
| Full pipeline @720p in WASM | ≥ ~1 ms | 921k px × 6-8 memory passes ≈ the LPDDR bandwidth floor. |
| Acquisition | ≥ 1 frame | Already achieved (frame 0). |
| Sub-millimeter claims | marketing fiction | Competitors claiming it are measuring tripods. Not chased here. |

## The goals (world-class = 8th Wall / ARKit-image-tracker class)

| id | Goal | Target | Board at creation (2026-07-07) | Rationale |
|---|---|---|---|---|
| G1a | Poster-visible position | ≤ 0.30 cm | 1.19 (3.97×) | World-class 2-3mm; floor ~0.5mm. Levers: multi-frame corner averaging, rolling-shutter compensation, super-resolved templates. |
| G1b | Poster-visible rotation | ≤ 0.10° | 0.32 (3.20×) | Floor ~0.01°; gyro-fused systems sit at 0.1°. |
| G2a | Held drift @60Hz (fusedP90) | ≤ 5.0 cm | 19.24 (3.85×) | ≈1% of excursion = world-class mono-VO. Levers: bias-absorption round, sliding-window BA, mapDensity2 re-flip. |
| G2b | Held drift @20Hz (fusedP90) | ≤ 8.0 cm | 16.91 (2.11×) | Same, at the low-rate operating point. |
| G3 | Pose age P50 @60Hz | ≤ 17 ms | **ACHIEVED** (16.67) | Sitting on the camera wall. Next frontier (not gated): measured motion-to-photon ≈ 0 via predictive render. |
| G4a | Zero lost frames, all cases | 0 | 2 (slam tex0.5) | Losses are honesty events; zero means honest AND robust. |
| G4b | Held 100%, all cases incl. tex 0.5 | 100% | **ACHIEVED** | Locks the low-texture win against erosion. |
| G4c | test-slam suite | 14/14 | **ACHIEVED** | The hard bar that has vetoed two battery-winning flags — stays green forever. |
| G5a | proc slam720 P50 | ≤ 5 ms | 6.0 (1.20×) | ~5× above the memory wall — the last honest 2× lives in detect frames and maintenance passes. |
| G5b | proc fastpan720 P50 | ≤ 8 ms | 10.0 (1.25×) | |
| G5c | proc tilt720 P50 | ≤ 3 ms | **ACHIEVED** (2.9) | |
| G6 | Reloc snap accuracy | ≤ 1.0 cm | metric not exported yet | test-slam measures it in a check string (1.6cm today); export `relocSnapCm` into sim metrics, then flip goals.json kind to "metric". Instrumentation debt counts as REMAINING. |
| G7 | Vision core bundle (gzip) | ≤ 500 KB | 1,007,596 B (1.97×) | Path: no-OpenCV build on our own kernels (lk.c precedent) could reach 100-200KB. |

**Board at creation: 4/13 achieved.**

## Non-goals (recorded so future rounds don't chase them)

- Sub-millimeter accuracy (see walls).
- 100% hold under arbitrary motion without IMU (blur destroys signal).
- Measured pose age < 10ms (photons haven't arrived) — *effective* ~0ms
  via prediction is a future goal candidate once motion-to-photon
  instrumentation exists.
- Zero drift markerless (math).

## Change log

- 2026-07-07 — created; targets set from the physics analysis
  (session: maturation round). First board 4/13.
- 2026-07-08 — board 5/13 after the edgeGate round (bias-absorption):
  G2a 19.24 -> 9.67cm, G5b flipped ACHIEVED (10 -> 6.0ms), G1a 1.14.
  G6 note: relocSnapCm re-rolls across code eras with the detect
  schedule (0.83 -> 3.19 on the same seed); it is a chaotic-regime
  metric and the board takes the deterministic seed-1 roll as-is.
