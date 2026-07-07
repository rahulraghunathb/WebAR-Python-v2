/**
 * WebAR SDK - Fusion Engine (Phase 2)
 *
 * Latency-compensated vision + IMU fusion. The IMU drives orientation at
 * render rate (60Hz); vision poses (30-60Hz, 30-80ms stale) arrive as
 * asynchronous corrections applied AT THEIR CAPTURE TIME via a state-history
 * ring buffer, then re-propagated. Corrections are absorbed smoothly as
 * error feedback, so they never fight the IMU prediction.
 *
 * DESIGN (error-state complementary filter, deliberately not a full EKF):
 * - Web sensors expose no gyro bias, no hardware timestamps and no accel
 *   calibration, so EKF covariance would model noise we cannot observe.
 *   Fixed-gain error feedback with latency compensation is what actually
 *   converges on this stack.
 * - ROTATION: q propagates by body-frame IMU deltas each tick
 *   (q ∘ inv(imuPrev) ∘ imuNow). Vision innovation is computed against the
 *   historical state at capture time and bled in with time-constant tauRot.
 * - TRANSLATION: constant-velocity model (p += v dt, v decays). Velocity is
 *   estimated from consecutive vision poses - the accelerometer is NOT
 *   integrated (double integration of uncalibrated web accel data is noise
 *   amplification, verified in Phase 1).
 * - Reference frames: only IMU *deltas* are used, so any constant world
 *   offset between the device-orientation frame and the vision frame
 *   cancels exactly. The device->camera mounting conjugation is a known
 *   second-order approximation (deltas between corrections are < a few
 *   degrees, residual absorbed by the next correction).
 *
 * Zero dependencies (own quaternion math) - runs in the browser and in Node
 * (see tests/test_fusion.js for the ground-truth simulation harness).
 */

// ---------------- minimal quaternion / vec3 math ----------------
// Quaternions are {x,y,z,w}, Hamilton convention, local->world.

const QMath = {
    identity() { return { x: 0, y: 0, z: 0, w: 1 } },

    multiply(a, b) {
        return {
            x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
            w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
        }
    },

    conjugate(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w } },

    normalize(q) {
        const n = Math.hypot(q.x, q.y, q.z, q.w)
        if (n < 1e-12) return QMath.identity()
        return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n }
    },

    /** Robust slerp (shortest path, lerp fallback near 0 angle). */
    slerp(a, b, t) {
        let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
        let bx = b.x, by = b.y, bz = b.z, bw = b.w
        if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw }
        if (dot > 0.9995) {
            return QMath.normalize({
                x: a.x + (bx - a.x) * t,
                y: a.y + (by - a.y) * t,
                z: a.z + (bz - a.z) * t,
                w: a.w + (bw - a.w) * t
            })
        }
        const th = Math.acos(Math.min(1, dot))
        const s = Math.sin(th)
        const wa = Math.sin((1 - t) * th) / s
        const wb = Math.sin(t * th) / s
        return {
            x: wa * a.x + wb * bx,
            y: wa * a.y + wb * by,
            z: wa * a.z + wb * bz,
            w: wa * a.w + wb * bw
        }
    },

    /** Rotation angle of q in degrees. */
    angleDeg(q) {
        const w = Math.min(1, Math.abs(q.w))
        return 2 * Math.acos(w) * 180 / Math.PI
    },

    /** Rotation vector (axis*angle, rad) of a unit quaternion. */
    toRotVec(q) {
        // shortest arc: flip to positive w hemisphere
        const s = q.w < 0 ? -1 : 1
        const x = q.x * s, y = q.y * s, z = q.z * s, w = Math.min(1, q.w * s)
        const vn = Math.hypot(x, y, z)
        if (vn < 1e-9) return { x: 0, y: 0, z: 0 }
        const angle = 2 * Math.atan2(vn, w)
        const k = angle / vn
        return { x: x * k, y: y * k, z: z * k }
    },

    /** Unit quaternion from a rotation vector (axis*angle, rad). */
    fromRotVec(v) {
        const angle = Math.hypot(v.x, v.y, v.z)
        if (angle < 1e-9) return { x: 0, y: 0, z: 0, w: 1 }
        const s = Math.sin(angle / 2) / angle
        return { x: v.x * s, y: v.y * s, z: v.z * s, w: Math.cos(angle / 2) }
    },

    /** Quaternion from a column-major 4x4 (rotation part must be orthonormal). */
    fromMatrixColMajor(m) {
        // Column-major: m[0],m[1],m[2] = first column, etc.
        const r00 = m[0], r10 = m[1], r20 = m[2]
        const r01 = m[4], r11 = m[5], r21 = m[6]
        const r02 = m[8], r12 = m[9], r22 = m[10]
        const tr = r00 + r11 + r22
        let q
        if (tr > 0) {
            const s = Math.sqrt(tr + 1) * 2
            q = { w: s / 4, x: (r21 - r12) / s, y: (r02 - r20) / s, z: (r10 - r01) / s }
        } else if (r00 > r11 && r00 > r22) {
            const s = Math.sqrt(1 + r00 - r11 - r22) * 2
            q = { w: (r21 - r12) / s, x: s / 4, y: (r01 + r10) / s, z: (r02 + r20) / s }
        } else if (r11 > r22) {
            const s = Math.sqrt(1 + r11 - r00 - r22) * 2
            q = { w: (r02 - r20) / s, x: (r01 + r10) / s, y: s / 4, z: (r12 + r21) / s }
        } else {
            const s = Math.sqrt(1 + r22 - r00 - r11) * 2
            q = { w: (r10 - r01) / s, x: (r02 + r20) / s, y: (r12 + r21) / s, z: s / 4 }
        }
        return QMath.normalize(q)
    }
}

const FUSION_DEFAULTS = {
    // --- PREDICTIVE MODE (v2, 2026-07-04 latency round) ---
    // The classic filter smooths TOWARD stale measurements: during motion
    // the on-screen pose lags by (pose age + tau) x velocity. Predictive
    // mode estimates BODY ANGULAR VELOCITY FROM VISION (no IMU needed),
    // dead-reckons rotation between corrections exactly like the removed
    // IMU path did, and absorbs corrections with much tighter taus - the
    // motion model, not the lag, provides the smoothness.
    predictive: true,      // default ON (paired sweep: fused error + rot p90
                           // improve or tie on every trajectory; set false
                           // for the classic lag-smoothing behavior)
    wTau: 0.15,            // s - angular-velocity estimator time constant
    wDecayTau: 0.30,       // s - w decay during vision gaps
    maxW: 4.0,             // rad/s clamp (hand-held rotation bound)
    tauRotP: 0.04,         // s - rotation correction tau in predictive mode
    tauPosP: 0.02,         // s - position correction tau in predictive mode
    velTauP: 0.06,         // s - velocity estimator tau in predictive mode
    velDecayTauP: 0.18,    // s - faster dropout decay: the tighter predictor
                           // carries more velocity into a dropout, so it must
                           // bleed it sooner to stay inside the coast bound

    tauRot: 0.10,          // s - rotation correction time constant
    tauPos: 0.03,          // s - position correction time constant
    velTau: 0.10,          // s - velocity estimator time constant (rate-independent
                           // bandwidth: gain per update = (1-exp(-dt/velTau))/dt)
                           // Tuned via tests/test_fusion.js sweep: best position
                           // RMS at 12/30/60Hz vision AND best dropout coasting.
    velDecayTau: 0.30,     // s - velocity decay during vision gaps
    velDecayAfterMs: 150,  // start decaying only when vision goes quiet -
                           // decay exists for dropout coasting, it must not
                           // fight fresh corrections in steady state
    maxVel: 2.0,           // m/s clamp (hand-held motion bound)
    deadReckonMs: 600,     // coast on IMU this long after last vision pose
    historySize: 90,       // state ring buffer (~1.5s at 60Hz)
    snapshotCap: 120,      // max stored per-frame IMU snapshots

    // --- fusionV2: windowed weighted-LSQ velocity ---
    // The incremental (alpha-beta) velocity estimator differentiates
    // consecutive NOISY innovation pairs - its output noise is what
    // dominates fused error over raw (measured 2.08cm fused vs 0.83 raw
    // at 720px). fusionV2 fits v by weighted linear regression over the
    // last velWinN vision positions at their CAPTURE times (recency-
    // weighted, exp(-age/velWinTau)): ~3x less velocity noise at K=5,
    // and irregular correction DELIVERY stops mattering because the fit
    // uses capture timestamps.
    fusionV2: false,       // REJECTED by opt-j (kept for the record): fused
                           // error got WORSE where it was meant to help -
                           // fastpan fusedMedian 1.65->1.93 (4/4 pairs),
                           // slam +0.13. The window fit LAGS real
                           // accelerations (fastpan is sinusoidal; constant
                           // -velocity over a 250ms window is a systematic
                           // bias there), while the incremental estimator
                           // at predictive taus (velTauP 0.06) already has
                           // the bandwidth. Revisit only with an
                           // acceleration term or much shorter windows.
    velWinN: 6,            // history samples in the fit
    velWinTau: 0.10        // s - recency weighting of the fit
}

class FusionEngine {
    constructor(config) {
        this.cfg = Object.assign({}, FUSION_DEFAULTS, config || {})

        // Fused state
        this.q = QMath.identity()       // camera orientation (local->world)
        this.p = { x: 0, y: 0, z: 0 }   // camera position (m)
        this.v = { x: 0, y: 0, z: 0 }   // camera velocity (m/s)
        this.w = { x: 0, y: 0, z: 0 }   // body angular velocity (rad/s),
                                        // estimated FROM VISION (predictive mode)

        // Pending error-state corrections (absorbed over tau)
        this.qErr = QMath.identity()    // local-frame rotation residual
        this.pErr = { x: 0, y: 0, z: 0 }

        // Cumulative position correction already applied. With measurement
        // latency, several measurements are in flight at once; an innovation
        // computed against the bare historical state re-measures error that
        // in-flight corrections are already fixing (overcorrection ->
        // velocity divergence at 30-60Hz vision rates). Innovations are
        // therefore computed against hist + (accumNow - accumAtCapture).
        this.pCorrAccum = { x: 0, y: 0, z: 0 }

        // IMU
        this.imuProvider = null         // object exposing .rawQuaternion / .quaternion / .isActive
        this.imuPrev = null

        // Latency compensation
        this.history = []               // [{t, q, p}]
        this.snapshots = new Map()      // frameId -> {q: imu quat, t: capture time}

        // fusionV2: vision positions at CAPTURE time for the velocity fit
        this._visHist = []              // [{t, x, y, z}]

        // Vision bookkeeping
        this.tracking = false
        this.lastVisionTime = -Infinity
        this.lastVision = null          // {t, p, q}
        this.lastTick = 0
    }

    /** Wire the DeviceMotionManager (or anything with rawQuaternion + isActive). */
    setIMUProvider(provider) {
        this.imuProvider = provider
    }

    /**
     * Record frame `id`'s CAPTURE TIME (and optionally the IMU orientation
     * at that moment). The timestamp drives latency compensation and is
     * valuable even with no IMU at all - pass quat=null in vision-only mode.
     */
    saveSnapshot(id, quat, t) {
        this.snapshots.set(id, {
            q: quat ? { x: quat.x, y: quat.y, z: quat.z, w: quat.w } : null, t
        })
        if (this.snapshots.size > this.cfg.snapshotCap) {
            const first = this.snapshots.keys().next().value
            this.snapshots.delete(first)
        }
    }

    /**
     * Ingest an asynchronous vision pose (SDK 'result' pose object:
     * {matrix (col-major 16), position{x,y,z}, id}).
     */
    pushVisionPose(pose, now) {
        if (!pose || !pose.matrix) return
        now = now !== undefined ? now : performance.now()

        const zq = QMath.fromMatrixColMajor(pose.matrix)
        const zp = { x: pose.position.x, y: pose.position.y, z: pose.position.z }
        if (![zp.x, zp.y, zp.z, zq.x, zq.y, zq.z, zq.w].every(isFinite)) return

        // Capture time: the IMU snapshot timestamp if we have one, else now
        const snap = pose.id !== undefined ? this.snapshots.get(pose.id) : null
        const tc = snap ? snap.t : now
        if (snap) {
            // Drop consumed/older snapshots
            for (const key of this.snapshots.keys()) {
                if (key <= pose.id) this.snapshots.delete(key)
                else break
            }
        }

        if (!this.tracking) {
            // (Re)acquisition: snap the whole state, no glide-in
            this.q = zq
            this.p = Object.assign({}, zp)
            this.v = { x: 0, y: 0, z: 0 }
            this.w = { x: 0, y: 0, z: 0 }
            this.qErr = QMath.identity()
            this.pErr = { x: 0, y: 0, z: 0 }
            this.pCorrAccum = { x: 0, y: 0, z: 0 }
            this.tracking = true
            this.history.length = 0
            this._visHist.length = 0
            this._resyncIMU()
        } else {
            // Innovation against the state we had AT CAPTURE TIME, plus the
            // corrections applied SINCE then (in-flight correction credit)
            const h = this._stateAt(tc)
            // Local-frame rotation residual: inv(q_hist) * z_q
            this.qErr = QMath.multiply(QMath.conjugate(h.q), zq)
            const ca = h.ca || { x: 0, y: 0, z: 0 }
            const r = {
                x: zp.x - h.p.x - (this.pCorrAccum.x - ca.x),
                y: zp.y - h.p.y - (this.pCorrAccum.y - ca.y),
                z: zp.z - h.p.z - (this.pCorrAccum.z - ca.z)
            }

            // Velocity update. fusionV2: weighted linear regression of the
            // last velWinN vision POSITIONS at their CAPTURE times - the
            // incremental estimator below differentiates consecutive noisy
            // innovation pairs and its noise dominates fused error; a
            // windowed fit averages it down (~3x at K=5) and is immune to
            // irregular correction DELIVERY (the fit runs on capture
            // timestamps). Recency weighting keeps bandwidth during real
            // accelerations; a >0.5s hole flushes the window (stale motion
            // must not vote after a dropout).
            if (this.cfg.fusionV2) {
                const c = this.cfg
                const H = this._visHist
                if (H.length && tc - H[H.length - 1].t > 500) H.length = 0
                if (!H.length || tc > H[H.length - 1].t) {
                    H.push({ t: tc, x: zp.x, y: zp.y, z: zp.z })
                    if (H.length > (c.velWinN || 6)) H.shift()
                }
                if (H.length >= 3) {
                    const tauMs = 1000 * (c.velWinTau || 0.1)
                    let sw = 0, st = 0, sx = 0, sy = 0, sz = 0
                    for (const s of H) {
                        const wgt = Math.exp((s.t - tc) / tauMs)
                        sw += wgt; st += wgt * s.t
                        sx += wgt * s.x; sy += wgt * s.y; sz += wgt * s.z
                    }
                    const tb = st / sw, xb = sx / sw, yb = sy / sw, zb = sz / sw
                    let stt = 0, sxt = 0, syt = 0, szt = 0
                    for (const s of H) {
                        const wgt = Math.exp((s.t - tc) / tauMs)
                        const dt_ = (s.t - tb) / 1000
                        stt += wgt * dt_ * dt_
                        sxt += wgt * dt_ * (s.x - xb)
                        syt += wgt * dt_ * (s.y - yb)
                        szt += wgt * dt_ * (s.z - zb)
                    }
                    if (stt > 1e-6) {
                        this.v.x = sxt / stt
                        this.v.y = syt / stt
                        this.v.z = szt / stt
                        const sp = Math.hypot(this.v.x, this.v.y, this.v.z)
                        if (sp > c.maxVel) {
                            const k = c.maxVel / sp
                            this.v.x *= k; this.v.y *= k; this.v.z *= k
                        }
                    }
                }
            } else if (this.lastVision && tc > this.lastVision.t) {
                // Classic: beta term of an alpha-beta filter, driven by the
                // INNOVATION INCREMENT - only error that is NEW since the
                // previous update (raw innovation re-measures un-absorbed
                // error and diverges at high rates). Gain is time-constant
                // based so the estimator bandwidth (~1/velTau) is
                // vision-rate independent.
                const dtc = (tc - this.lastVision.t) / 1000
                if (dtc > 1e-3 && dtc < 0.5) {
                    const c = this.cfg
                    const kv = (1 - Math.exp(-dtc / (c.predictive ? c.velTauP : c.velTau))) / dtc
                    this.v.x += kv * (r.x - this.pErr.x)
                    this.v.y += kv * (r.y - this.pErr.y)
                    this.v.z += kv * (r.z - this.pErr.z)
                    const sp = Math.hypot(this.v.x, this.v.y, this.v.z)
                    if (sp > c.maxVel) {
                        const k = c.maxVel / sp
                        this.v.x *= k; this.v.y *= k; this.v.z *= k
                    }
                }
            }

            this.pErr = r

            // Vision-derived BODY angular velocity (predictive mode): the
            // rotation between consecutive vision quats over their capture
            // interval. This is the dead-reckoning source that replaced the
            // IMU - measured from the same camera, zero extra sensors.
            if (this.cfg.predictive && this.lastVision && tc > this.lastVision.t) {
                const dtw = (tc - this.lastVision.t) / 1000
                if (dtw > 1e-3 && dtw < 0.5) {
                    const dq = QMath.multiply(QMath.conjugate(this.lastVision.q), zq)
                    const rv = QMath.toRotVec(dq)
                    let wx = rv.x / dtw, wy = rv.y / dtw, wz = rv.z / dtw
                    const wm = Math.hypot(wx, wy, wz)
                    if (wm > this.cfg.maxW) {
                        const k = this.cfg.maxW / wm
                        wx *= k; wy *= k; wz *= k
                    }
                    const kw = 1 - Math.exp(-dtw / this.cfg.wTau)
                    this.w.x += kw * (wx - this.w.x)
                    this.w.y += kw * (wy - this.w.y)
                    this.w.z += kw * (wz - this.w.z)
                }
            }
        }

        this.lastVision = { t: tc, p: Object.assign({}, zp), q: zq }
        this.lastVisionTime = now
    }

    /** Vision reported a miss; the dead-reckon window decides actual loss. */
    notifyMiss() { /* intentional no-op: getRenderPose handles timeout */ }

    /**
     * Propagate and return the pose to render NOW.
     * Call once per render frame.
     * @returns {tracking, position{x,y,z}, quaternion{x,y,z,w}}
     */
    getRenderPose(now) {
        now = now !== undefined ? now : performance.now()
        const dt = this.lastTick ? Math.min((now - this.lastTick) / 1000, 0.1) : 0
        this.lastTick = now

        if (!this.tracking) return { tracking: false, position: this.p, quaternion: this.q }

        // Loss check: too long without vision -> stop dead reckoning
        if (now - this.lastVisionTime > this.cfg.deadReckonMs) {
            this.tracking = false
            this.history.length = 0
            this.imuPrev = null
            return { tracking: false, position: this.p, quaternion: this.q }
        }

        if (dt > 0) {
            const c = this.cfg

            // 1. ROTATION PROPAGATION: body-frame IMU delta
            const imuNow = this._imuQuat()
            if (imuNow && this.imuPrev) {
                const delta = QMath.multiply(QMath.conjugate(this.imuPrev), imuNow)
                this.q = QMath.normalize(QMath.multiply(this.q, delta))
            }
            if (imuNow) this.imuPrev = imuNow

            // 1b. PREDICTIVE rotation dead-reckoning from the vision-derived
            // angular velocity - only when no IMU is feeding deltas (never
            // double-integrate). Decays during dropouts like linear velocity.
            if (c.predictive && !imuNow) {
                if (now - this.lastVisionTime > c.velDecayAfterMs) {
                    const dw = Math.exp(-dt / c.wDecayTau)
                    this.w.x *= dw; this.w.y *= dw; this.w.z *= dw
                }
                if (Math.hypot(this.w.x, this.w.y, this.w.z) > 1e-4) {
                    const step = QMath.fromRotVec({
                        x: this.w.x * dt, y: this.w.y * dt, z: this.w.z * dt
                    })
                    this.q = QMath.normalize(QMath.multiply(this.q, step))
                }
            }

            // 2. TRANSLATION PROPAGATION: constant velocity; decay only once
            // vision goes quiet (dropout coasting), never against fresh data
            if (now - this.lastVisionTime > c.velDecayAfterMs) {
                const decay = Math.exp(-dt / (c.predictive ? c.velDecayTauP : c.velDecayTau))
                this.v.x *= decay; this.v.y *= decay; this.v.z *= decay
            }
            this.p.x += this.v.x * dt
            this.p.y += this.v.y * dt
            this.p.z += this.v.z * dt

            // 3. ABSORB CORRECTIONS (error feedback, time-constant based).
            // Predictive mode: much tighter taus - the motion model provides
            // smoothness, so corrections can land almost immediately instead
            // of being bled in (bleeding IS the perceived latency).
            const kr = 1 - Math.exp(-dt / (c.predictive ? c.tauRotP : c.tauRot))
            const kp = 1 - Math.exp(-dt / (c.predictive ? c.tauPosP : c.tauPos))

            const qStep = QMath.slerp(QMath.identity(), this.qErr, kr)
            this.q = QMath.normalize(QMath.multiply(this.q, qStep))
            // Remaining residual: inv(qStep) * qErr
            this.qErr = QMath.multiply(QMath.conjugate(qStep), this.qErr)

            const dpx = this.pErr.x * kp, dpy = this.pErr.y * kp, dpz = this.pErr.z * kp
            this.p.x += dpx; this.pErr.x -= dpx
            this.p.y += dpy; this.pErr.y -= dpy
            this.p.z += dpz; this.pErr.z -= dpz
            this.pCorrAccum.x += dpx
            this.pCorrAccum.y += dpy
            this.pCorrAccum.z += dpz
        }

        // Record state for latency compensation of future corrections
        this.history.push({
            t: now, q: this.q,
            p: Object.assign({}, this.p),
            ca: Object.assign({}, this.pCorrAccum)
        })
        if (this.history.length > this.cfg.historySize) this.history.shift()

        return { tracking: true, position: this.p, quaternion: this.q }
    }

    reset() {
        this.tracking = false
        this.q = QMath.identity()
        this.p = { x: 0, y: 0, z: 0 }
        this.v = { x: 0, y: 0, z: 0 }
        this.w = { x: 0, y: 0, z: 0 }
        this.qErr = QMath.identity()
        this.pErr = { x: 0, y: 0, z: 0 }
        this.pCorrAccum = { x: 0, y: 0, z: 0 }
        this.history.length = 0
        this.snapshots.clear()
        this.lastVision = null
        this.lastVisionTime = -Infinity
        this.imuPrev = null
    }

    // ---------------- internals ----------------

    _imuQuat() {
        const m = this.imuProvider
        if (!m || !m.isActive) return null
        // Listeners attached but no events delivered (sensor-blocking
        // browsers): treat as no IMU rather than a frozen identity signal.
        if (typeof m.hasData === 'function' && !m.hasData()) return null
        const q = m.rawQuaternion || m.quaternion
        return q ? { x: q.x, y: q.y, z: q.z, w: q.w } : null
    }

    _resyncIMU() {
        this.imuPrev = this._imuQuat()
    }

    /** Closest recorded state at time t (falls back to current state). */
    _stateAt(t) {
        const h = this.history
        if (!h.length) return { q: this.q, p: this.p }
        // History is time-ordered; binary search the closest entry
        let lo = 0, hi = h.length - 1
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (h[mid].t < t) lo = mid + 1
            else hi = mid
        }
        if (lo > 0 && Math.abs(h[lo - 1].t - t) < Math.abs(h[lo].t - t)) lo--
        return h[lo]
    }
}

// Exports: browser global + Node (for the simulation test harness)
if (typeof window !== 'undefined') {
    window.FusionEngine = FusionEngine
    window.FusionQMath = QMath
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FusionEngine, QMath, FUSION_DEFAULTS }
}
