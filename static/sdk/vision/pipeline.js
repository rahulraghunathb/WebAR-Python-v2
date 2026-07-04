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
    mapCoastMax: 3                 // max consecutive frames bridged on the prior
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
        this._lastMapPose = null          // {R, t, age, bridged} for drift-at-reacquire
        this._framesSincePose = 0         // frames since ANY accepted pose (jump-gate scaling)
        this._searchTick = 0              // SEARCHING half/full alternation
        this._mapCoast = 0                // consecutive coast frames (bootstrapV2)
        this._framesSinceHarvest = 0      // cadence for corner-only harvest passes
        this._halfGray = null             // pooled half-res Mat for cheap search
        this._lastScene = null            // {pts, desc} captured for relocalization

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
    processFrame(gray) {
        const t0 = performance.now()
        const w = gray.cols, h = gray.rows
        this.ensureIntrinsics(w, h)

        this.debug = {
            state: this.state, mode: '-', keypoints: 0, good_matches: 0,
            inliers: 0, track_points: 0, scale_used: 0,
            map_points: this.env ? this.env.size() : 0,
            map_cands: this.env ? this.env.candidateCount() : 0,
            map_dormant: this.env ? this.env.dormantCount() : 0
        }

        this._pendingHarvest = null
        this._envTrackedThisFrame = false
        if (this._lastMapPose) this._lastMapPose.age++
        this._framesSincePose++
        this._framesSinceHarvest++
        if (this.env) this.env.tickDormant()

        let result = null      // poster result
        let mapResult = null   // pose from the environment map
        let driftSnap = null   // map pose at the moment the poster came back

        // --- 1. poster KLT tracking (env points ride the same LK pass) ---
        // Also runs in MAP_TRACKING when a weak poster is still 2D-tracked:
        // its homography keeps the 2D chain alive so the poster can win back
        // the pose the moment it strengthens.
        if ((this.state === PipelineState.TRACKING || this.state === PipelineState.MAP_TRACKING) &&
            this.prevGray && this.trackScene) {
            result = this._trackStep(gray)

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
                const mapStarved = this.env &&
                    (this.env.size() + this.env.candidateCount()) < 25 &&
                    this.framesSinceRefresh >= 15
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
                    const det = this._detectStep(gray, matchBox ? { matchBox } : {})
                    if (det) { result = det; this.framesSinceRefresh = 0 }
                }
            }
        }

        // --- 2. map tracking: when the poster is absent OR weak ---
        // A weak poster (few homography inliers: small/oblique/at the view
        // edge) produces BIASED PnP poses - measured up to 19cm off while
        // "tracking". The map cross-checks it (see routing below).
        const posterWeak = result && result.nInliers < 30
        if ((!result || posterWeak) && this.env && this.prevGray) {
            if (!this._envTrackedThisFrame) this._lkEnvOnly(gray)
            const sz = this.env.size()
            let why = 'n=' + sz
            if (sz >= this.cfg.mapMinTrack && this.hasPrior && this.curR) {
                const g = this.env.solvePose(this.Kp, this.curR, this.curT)
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
                    const allow = this.cfg.mapMaxJumpM * Math.min(4, this._framesSincePose)
                    if (jump <= allow) {
                        mapResult = g
                    } else {
                        why += ' jump=' + jump.toFixed(3) + '>' + allow.toFixed(2)
                    }
                } else {
                    why += g.ok ? ' inl=' + g.nInliers : ' gn-fail'
                }
            } else if (!this.hasPrior || !this.curR) {
                why += ' no-prior'
            }
            // bootstrapV2 coast: a young map dipping ONE frame below the
            // inlier floor used to hard-LOST while the pose was still
            // cm-accurate - killing the KLT chain and the candidate bank.
            // Bridge up to mapCoastMax frames on the motion prior (constant
            // pose); map maintenance is SKIPPED during a coast so a stale
            // pose can never anchor new geometry.
            if (!mapResult && this.cfg.bootstrapV2 &&
                this.state === PipelineState.MAP_TRACKING &&
                this._mapCoast < this.cfg.mapCoastMax &&
                sz >= 4 && this.curR) {
                this._mapCoast++
                mapResult = {
                    R: this.curR.slice(), t: this.curT.slice(),
                    nInliers: 0, meanErr: -1, inliers: null, coast: true
                }
                why += ' coast' + this._mapCoast
            }
            if (!mapResult || mapResult.coast) this.debug.map_dbg = why
        }

        // --- 3. poster (re)detection ---
        if (!result) {
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
                    (this.env.candidateCount() < 12 && this._framesSinceHarvest >= 4)) {
                    this._harvestOnlyStep(gray, null)
                    this._framesSinceHarvest = 0
                }
                // Poster retry: the map pose PREDICTS where the poster is.
                // Offscreen -> skip entirely (this killed the dominant
                // MAP_TRACKING cost: full re-detections of a poster that
                // isn't even in view).
                this.posterRetryCount++
                if (this.posterRetryCount >= this.cfg.posterRetryInterval) {
                    this.posterRetryCount = 0
                    const roi = this._posterRoiFromPose(w, h)
                    let det = null
                    if (roi && roi.full) {
                        // poster predicted large/centered: cheap full-frame
                        // exploration pass (no level restriction - lastScale
                        // may be stale after a long map-only stretch)
                        det = this._detectStep(gray, { subTarget: true })
                    } else if (roi) {
                        det = this._detectStep(gray, { roi, nearLevels: true, subTarget: true })
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

        let posterPose = null
        if (result) {
            posterPose = this._solvePose(result.targetPts, result.scenePts, result.nInliers)
        }
        // "Strong" is calibrated to the measured noise floor: real phones
        // sit at ~2px reprojection even when the pose is excellent, while
        // synthetic renders sit at ~0.6px - a fixed constant is wrong on one
        // of them. The floor learns ONLY from unimpeachable frames (>= 45
        // inliers); a pose then qualifies as strong when its reproj is
        // within ~2x the floor (clamped) and it has enough inliers.
        if (posterPose && result.nInliers >= 45 && posterPose.reproj_error < 3) {
            this.noisePx = this.noisePx === null
                ? posterPose.reproj_error
                : 0.9 * this.noisePx + 0.1 * posterPose.reproj_error
        }
        const strongThresh = this.noisePx === null
            ? 1.2 : Math.min(3.0, Math.max(1.2, 2.0 * this.noisePx))
        const strongPoster = !!(posterPose && result.nInliers >= 30 &&
            posterPose.reproj_error <= strongThresh)
        this.debug.strong = strongPoster ? 1 : 0
        if (posterPose) this.debug.reproj = Math.round(posterPose.reproj_error * 100) / 100

        let kind = null
        if (posterPose && (strongPoster || !mapResult)) {
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
        } else if (kind === 'map') {
            this.state = PipelineState.MAP_TRACKING
            this.lostFrames = 0
            this.mapFrames++
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
                if (this.lostFrames > this.cfg.lostFrameGrace) {
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
                    (this._lastMapPose && this._lastMapPose.age <= 15 ? this._lastMapPose : null)
                if (snapRef && strongPoster) {
                    const Cm = Geometry.invertRT(snapRef.R, snapRef.t).t
                    const Cp = Geometry.invertRT(this.curR, this.curT).t
                    this.debug.reacquire_drift_m = Math.round(Math.hypot(
                        Cm[0] - Cp[0], Cm[1] - Cp[1], Cm[2] - Cp[2]) * 1000) / 1000
                    this.debug.map_frames_bridged = snapRef.bridged
                    if (snapRef.age > 0) this.debug.reacquire_gap_frames = snapRef.age
                    this._lastMapPose = null
                }
                this.mapFrames = 0
                // Map maintenance ONLY under a STRONG poster pose: at the
                // view edge (few inliers, oblique) PnP is biased, and
                // refining/anchoring against a biased pose CORRUPTS good map
                // depths exactly when the map is about to be needed.
                if (strongPoster) {
                    this.env.refineAndCull(this.Kp, this.curR, this.curT, this._cullPx())
                    // bootstrapV2: proactive corner-only replenishment DURING
                    // poster tracking (it was MAP_TRACKING-only). The traces
                    // show candidates pinned at 0 through the poster-exit
                    // window while KLT bleeds map points - that starvation is
                    // what decided the bootstrap coin flip. ~8ms, cheap pass,
                    // only when the candidate pipeline runs low.
                    if (this.cfg.bootstrapV2 && !this._pendingHarvest &&
                        this.env.candidateCount() < 12 && this._framesSinceHarvest >= 4) {
                        this._harvestOnlyStep(gray, result && result.corners ? result.corners : null)
                        this._framesSinceHarvest = 0
                    }
                    if (this._pendingHarvest) {
                        this.env.harvest(this._pendingHarvest.pts, this._pendingHarvest.corners,
                            this.curR, this.curT, w, h, this._pendingHarvest.desc)
                        this._pendingHarvest = null
                    }
                    // bootstrapV2: with the poster anchoring the pose (metric
                    // truth, no VO drift) triangulation can afford LESS
                    // baseline/parallax - candidates mature ~4 frames sooner,
                    // so the poster-exit handoff finds a populated map. The
                    // admitted depth noise is corrected by refine-before-cull
                    // + young-point immunity.
                    this.env.triangulate(this.Kp, this.curR, this.curT, this._triMaxPx(),
                        this.cfg.bootstrapV2 ? 0.75 : undefined)
                }
            }
        } else if (kind === 'map') {
            if (this.debug.mode !== 'reloc') this.debug.mode = mapResult.coast ? 'map-coast' : 'map-track'
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
            if (!mapResult.reloc && !mapResult.coast) this.env.purgeOutliers(mapResult.inliers)
            if (!mapResult.coast) {
                this._lastMapPose = {
                    R: mapResult.R.slice(), t: mapResult.t.slice(),
                    age: 0, bridged: this.mapFrames
                }
            }
            pose = this._poseFromRt(mapResult.R, mapResult.t,
                mapResult.nInliers, this.env.size(), mapResult.meanErr)
            confidence = mapResult.coast ? 0.15 : Math.min(1.0, mapResult.nInliers / 30.0)

            // Map maintenance continues WITHOUT the poster: harvest from any
            // detection run this frame (anchored at the map pose - drifty but
            // metric) and triangulate matured candidates, so the map extends
            // into newly visible territory instead of starving. NEVER during
            // a coast: a stale pose must not anchor new geometry.
            if (!mapResult.coast) {
                if (this._pendingHarvest) {
                    this.env.harvest(this._pendingHarvest.pts, null,
                        this.curR, this.curT, w, h, this._pendingHarvest.desc)
                    this._pendingHarvest = null
                }
                const gateScale = 1 + Math.min(1, this.mapFrames / 45)
                this.env.triangulate(this.Kp, this.curR, this.curT, this._triMaxPx(), gateScale)
            }
        }

        this.debug.map_points = this.env ? this.env.size() : 0
        this.debug.map_cands = this.env ? this.env.candidateCount() : 0
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

        if (opts.half) {
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
        if (!opts.roi && !opts.half) this._adaptFast(nScene)
        if (nScene < 8) { kp.delete(); desc.delete(); return null }

        // Scene points as flat array, in FULL-RES frame coordinates
        const scenePts = new Float32Array(nScene * 2)
        for (let i = 0; i < nScene; i++) {
            const p = kp.get(i).pt
            scenePts[i * 2] = p.x * coordScale + offX
            scenePts[i * 2 + 1] = p.y * coordScale + offY
        }
        kp.delete()

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

            const fit = this._homographyFit(src, dst, this.cfg.ransacThresh)
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
        // Half-res shifts the apparent scale: a level matching at s on the
        // half image corresponds to ~2s at full res - record THAT, so the
        // next full-res near-level pass picks the right pyramid level.
        this.lastScale = opts.half ? Math.min(1.0, best.scale * 2) : best.scale

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

        // Poster matched: exclude its quad from harvesting
        this._pendingHarvest.corners = best.corners
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
    _harvestOnlyStep(gray, corners) {
        const t0 = performance.now()
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

        // Interior angles ~17°..160°
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
    _lkAll(gray, flat) {
        const n = flat.length / 2
        const prevPts = cv.matFromArray(n, 1, cv.CV_32FC2, flat)
        const nextPts = new cv.Mat()
        const status = new cv.Mat()
        const err = new cv.Mat()
        const winSize = new cv.Size(21, 21)
        const criteria = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 30, 0.01)

        cv.calcOpticalFlowPyrLK(this.prevGray, gray, prevPts, nextPts, status, err, winSize, 3, criteria)

        const ok = new Uint8Array(n)
        const next = new Float32Array(n * 2)

        if (this.cfg.fbCheck) {
            // Classic forward-backward consistency: a second full LK pass
            // (doubles LK cost - 4 pyramid builds per frame).
            const backPts = new cv.Mat()
            const backStatus = new cv.Mat()
            const backErr = new cv.Mat()
            cv.calcOpticalFlowPyrLK(gray, this.prevGray, nextPts, backPts, backStatus, backErr, winSize, 3, criteria)
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
            const errMax = 28  // LK patch residual gate (per-pixel avg SSD)
            for (let i = 0; i < n; i++) {
                next[i * 2] = nextPts.data32F[i * 2]
                next[i * 2 + 1] = nextPts.data32F[i * 2 + 1]
                if (!status.data[i]) continue
                if (err.data32F[i] > errMax) continue
                ok[i] = 1
            }
        }

        prevPts.delete(); nextPts.delete(); status.delete(); err.delete()
        return { next, ok }
    }

    /** Track only the environment points (poster set empty / failed). */
    _lkEnvOnly(gray) {
        const env = this.env.trackXY()
        const n = env.nPoints + env.nCandidates
        if (!n) return
        const lk = this._lkAll(gray, env.flat)
        this.env.applyTrack(lk.next, lk.ok, env.nPoints, env.nCandidates)
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
                flat = new Float32Array((nPoster + nEnv) * 2)
                flat.set(this.trackScene, 0)
                flat.set(envInfo.flat, nPoster * 2)
            }
        }

        const lk = this._lkAll(gray, flat)

        if (envInfo && (envInfo.nPoints + envInfo.nCandidates) > 0) {
            this.env.applyTrack(
                lk.next.subarray(nPoster * 2),
                lk.ok.subarray(nPoster),
                envInfo.nPoints, envInfo.nCandidates)
            this._envTrackedThisFrame = true
        }

        const keptTarget = [], keptScene = []
        for (let i = 0; i < nPoster; i++) {
            if (!lk.ok[i]) continue
            keptTarget.push(this.trackTarget[i * 2], this.trackTarget[i * 2 + 1])
            keptScene.push(lk.next[i * 2], lk.next[i * 2 + 1])
        }

        if (keptTarget.length / 2 < this.cfg.minTrackPoints) return null

        // Homography from ANCHORED target coords -> current scene (no drift integration)
        const src = new Float32Array(keptTarget)
        const dst = new Float32Array(keptScene)
        const fit = this._homographyFit(src, dst, this.cfg.trackRansacThresh)
        if (!fit) return null

        const corners = this._projectCorners(fit.H)
        if (!this._validateQuad(corners, this.lastScale)) { fit.H.delete(); return null }
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
        this.trackTarget = tKeep
        this.trackScene = sKeep
        this.framesSinceRefresh++

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

        if (reproj > this.cfg.maxReprojError * (this.hasPrior ? 1.5 : 1.0)) {
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
     * Poster-free relocalization (LOST/SEARCHING): match the current frame's
     * ORB descriptors (already computed by the failed poster detect) against
     * the map's descriptor-bearing points, solve PnP from scratch (DLT init,
     * no prior), refine with robust GN, revive the inliers as the tracked
     * map. ~0.25ms matching through the SIMD kernel; runs only on frames
     * that were already paying for a full search detect.
     */
    _tryRelocalize() {
        const ls = this._lastScene
        const rs = this.env.relocSet()
        if (!ls || !rs || rs.n < 10) return null

        const t0 = performance.now()
        const matches = SimdMatcher.match(
            { rows: rs.n, data: rs.desc },
            { rows: ls.desc.length / 32, data: ls.desc },
            0.8)
        if (matches.length < 12) return null

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

        // Initial pose with NO prior: ITERATIVE without an extrinsic guess
        // runs OpenCV's internal DLT initialization (needs non-planar >= 6)
        const objMat = cv.matFromArray(nM, 3, cv.CV_64F, pts3)
        const imgMat = cv.matFromArray(nM, 2, cv.CV_64F, pts2)
        const rv = new cv.Mat(3, 1, cv.CV_64F)
        const tv = new cv.Mat(3, 1, cv.CV_64F)
        let ok = false
        try {
            ok = cv.solvePnP(objMat, imgMat, this.K, this.dist, rv, tv, false, cv.SOLVEPNP_ITERATIVE)
        } catch (e) { ok = false }
        objMat.delete(); imgMat.delete()
        if (!ok) { rv.delete(); tv.delete(); return null }

        const Rm = new cv.Mat()
        cv.Rodrigues(rv, Rm)
        const rd = Rm.data64F
        const R0 = [rd[0], rd[1], rd[2], rd[3], rd[4], rd[5], rd[6], rd[7], rd[8]]
        const t0v = [tv.data64F[0], tv.data64F[1], tv.data64F[2]]
        Rm.delete(); rv.delete(); tv.delete()

        // Robust refinement: descriptor matches carry 10-30% outliers; the
        // Huber IRLS + hard rejection in GN absorbs them
        const g = Geometry.motionOnlyGN(this.Kp, R0, t0v, pts3, pts2, {
            huberPx: this._cullPx() * 0.75,
            outlierPx: this._cullPx()
        })
        if (!g.ok || g.nInliers < 10) return null

        // Physical sanity (no motion prior exists to jump-gate against)
        const C = Geometry.invertRT(g.R, g.t).t
        if (Math.hypot(C[0], C[1], C[2]) > 25) return null

        const revived = this.env.relocApply(rs.entries, matchQ, matchPos, g.inliers)
        if (revived < this.cfg.mapMinInliers) return null

        this.debug.mode = 'reloc'
        this.debug.reloc_ms = Math.round((performance.now() - t0) * 10) / 10
        this.debug.reloc_revived = revived
        return {
            R: g.R, t: g.t, nInliers: g.nInliers,
            meanErr: g.meanErr, reloc: true
        }
    }

    /** Triangulation reprojection gate scaled to the measured noise floor. */
    _triMaxPx() {
        if (this.cfg.bootstrapV2) {
            // The noise floor is measured on REFINED poster anchors; a fresh
            // 2-view DLT point legitimately sits near 2x that. Gating at
            // 1.25x starved the map right at the poster-exit window (the
            // measured coin-flip collapse). Depth error admitted here is
            // corrected by refine-before-cull; baseline + parallax gates
            // (the drift protection) are unchanged.
            return this.noisePx === null ? 2.0 : Math.max(2.6, 2.0 * this.noisePx)
        }
        return this.noisePx === null ? 1.5 : Math.max(1.5, 1.25 * this.noisePx)
    }

    /** Map-point cull gate scaled to the measured noise floor. */
    _cullPx() {
        return this.noisePx === null ? 3.0 : Math.max(3.0, 2.0 * this.noisePx)
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
        this._dropTracking()
        if (this.env) this.env.reset()
        if (this.prevGray) { this.prevGray.delete(); this.prevGray = null }
    }
}

// Worker-global export
self.VisionPipeline = VisionPipeline
self.PipelineState = PipelineState
