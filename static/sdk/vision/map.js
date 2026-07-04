/**
 * WebAR SDK - Environment map for marker-bootstrapped VO (M2/M3)
 *
 * Maintains the live set of metric 3D environment points that keep the
 * camera pose observable when the poster leaves the view:
 *
 *  - CANDIDATES: 2D corners harvested off-target while the poster pose is
 *    known. Each stores its first-observation pose (the "keyframe anchor").
 *    Once the camera has moved enough (ray parallax > threshold), the
 *    candidate is triangulated (DLT) against its anchor and - if it passes
 *    cheirality/reprojection/depth gates - promoted to a map point. Scale
 *    is METRIC because both poses came from the metrically-known poster.
 *  - MAP POINTS: 3D world points tracked frame-to-frame by the SAME KLT
 *    pass as the poster features. Pose without the poster = robust
 *    motion-only Gauss-Newton (geometry.js) on these correspondences.
 *
 * No descriptors are stored: a point that KLT loses is dropped (the map
 * rebuilds whenever the poster is visible). This makes the "map" honest
 * visual odometry state rather than a relocalizable SLAM map - poster
 * re-detection is the loop closure that kills accumulated drift.
 *
 * Pure JS (uses geometry.js only) -> Node-testable.
 */

/* global Geometry */

const ENV_MAP_DEFAULTS = {
    mapMaxPoints: 120,
    mapMaxCandidates: 40,
    harvestCellPx: 60,        // bucket size for spatial spread
    harvestPerCell: 2,
    harvestMinDist: 14,       // px distance to any existing tracked point
    parallaxDeg: 3.0,         // triangulate when anchor/current rays exceed this
    minBaselineM: 0.08,       // m - REAL camera translation between views.
                              // Rotation produces zero baseline; without this
                              // gate, pose noise under rotation-dominant
                              // motion fakes parallax and triangulates
                              // garbage depths (sigma_Z ~ Z^2/(f*b)).
    triMaxReproj: 2.5,        // px, both views (device noise floor ~2px;
                              // depth quality is enforced by the baseline +
                              // parallax gates, which are physics not noise)
    triMinDepth: 0.15,        // m
    triMaxDepth: 12,          // m
    triPerFrame: 12,          // amortize triangulation cost
    mapHuberPx: 2.0,
    mapOutlierPx: 4.0,
    dormantMax: 160,          // relocalizable point pool cap (32B desc each)
    dormantMaxAge: 900        // frames before a dormant point is forgotten
}

class EnvMap {
    constructor(cfg) {
        this.cfg = Object.assign({}, ENV_MAP_DEFAULTS, cfg || {})
        this.points = []      // TRACKED: {X:[3], u, v, desc?: Uint8Array(32), ...anchor fields}
        this.dormant = []     // lost-from-KLT points WITH descriptors: the
                              // relocalizable part of the map. {X, desc, age}
        this.candidates = []  // {u0, v0, R0:[9], t0:[3], u, v, age, desc?}
        this.G = (typeof Geometry !== 'undefined') ? Geometry
            : (typeof require !== 'undefined' ? require('./geometry.js') : null)
    }

    size() { return this.points.length }
    candidateCount() { return this.candidates.length }
    dormantCount() { return this.dormant.length }
    relocCount() {
        let n = this.dormant.length
        for (const p of this.points) if (p.desc) n++
        return n
    }

    reset() {
        this.points.length = 0
        this.dormant.length = 0
        this.candidates.length = 0
    }

    /**
     * Tracking collapsed (KLT chains broken): move every descriptor-bearing
     * point into the dormant pool for later relocalization; everything
     * without a descriptor is unrecoverable and dropped.
     */
    sleep() {
        for (const p of this.points) {
            if (p.desc) this.dormant.push({ X: p.X, desc: p.desc, age: 0 })
        }
        this.points.length = 0
        this.candidates.length = 0
        this._capDormant()
    }

    _capDormant() {
        const max = this.cfg.dormantMax
        if (this.dormant.length > max) {
            this.dormant.splice(0, this.dormant.length - max)  // drop oldest
        }
    }

    /**
     * Current 2D positions of everything this map needs tracked, flattened
     * for the pipeline's unified LK pass: [map points..., candidates...].
     */
    trackXY() {
        const nP = this.points.length, nC = this.candidates.length
        const flat = new Float32Array((nP + nC) * 2)
        for (let i = 0; i < nP; i++) {
            flat[i * 2] = this.points[i].u
            flat[i * 2 + 1] = this.points[i].v
        }
        for (let i = 0; i < nC; i++) {
            flat[(nP + i) * 2] = this.candidates[i].u
            flat[(nP + i) * 2 + 1] = this.candidates[i].v
        }
        return { flat, nPoints: nP, nCandidates: nC }
    }

    /**
     * Consume the LK result for this map's section of the unified track.
     * Points/candidates that failed forward-backward tracking are dropped
     * (no descriptors -> no re-find; the map rebuilds under poster view).
     */
    applyTrack(next, ok, nPoints, nCandidates) {
        const keptP = []
        for (let i = 0; i < nPoints; i++) {
            const p = this.points[i]
            if (!ok[i]) {
                // KLT lost it. With a descriptor it stays relocalizable.
                if (p.desc) this.dormant.push({ X: p.X, desc: p.desc, age: 0 })
                continue
            }
            p.u = next[i * 2]
            p.v = next[i * 2 + 1]
            keptP.push(p)
        }
        this.points = keptP
        this._capDormant()

        const keptC = []
        for (let i = 0; i < nCandidates; i++) {
            const j = nPoints + i
            if (!ok[j]) continue
            const c = this.candidates[i]
            c.u = next[j * 2]
            c.v = next[j * 2 + 1]
            c.age++
            keptC.push(c)
        }
        this.candidates = keptC
    }

    /**
     * Harvest new candidates from detector keypoints (poster pose known).
     * @param kpts   Float32Array 2N of scene keypoint positions
     * @param quad   4x[x,y] poster corners to exclude (or null)
     * @param R, t   current T_cw
     * @param w, h   frame size (for bucketing)
     */
    harvest(kpts, quad, R, t, w, h, descBytes) {
        const c = this.cfg
        const room = c.mapMaxCandidates - this.candidates.length
        if (room <= 0) return 0

        // occupancy grid over existing tracked points + accepted candidates
        const cols = Math.max(1, Math.ceil(w / c.harvestCellPx))
        const rows = Math.max(1, Math.ceil(h / c.harvestCellPx))
        const occ = new Uint8Array(cols * rows)
        const mark = (u, v) => {
            const ci = Math.min(cols - 1, Math.max(0, Math.floor(u / c.harvestCellPx)))
            const ri = Math.min(rows - 1, Math.max(0, Math.floor(v / c.harvestCellPx)))
            occ[ri * cols + ci]++
        }
        for (const p of this.points) mark(p.u, p.v)
        for (const cd of this.candidates) mark(cd.u, cd.v)

        const existing = []
        for (const p of this.points) existing.push(p.u, p.v)
        for (const cd of this.candidates) existing.push(cd.u, cd.v)

        let added = 0
        const minD2 = c.harvestMinDist * c.harvestMinDist
        for (let i = 0; i < kpts.length / 2 && added < room; i++) {
            const u = kpts[i * 2], v = kpts[i * 2 + 1]
            if (quad && pointInQuad(u, v, quad)) continue

            const ci = Math.min(cols - 1, Math.max(0, Math.floor(u / c.harvestCellPx)))
            const ri = Math.min(rows - 1, Math.max(0, Math.floor(v / c.harvestCellPx)))
            if (occ[ri * cols + ci] >= c.harvestPerCell) continue

            let tooClose = false
            for (let k = 0; k < existing.length; k += 2) {
                const dx = existing[k] - u, dy = existing[k + 1] - v
                if (dx * dx + dy * dy < minD2) { tooClose = true; break }
            }
            if (tooClose) continue

            this.candidates.push({
                u0: u, v0: v, R0: R.slice(), t0: t.slice(),
                u, v, age: 0,
                // 32-byte ORB descriptor when the source pass computed them
                // (full detects do, corner-only harvests don't): makes the
                // eventual map point relocalizable
                desc: descBytes ? descBytes.slice(i * 32, i * 32 + 32) : null
            })
            existing.push(u, v)
            occ[ri * cols + ci]++
            added++
        }
        return added
    }

    /**
     * Triangulate matured candidates against their anchor pose (current
     * poster pose known). Promotes survivors to map points.
     */
    triangulate(K, R, t, maxReproj, gateScale) {
        const c = this.cfg
        const G = this.G
        const reprojGate = maxReproj || c.triMaxReproj
        // gateScale > 1 during long map-only stretches: anchor poses carry
        // accumulated VO drift, so demand MORE baseline/parallax before
        // trusting a triangulation (uncertainty-proportional gating)
        const gs = gateScale || 1
        if (this.points.length >= c.mapMaxPoints) return 0

        // Camera center now (for the baseline gate)
        const Cnow = G.invertRT(R, t).t

        let done = 0, promoted = 0
        const keep = []
        for (const cd of this.candidates) {
            if (done >= c.triPerFrame || this.points.length + promoted >= c.mapMaxPoints) {
                keep.push(cd)
                continue
            }
            if (cd.age < 2) { keep.push(cd); continue }

            // Baseline gate first: rotation creates apparent parallax under
            // pose noise but no triangulation information
            const C0 = G.invertRT(cd.R0, cd.t0).t
            const baseline = Math.hypot(Cnow[0] - C0[0], Cnow[1] - C0[1], Cnow[2] - C0[2])
            if (baseline < c.minBaselineM * gs) { keep.push(cd); continue }

            const ang = G.rayAngleDeg(K, cd.R0, cd.u0, cd.v0, R, cd.u, cd.v)
            if (ang < c.parallaxDeg * gs) { keep.push(cd); continue }

            done++
            const r = G.triangulateDLT(K, cd.R0, cd.t0, cd.u0, cd.v0, R, t, cd.u, cd.v)
            // Gates: cheirality both views, bounded depth, reprojection
            if (r &&
                r.depth1 > c.triMinDepth && r.depth2 > c.triMinDepth &&
                r.depth1 < c.triMaxDepth && r.depth2 < c.triMaxDepth &&
                r.err1 < reprojGate && r.err2 < reprojGate) {
                // Keep the anchor: refineAndCull() re-triangulates this point
                // as the baseline grows (depth precision ~ 1/baseline)
                this.points.push({
                    X: r.X, u: cd.u, v: cd.v, desc: cd.desc || null,
                    u0: cd.u0, v0: cd.v0, R0: cd.R0, t0: cd.t0, b0: baseline
                })
                promoted++
            } else if (c.bootstrapV2 && (cd.fails || 0) < 2) {
                // Under real image noise a single-shot DLT verdict is
                // unreliable, and every retry has MORE baseline (strictly
                // better conditioning). Two strikes with growing baseline =
                // genuinely bad correspondence, then drop.
                cd.fails = (cd.fails || 0) + 1
                keep.push(cd)
            }
            // failed gates (classic path): drop - harvest replenishes
        }
        this.candidates = keep
        return promoted
    }

    /**
     * MUST run every frame the poster pose is available (it is the metric
     * ground truth): drop map points whose reprojection has drifted (KLT
     * chains have no re-anchoring) and RE-TRIANGULATE survivors once the
     * baseline since their anchor has grown (sigma_Z ~ 1/b - early
     * promotions carry the worst depths of their lifetime).
     */
    refineAndCull(K, R, t, cullPx) {
        const G = this.G
        const c = this.cfg
        cullPx = cullPx || 4.0
        const reprojGate = Math.max(1.5, cullPx * 0.625)
        const Cnow = G.invertRT(R, t).t
        this._refineBudget = 8   // DLT calls per pass (amortized round-robin)

        const kept = []
        for (const p of this.points) {
            const proj = G.project(K, R, t, p.X)
            if (proj[2] < c.triMinDepth) continue
            const res = Math.hypot(proj[0] - p.u, proj[1] - p.v)

            // bootstrapV2: a just-promoted point carries the worst depth of
            // its lifetime (sigma_Z ~ 1/baseline) - its residual WILL exceed
            // the cull gate transiently under noise before refinement fixes
            // it. Give young points cull immunity below the catastrophic
            // bound instead of executing them in their first frames.
            if (c.bootstrapV2) p.obs = (p.obs || 0) + 1
            const young = c.bootstrapV2 && (p.obs || 0) < 8

            // Revived (relocalized) points have no anchor lineage: they can
            // be culled by residual but never re-triangulated.
            if (!p.R0) {
                if (res <= cullPx) kept.push(p)
                else if (p.desc) this.dormant.push({ X: p.X, desc: p.desc, age: 0 })
                continue
            }

            const C0 = G.invertRT(p.R0, p.t0).t
            const b = Math.hypot(Cnow[0] - C0[0], Cnow[1] - C0[1], Cnow[2] - C0[2])

            // ORDER MATTERS: a growing residual is mostly a DEPTH error
            // becoming visible as the baseline grows (dpx ~ f*b*dZ/Z^2), and
            // the same growth is what makes re-triangulation BETTER. So:
            // refine first; drop only what refinement cannot explain
            // (those are LK drifters / moving objects).
            // DLT refinements are amortized (round-robin budget per call):
            // a refinement deferred one frame is still a refinement, but
            // unbounded refinement made detect frames the p95 class.
            const wantRefine = (res > cullPx || b > p.b0 * 1.5) && this._refineBudget > 0
            if (wantRefine && b > p.b0 * 1.05) {
                this._refineBudget--
                const r = G.triangulateDLT(K, p.R0, p.t0, p.u0, p.v0, R, t, p.u, p.v)
                if (r &&
                    r.depth1 > c.triMinDepth && r.depth2 > c.triMinDepth &&
                    r.depth1 < c.triMaxDepth && r.depth2 < c.triMaxDepth &&
                    r.err1 < reprojGate && r.err2 < reprojGate) {
                    p.X = r.X
                    p.b0 = b
                    kept.push(p)
                    continue
                }
                if (res > cullPx) {
                    // refinement failed AND residual high: drop - unless the
                    // point is young and the residual is sub-catastrophic
                    if (young && res <= cullPx * 2) { kept.push(p); continue }
                    continue
                }
                kept.push(p)                // refinement failed but point still consistent
                continue
            }

            if (res > cullPx) {
                if (young && res <= cullPx * 2) { kept.push(p); continue }
                // Refinement-eligible but budget-starved: DEFER (keep for
                // the next pass) - never cull a point that refinement might
                // explain. Only drop when no new baseline exists at all.
                if (b > p.b0 * 1.05 && this._refineBudget <= 0) { kept.push(p); continue }
                continue
            }
            kept.push(p)
        }
        const culled = this.points.length - kept.length
        this.points = kept
        return culled
    }

    /**
     * The relocalizable subset: every point (tracked or dormant) that has a
     * descriptor. Returns flat arrays ready for the SIMD matcher + GN.
     */
    relocSet() {
        const entries = []
        for (const p of this.points) if (p.desc) entries.push(p)
        for (const d of this.dormant) entries.push(d)
        const n = entries.length
        if (!n) return null
        const pts3 = new Float64Array(n * 3)
        const desc = new Uint8Array(n * 32)
        for (let i = 0; i < n; i++) {
            pts3[i * 3] = entries[i].X[0]
            pts3[i * 3 + 1] = entries[i].X[1]
            pts3[i * 3 + 2] = entries[i].X[2]
            desc.set(entries[i].desc, i * 32)
        }
        return { n, pts3, desc, entries }
    }

    /**
     * Relocalization succeeded: revive the GN-inlier points as TRACKED with
     * their matched scene positions; everything else stays/goes dormant.
     * @param entries   relocSet().entries
     * @param matchQ    per-match map index (into entries)
     * @param matchPos  per-match scene position [u, v]
     * @param inliers   Uint8Array over matches from motionOnlyGN
     */
    relocApply(entries, matchQ, matchPos, inliers) {
        const revived = []
        const used = new Set()
        for (let m = 0; m < matchQ.length; m++) {
            if (!inliers[m]) continue
            const e = entries[matchQ[m]]
            if (used.has(e)) continue
            used.add(e)
            revived.push({
                X: e.X, u: matchPos[m * 2], v: matchPos[m * 2 + 1],
                desc: e.desc,
                // fresh anchor lineage: refinement restarts from here
                u0: matchPos[m * 2], v0: matchPos[m * 2 + 1],
                R0: null, t0: null, b0: Infinity
            })
        }
        const dormant = []
        for (const p of this.points) {
            if (!used.has(p) && p.desc) dormant.push({ X: p.X, desc: p.desc, age: 0 })
        }
        for (const d of this.dormant) {
            if (!used.has(d)) dormant.push(d)
        }
        this.points = revived
        this.dormant = dormant
        this.candidates.length = 0
        this._capDormant()
        return revived.length
    }

    /** Age out stale dormant points (call once per frame). */
    tickDormant() {
        if (!this.dormant.length) return
        const maxAge = this.cfg.dormantMaxAge
        this.dormant = this.dormant.filter(d => ++d.age <= maxAge)
    }

    /**
     * Pose from the map alone (poster not visible): robust motion-only GN
     * from the prior. GN outliers are removed from the map (LK drifters).
     * @returns {ok, R, t, nInliers, meanErr, nTracked}
     */
    solvePose(K, priorR, priorT) {
        const N = this.points.length
        if (N < 6) return { ok: false, nTracked: N }

        const pts3 = new Float64Array(N * 3)
        const pts2 = new Float64Array(N * 2)
        for (let i = 0; i < N; i++) {
            const p = this.points[i]
            pts3[i * 3] = p.X[0]; pts3[i * 3 + 1] = p.X[1]; pts3[i * 3 + 2] = p.X[2]
            pts2[i * 2] = p.u; pts2[i * 2 + 1] = p.v
        }

        const res = this.G.motionOnlyGN(K, priorR, priorT, pts3, pts2, {
            huberPx: this.cfg.mapHuberPx,
            outlierPx: this.cfg.mapOutlierPx
        })

        // NOTE: no purging here. The caller validates the pose (jump gate
        // etc.) and calls purgeOutliers() only on ACCEPTED poses - purging
        // against a rejected pose would shred a healthy map.
        return {
            ok: res.ok, R: res.R, t: res.t, inliers: res.inliers,
            nInliers: res.nInliers, meanErr: res.meanErr, nTracked: N
        }
    }

    /** Drop the GN outliers of an ACCEPTED pose (LK drifters get worse, not better). */
    purgeOutliers(inliers) {
        const kept = []
        for (let i = 0; i < this.points.length; i++) {
            if (i < inliers.length && inliers[i]) kept.push(this.points[i])
        }
        this.points = kept
    }
}

function pointInQuad(u, v, quad) {
    // convex quad, consistent winding: all cross products share a sign
    let sign = 0
    for (let i = 0; i < 4; i++) {
        const a = quad[i], b = quad[(i + 1) % 4]
        const cr = (b[0] - a[0]) * (v - a[1]) - (b[1] - a[1]) * (u - a[0])
        const s = cr > 0 ? 1 : cr < 0 ? -1 : 0
        if (s === 0) continue
        if (sign === 0) sign = s
        else if (s !== sign) return false
    }
    return true
}

// Exports: worker global + window + Node
if (typeof self !== 'undefined') { self.EnvMap = EnvMap; self.pointInQuad = pointInQuad }
if (typeof window !== 'undefined') { window.EnvMap = EnvMap }
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { EnvMap, pointInQuad, ENV_MAP_DEFAULTS }
}
