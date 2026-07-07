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
                              // relocalizable part of the map. {X, desc, age,
                              // ep: drift-epoch at dormancy time}
        this.candidates = []  // {u0, v0, R0:[9], t0:[3], u, v, age, desc?}
        this._epoch = 0       // bumped by applyDriftCorrection: a dormant
                              // point carries only ITS epoch's drift and must
                              // never be corrected twice
        this.G = (typeof Geometry !== 'undefined') ? Geometry
            : (typeof require !== 'undefined' ? require('./geometry.js') : null)

        // relocV3: keyframe bank snapshots. A strong-poster frame is a
        // GROUND-CONTACT moment - refineAndCull has just verified every
        // tracked point against metric truth - so the bank snapshotted
        // there has trustworthy 3D by construction, unlike the dormant
        // soup whose triangulation history is unverifiable (measured:
        // one-shot reloc against the soup landed anywhere from 2.4 to
        // 109cm depending on the roll). Ring of 3, freshest first.
        this.keyframes = []   // [{f, pts3: Float64Array, desc: Uint8Array, n}]

        // Candidate death ledger (diagnostic, cumulative per map lifetime):
        // lk = lost by KLT, tri = failed triangulation gates terminally,
        // flush = alive-but-immature when the map slept/revived,
        // rot = flushed as poisoned rot-anchors, promo = promoted to points
        this.cd = { lk: 0, tri: 0, flush: 0, rot: 0, promo: 0 }
    }

    size() { return this.points.length }
    candidateCount() { return this.candidates.length }
    dormantCount() { return this.dormant.length }
    relocCount() {
        let n = this.dormant.length
        for (const p of this.points) if (p.desc) n++
        return n
    }

    /**
     * relocV3: snapshot the desc-bearing tracked points (poster-verified
     * THIS frame) as a relocalization keyframe. Deep-copies everything -
     * the live points keep evolving. Skips thin banks (a 5-point keyframe
     * is not reloc capital).
     */
    snapshotKeyframe(frameIdx) {
        const src = this.points.filter(p => p.desc)
        if (src.length < 12) return false
        const pts3 = new Float64Array(src.length * 3)
        const desc = new Uint8Array(src.length * 32)
        for (let i = 0; i < src.length; i++) {
            pts3[i * 3] = src[i].X[0]
            pts3[i * 3 + 1] = src[i].X[1]
            pts3[i * 3 + 2] = src[i].X[2]
            desc.set(src[i].desc, i * 32)
        }
        this.keyframes.unshift({ f: frameIdx, pts3, desc, n: src.length })
        if (this.keyframes.length > 3) this.keyframes.pop()
        return true
    }

    reset() {
        this.keyframes.length = 0
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
            if (p.desc) this.dormant.push({ X: p.X, desc: p.desc, age: 0, ep: this._epoch })
        }
        this.points.length = 0
        this.cd.flush += this.candidates.length
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
                if (p.desc) this.dormant.push({ X: p.X, desc: p.desc, age: 0, ep: this._epoch })
                continue
            }
            p.u = next[i * 2]
            p.v = next[i * 2 + 1]
            keptP.push(p)
        }
        const dropP = this.points.length - keptP.length
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
        const dropC = this.candidates.length - keptC.length
        this.cd.lk += dropC
        this.candidates = keptC
        return { dropP, dropC }
    }

    /**
     * Harvest new candidates from detector keypoints (poster pose known).
     * @param kpts   Float32Array 2N of scene keypoint positions
     * @param quad   4x[x,y] poster corners to exclude (or null)
     * @param R, t   current T_cw
     * @param w, h   frame size (for bucketing)
     * @param geomScale  processing-resolution scale (px gates calibrated at
     *                   480-wide; same PHYSICAL spread at any resolution)
     * @param rotAnchor  anchor pose came from rotation-only tracking: its
     *                   CENTER is frozen/assumed. Valid under true pure
     *                   rotation; if a later absolute fix reveals the center
     *                   actually jumped, these anchors would fake baseline -
     *                   dropRotAnchored() flushes them then.
     * @param trusted    anchor pose is POSTER-verified (metric truth), not
     *                   map-VO (drift-accumulating). Only trusted harvests
     *                   may run the mapDensity2 boost: dense drift-anchored
     *                   geometry outvotes the truth-anchored map in PnP
     *                   consensus and tears it apart (test-slam: 69 pts ->
     *                   0 mid-hold, 50cm median).
     */
    harvest(kpts, quad, R, t, w, h, descBytes, geomScale, rotAnchor, trusted) {
        const c = this.cfg
        const gs = geomScale || 1
        const cellPx = c.harvestCellPx * gs
        // mapDensity2: one extra corner per cell - the SIMD kernel made
        // tracked points cheap enough to run a denser equilibrium. ONLY for
        // trusted (poster-anchored) harvests, never rot-anchored ones (the
        // rot-only lifeline is a tuned 2D flow substrate, not map building),
        // and only once points exist (translation evidence; see pipeline).
        const perCell = c.harvestPerCell +
            ((c.mapDensity2 && trusted && !rotAnchor && this.points.length > 0) ? 1 : 0)
        const room = c.mapMaxCandidates - this.candidates.length
        if (room <= 0) return 0

        // occupancy grid over existing tracked points + accepted candidates
        const cols = Math.max(1, Math.ceil(w / cellPx))
        const rows = Math.max(1, Math.ceil(h / cellPx))
        const occ = new Uint8Array(cols * rows)
        const mark = (u, v) => {
            const ci = Math.min(cols - 1, Math.max(0, Math.floor(u / cellPx)))
            const ri = Math.min(rows - 1, Math.max(0, Math.floor(v / cellPx)))
            occ[ri * cols + ci]++
        }
        for (const p of this.points) mark(p.u, p.v)
        for (const cd of this.candidates) mark(cd.u, cd.v)

        const existing = []
        for (const p of this.points) existing.push(p.u, p.v)
        for (const cd of this.candidates) existing.push(cd.u, cd.v)

        let added = 0
        const minD = c.harvestMinDist * gs
        const minD2 = minD * minD
        for (let i = 0; i < kpts.length / 2 && added < room; i++) {
            const u = kpts[i * 2], v = kpts[i * 2 + 1]
            if (quad && pointInQuad(u, v, quad)) continue

            const ci = Math.min(cols - 1, Math.max(0, Math.floor(u / cellPx)))
            const ri = Math.min(rows - 1, Math.max(0, Math.floor(v / cellPx)))
            if (occ[ri * cols + ci] >= perCell) continue

            let tooClose = false
            for (let k = 0; k < existing.length; k += 2) {
                const dx = existing[k] - u, dy = existing[k + 1] - v
                if (dx * dx + dy * dy < minD2) { tooClose = true; break }
            }
            if (tooClose) continue

            this.candidates.push({
                u0: u, v0: v, R0: R.slice(), t0: t.slice(),
                u, v, age: 0, rotAnchor: !!rotAnchor,
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
        // timeCal: candidate maturity and observation counts are FRAME
        // counts calibrated at 20Hz; _fscale (set by the pipeline each
        // frame) converts them to the current rate
        const fs = c._fscale || 1
        const keep = []
        for (const cd of this.candidates) {
            if (done >= c.triPerFrame || this.points.length + promoted >= c.mapMaxPoints) {
                keep.push(cd)
                continue
            }
            if (cd.age < Math.max(2, Math.round(2 * fs))) { keep.push(cd); continue }

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
                this.cd.promo++
            } else if (c.bootstrapV2 && (cd.fails || 0) < 2) {
                // Under real image noise a single-shot DLT verdict is
                // unreliable, and every retry has MORE baseline (strictly
                // better conditioning). Two strikes with growing baseline =
                // genuinely bad correspondence, then drop.
                cd.fails = (cd.fails || 0) + 1
                keep.push(cd)
            } else {
                this.cd.tri++
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
    refineAndCull(K, R, t, cullPx, noReanchor) {
        const G = this.G
        const c = this.cfg
        cullPx = cullPx || 4.0
        const reprojGate = Math.max(1.5, cullPx * 0.625)
        const Cnow = G.invertRT(R, t).t
        // DLT calls per pass (amortized round-robin). mapDensity2: scale
        // with map size to keep the refine-CYCLE length constant (~5
        // passes) - a dense map on the fixed budget reaches the hold with
        // proportionally more worst-of-lifetime depths unrefined, and an
        // away-walk hold turns that into a purge-fed drift spiral
        // (test-slam: pe 4.7->57cm in 17 frames while purge ate 57->8 pts).
        // noReanchor (edgeGate): the pose is edge/far-biased - it may not
        // REWRITE trusted 3D. Budget 0 disables every DLT re-anchor, and
        // the existing defer path (residual high + baseline grown + no
        // budget -> keep) postpones the associated culls to the next
        // healthy pass; only zero-baseline-growth drifters still die.
        this._refineBudget = noReanchor ? 0 : (c.mapDensity2
            ? Math.max(8, Math.ceil(this.points.length / 5)) : 8)

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
            const young = c.bootstrapV2 && (p.obs || 0) < Math.round(8 * (c._fscale || 1))

            // Revived (relocalized) points have no anchor lineage: they can
            // be culled by residual but never re-triangulated.
            if (!p.R0) {
                if (res <= cullPx) kept.push(p)
                else if (p.desc) this.dormant.push({ X: p.X, desc: p.desc, age: 0, ep: this._epoch })
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
     * Drift back-propagation at poster reacquisition (driftComp): the
     * poster pose is metric truth, and the map pose it just replaced is off
     * by the accumulated VO drift. Previously that error was left IN the
     * map for refineAndCull to execute (measured: 21 points -> 0 within 3
     * frames of a 3-4cm-drift reacquisition - destroying exactly the reloc
     * capital a later loss needs, and a parked camera can never rebuild).
     * Align the map to truth instead: X' = A X with A = T_p^-1 T_m.
     *
     * Points carry UNEQUAL drift (whatever their anchoring pose had), so
     * the rigid snap is applied only where evidence supports it: tracked
     * points move only when the correction reduces reprojection error
     * against their live KLT observation (the same evidence the cull
     * uses), and their anchor lineage moves with them so re-triangulation
     * stays self-consistent. Candidate anchors are corrected
     * unconditionally (candidates are young by construction - they mature
     * or die within frames, so they carry ~the measured end-drift).
     * Dormant points have no observation to test against - corrected
     * unconditionally as the best available estimate; the reloc gates
     * judge them later.
     */
    applyDriftCorrection(K, Rp, tp, Rm, tm) {
        const G = this.G
        const minZ = this.cfg.triMinDepth
        // A = T_p^-1 T_m:  R_A = Rp^T Rm,  t_A = Rp^T (tm - tp)
        const RpT = [Rp[0], Rp[3], Rp[6], Rp[1], Rp[4], Rp[7], Rp[2], Rp[5], Rp[8]]
        const RA = G.matMul3(RpT, Rm)
        const tA = G.matVec3(RpT, [tm[0] - tp[0], tm[1] - tp[1], tm[2] - tp[2]])
        const RAT = [RA[0], RA[3], RA[6], RA[1], RA[4], RA[7], RA[2], RA[5], RA[8]]

        const applyX = (X) => [
            RA[0] * X[0] + RA[1] * X[1] + RA[2] * X[2] + tA[0],
            RA[3] * X[0] + RA[4] * X[1] + RA[5] * X[2] + tA[1],
            RA[6] * X[0] + RA[7] * X[1] + RA[8] * X[2] + tA[2]
        ]
        // anchor pose in the corrected world: T0' = T0 A^-1
        // (R0' = R0 RA^T, t0' = t0 - R0' tA)
        const applyAnchor = (o) => {
            if (!o.R0) return
            const R0n = G.matMul3(o.R0, RAT)
            o.t0 = [
                o.t0[0] - (R0n[0] * tA[0] + R0n[1] * tA[1] + R0n[2] * tA[2]),
                o.t0[1] - (R0n[3] * tA[0] + R0n[4] * tA[1] + R0n[5] * tA[2]),
                o.t0[2] - (R0n[6] * tA[0] + R0n[7] * tA[1] + R0n[8] * tA[2])
            ]
            o.R0 = R0n
        }

        let moved = 0
        for (const p of this.points) {
            const X2 = applyX(p.X)
            const a = G.project(K, Rp, tp, p.X)
            const b = G.project(K, Rp, tp, X2)
            if (b[2] < minZ) continue
            const ea = a[2] < minZ ? Infinity : Math.hypot(a[0] - p.u, a[1] - p.v)
            const eb = Math.hypot(b[0] - p.u, b[1] - p.v)
            if (eb < ea) {
                p.X = X2
                applyAnchor(p)
                moved++
            }
        }
        // Only CURRENT-epoch dormant points carry this stretch's drift; an
        // entry stored before the previous correction was aligned (or
        // corrected) then, and its X has been frozen since - re-applying
        // each new delta would random-walk the bank on revisit-heavy
        // sessions.
        let dorm = 0
        for (const d of this.dormant) {
            if (d.ep === this._epoch) { d.X = applyX(d.X); dorm++ }
        }
        for (const cd of this.candidates) applyAnchor(cd)
        this._epoch++
        return { moved, total: this.points.length, dorm }
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
    relocApply(entries, matchQ, matchPos, inliers, K, R, t, w, h) {
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
        // edgeGate revive-sweep: the ACCEPTED POSE is evidence - the
        // matcher only ever finds a handful of the bank (ratio kills on
        // self-similar texture, descs age), but every dormant whose 3D
        // reprojects cleanly into this verified view is the same map
        // seen from the same place. Revive them at their projections
        // (KLT seeds, same trust model as lkPredictSeed). A wrong reloc
        // is retracted wholesale by probation; a wrong point dies by
        // residual cull. Without this, post-reloc maps start from the
        // matched handful and rebuild is baseline-gated (physics: fresh
        // candidates cannot triangulate inside a short window).
        if (K && R && t && w) {
            const G = this.G
            const mx = 0.04 * w, my = 0.04 * h
            for (const d of this.dormant) {
                if (revived.length >= 48) break
                if (used.has(d)) continue
                const pr = G.project(K, R, t, d.X)
                if (!pr || pr[2] < this.cfg.triMinDepth || pr[2] > this.cfg.triMaxDepth) continue
                if (pr[0] < mx || pr[0] > w - mx || pr[1] < my || pr[1] > h - my) continue
                used.add(d)
                revived.push({
                    X: d.X, u: pr[0], v: pr[1], desc: d.desc,
                    u0: pr[0], v0: pr[1], R0: null, t0: null, b0: Infinity
                })
            }
        }
        const dormant = []
        for (const p of this.points) {
            if (!used.has(p) && p.desc) dormant.push({ X: p.X, desc: p.desc, age: 0, ep: this._epoch })
        }
        for (const d of this.dormant) {
            if (!used.has(d)) dormant.push(d)
        }
        this.points = revived
        this.dormant = dormant
        this.cd.flush += this.candidates.length
        this.candidates.length = 0
        this._capDormant()
        return revived.length
    }

    /**
     * mapDensity2: the poster just left (first map-only frame). The dense
     * candidate inventory was poster-era capital; spending it DURING a hold
     * triangulates against progressively drifting VO poses - late
     * promotions arrive pre-poisoned and outvote the truth-anchored map
     * (measured: test-slam's 47-frame hold died 69->0 pts, 50cm median;
     * probes A vs D proved the candidate STREAM, not map size, is the
     * killer). Trim to the classic low-water so hold-time triangulation
     * matches the stock stream; keep the OLDEST candidates - most parallax
     * accrued, so they mature earliest, while VO drift is still small.
     */
    trimCandidates(n) {
        if (this.candidates.length <= n) return 0
        this.candidates.sort((a, b) => b.age - a.age)
        const cut = this.candidates.length - n
        this.cd.flush += cut
        this.candidates.length = n
        return cut
    }

    /**
     * Rotation-only just ENGAGED: rewrite every candidate's anchor to the
     * freeze pose. Their old anchors carry the pre-freeze slide's phantom
     * baseline (which would poison both triangulation and the translation
     * detector); from here on their anchor rays measure drift SINCE THE
     * FREEZE - zero under true rotation, growing under real translation.
     */
    rebaseCandidates(R, t) {
        for (const cd of this.candidates) {
            cd.u0 = cd.u; cd.v0 = cd.v
            cd.R0 = R.slice(); cd.t0 = t.slice()
            cd.rotAnchor = true
            cd.age = 0
        }
    }

    /**
     * An absolute re-fix revealed that the camera center JUMPED while
     * rotation-only tracking assumed it frozen: every candidate anchored
     * during that stretch would fake (snap-sized) baseline and triangulate
     * garbage depths - which then descend, descriptor-attached, into the
     * dormant bank and poison relocalization. Flush them.
     */
    dropRotAnchored() {
        const before = this.candidates.length
        this.candidates = this.candidates.filter(c => !c.rotAnchor)
        this.cd.rot += before - this.candidates.length
        return before - this.candidates.length
    }

    /** Age out stale dormant points (call once per frame). */
    tickDormant() {
        if (!this.dormant.length) return
        const maxAge = this.cfg.dormantMaxAge * (this.cfg._fscale || 1)
        this.dormant = this.dormant.filter(d => ++d.age <= maxAge)
    }

    /**
     * Pose from the map alone (poster not visible): robust motion-only GN
     * from the prior. GN outliers are removed from the map (LK drifters).
     * @param gateScale  processing-resolution scale for the px gates
     *                   (huber/outlier calibrated at 480-wide: the same
     *                   physical residual spans gateScale x more pixels at
     *                   higher resolution - unscaled, the outlier gate
     *                   mass-executes healthy points and purge shreds the
     *                   map exactly during poster-weak bridge frames)
     * @returns {ok, R, t, nInliers, meanErr, nTracked}
     */
    solvePose(K, priorR, priorT, gateScale) {
        const N = this.points.length
        if (N < 6) return { ok: false, nTracked: N }

        const pts3 = new Float64Array(N * 3)
        const pts2 = new Float64Array(N * 2)
        for (let i = 0; i < N; i++) {
            const p = this.points[i]
            pts3[i * 3] = p.X[0]; pts3[i * 3 + 1] = p.X[1]; pts3[i * 3 + 2] = p.X[2]
            pts2[i * 2] = p.u; pts2[i * 2 + 1] = p.v
        }

        const gs = gateScale || 1
        const res = this.G.motionOnlyGN(K, priorR, priorT, pts3, pts2, {
            huberPx: this.cfg.mapHuberPx * gs,
            outlierPx: this.cfg.mapOutlierPx * gs
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
        // mapDensity2: 3-strike purge. Single-frame purge is the amplifier
        // of the hold-entry bias spiral: a biased prior makes GN outvote the
        // truth-anchored points, instant purge EXECUTES them, and the
        // survivor consensus is more biased yet (measured on test-slam's
        // edge-biased handoff: pe 4.7->57cm in 17 frames, map 57->8). An LK
        // drifter only gets worse - it still dies, 3 frames later; a truth
        // point outvoted by a transient stays to pull the pose back.
        const strikes = (this.cfg.mapDensity2 || this.cfg.purgeStrikes)
            ? Math.max(2, Math.round(3 * (this.cfg._fscale || 1))) : 1
        const kept = []
        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i]
            if (i < inliers.length && inliers[i]) {
                p.pk = 0
                kept.push(p)
            } else if ((p.pk = (p.pk || 0) + 1) < strikes) {
                kept.push(p)
            }
        }
        const purged = this.points.length - kept.length
        this.points = kept
        return purged
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
