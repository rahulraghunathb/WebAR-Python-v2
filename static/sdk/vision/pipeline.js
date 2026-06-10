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
    TRACKING: 'TRACKING',
    LOST: 'LOST'
}

const PIPELINE_DEFAULTS = {
    // --- target compilation ---
    scales: [1.0, 0.5, 0.3],       // sparse external pyramid (ORB internal pyramid covers between)
    targetFeatures: 2000,          // per-scale features for the target (compiled once)

    // --- detection (acquisition) ---
    sceneFeatures: 600,
    minMatches: 10,
    minInliersBase: 8,
    ransacThresh: 4.0,
    minInlierRatio: 0.40,
    minInlierRatioSmall: 0.50,     // stricter for small scales

    // --- KLT tracking ---
    maxTrackPoints: 60,            // cap for per-frame LK cost
    minTrackPoints: 12,            // below this -> LOST
    refreshPointThreshold: 24,     // re-detect to replenish below this
    refreshInterval: 45,           // frames between forced re-anchoring detections
    fbErrorThresh: 1.5,            // forward-backward consistency (px)
    trackRansacThresh: 3.0,

    // --- pose ---
    targetPhysicalBase: 1.0,       // longest target side in meters
    minInliersPnP: 6,
    maxReprojError: 5.0,           // px
    lostFrameGrace: 15             // frames shown as LOST before SEARCHING
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
                // Store keypoints scaled back to full-resolution target coords
                const pts = new Float32Array(n * 2)
                for (let i = 0; i < n; i++) {
                    const p = kp.get(i).pt
                    pts[i * 2] = p.x / scale
                    pts[i * 2 + 1] = p.y / scale
                }
                this.targetLevels.push({ scale, pts, desc })
                counts.push(n)
            } else {
                desc.delete()
            }
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

    // ================= Intrinsics =================

    setIntrinsics(fx, fy, cx, cy) {
        const fp = fx + ',' + fy + ',' + cx + ',' + cy
        if (fp === this.kFingerprint) return
        if (this.K) this.K.delete()
        this.K = cv.matFromArray(3, 3, cv.CV_64F, [fx, 0, cx, 0, fy, cy, 0, 0, 1])
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
            inliers: 0, track_points: 0, scale_used: 0
        }

        let result = null

        if (this.state === PipelineState.TRACKING && this.prevGray) {
            result = this._trackStep(gray)

            // Periodic re-anchoring / replenishment while tracking
            if (result && (this.framesSinceRefresh >= this.cfg.refreshInterval ||
                           result.trackPoints < this.cfg.refreshPointThreshold)) {
                const det = this._detectStep(gray)
                if (det) { result = det; this.framesSinceRefresh = 0 }
            }
        }

        if (!result) {
            // SEARCHING / LOST / tracking just failed -> full detection
            result = this._detectStep(gray)
            this.framesSinceRefresh = 0
        }

        // --- state bookkeeping ---
        if (result) {
            this.state = PipelineState.TRACKING
            this.lostFrames = 0
            this.trackingFrames++
        } else {
            this._dropTracking()
            if (this.state === PipelineState.TRACKING) {
                this.state = PipelineState.LOST
                this.lostFrames = 1
            } else if (this.state === PipelineState.LOST) {
                this.lostFrames++
                if (this.lostFrames > this.cfg.lostFrameGrace) {
                    this.state = PipelineState.SEARCHING
                    this.hasPrior = false
                }
            }
            this.trackingFrames = 0
        }

        // Keep current frame for next LK step
        if (this.prevGray) this.prevGray.delete()
        this.prevGray = gray.clone()

        this.debug.state = this.state
        const procMs = performance.now() - t0

        if (!result) {
            return { detected: false, frameSize: [w, h], debug: this._debugOut(procMs) }
        }

        const pose = this._solvePose(result.targetPts, result.scenePts, result.nInliers)
        const out = {
            detected: true,
            frameSize: [w, h],
            corners: result.corners,
            confidence: Math.min(1.0, result.nInliers / 20.0),
            debug: this._debugOut(procMs)
        }
        if (pose) {
            out.pose = pose
            out.debug.tracking_state = this.state
            out.debug.tracking_confidence = pose.confidence
        } else {
            // PnP failed despite 2D detection - report as not detected so the
            // renderer never gets a 2D-only "ghost" result
            out.detected = false
            delete out.corners
        }
        return out
    }

    _debugOut(procMs) {
        return Object.assign({}, this.debug, { proc_ms: Math.round(procMs * 10) / 10 })
    }

    // ================= Detection (acquisition / re-anchoring) =================

    _detectStep(gray) {
        this.debug.mode = 'detect'

        const kp = new cv.KeyPointVector()
        const desc = new cv.Mat()
        const mask = new cv.Mat()
        this.orb.detectAndCompute(gray, mask, kp, desc)
        mask.delete()

        const nScene = kp.size()
        this.debug.keypoints = nScene
        if (nScene < 8) { kp.delete(); desc.delete(); return null }

        // Scene points as flat array for fast indexing
        const scenePts = new Float32Array(nScene * 2)
        for (let i = 0; i < nScene; i++) {
            const p = kp.get(i).pt
            scenePts[i * 2] = p.x
            scenePts[i * 2 + 1] = p.y
        }
        kp.delete()

        let best = null

        for (const level of this._scaleOrder()) {
            const m = this._match(level.desc, desc)
            if (m.length < this.cfg.minMatches) continue

            // Build correspondence arrays
            const src = new Float32Array(m.length * 2)
            const dst = new Float32Array(m.length * 2)
            for (let i = 0; i < m.length; i++) {
                src[i * 2] = level.pts[m[i].q * 2]
                src[i * 2 + 1] = level.pts[m[i].q * 2 + 1]
                dst[i * 2] = scenePts[m[i].t * 2]
                dst[i * 2 + 1] = scenePts[m[i].t * 2 + 1]
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

        desc.delete()
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
        this.lastScale = best.scale

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
        return out
    }

    _scaleOrder() {
        const near = [], far = []
        for (const l of this.targetLevels) {
            (Math.abs(l.scale - this.lastScale) < 0.15 ? near : far).push(l)
        }
        far.sort((a, b) => a.scale - b.scale)
        return near.concat(far)
    }

    /** kNN match + Lowe ratio test. Returns [{q, t}] (query/train indices). */
    _match(targetDesc, sceneDesc, ratio) {
        ratio = ratio || 0.8
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
            H = cv.findHomography(srcMat, dstMat, cv.RANSAC, thresh, inlierMask)
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

    _trackStep(gray) {
        this.debug.mode = 'track'
        const nPrev = this.trackScene.length / 2
        if (nPrev < this.cfg.minTrackPoints) return null

        const prevPts = cv.matFromArray(nPrev, 1, cv.CV_32FC2, this.trackScene)
        const nextPts = new cv.Mat()
        const status = new cv.Mat()
        const err = new cv.Mat()
        const winSize = new cv.Size(21, 21)
        const criteria = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 30, 0.01)

        cv.calcOpticalFlowPyrLK(this.prevGray, gray, prevPts, nextPts, status, err, winSize, 3, criteria)

        // Forward-backward check: track back and require round-trip < threshold
        const backPts = new cv.Mat()
        const backStatus = new cv.Mat()
        const backErr = new cv.Mat()
        cv.calcOpticalFlowPyrLK(gray, this.prevGray, nextPts, backPts, backStatus, backErr, winSize, 3, criteria)

        const keptTarget = [], keptScene = []
        const fbMax = this.cfg.fbErrorThresh
        for (let i = 0; i < nPrev; i++) {
            if (!status.data[i] || !backStatus.data[i]) continue
            const fbx = backPts.data32F[i * 2] - this.trackScene[i * 2]
            const fby = backPts.data32F[i * 2 + 1] - this.trackScene[i * 2 + 1]
            if (fbx * fbx + fby * fby > fbMax * fbMax) continue
            keptTarget.push(this.trackTarget[i * 2], this.trackTarget[i * 2 + 1])
            keptScene.push(nextPts.data32F[i * 2], nextPts.data32F[i * 2 + 1])
        }

        prevPts.delete(); nextPts.delete(); status.delete(); err.delete()
        backPts.delete(); backStatus.delete(); backErr.delete()

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

        // ---- OpenCV -> Three.js conversion (port of _build_pose_data) ----
        const R = new cv.Mat()
        cv.Rodrigues(this.rvec, R)
        const r = R.data64F  // row-major 3x3
        R.delete()
        const t = [this.tvec.data64F[0], this.tvec.data64F[1], this.tvec.data64F[2]]

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
        const confidence = this._confidence(nInliers, reproj, n)

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
        this.hasPrior = false
        this._dropTracking()
        if (this.prevGray) { this.prevGray.delete(); this.prevGray = null }
    }
}

// Worker-global export
self.VisionPipeline = VisionPipeline
self.PipelineState = PipelineState
