/**
 * Fusion Engine simulation harness (Node).
 *
 * Simulates a hand-held camera with ground-truth motion, a 60Hz IMU (with a
 * constant world-frame offset + noise, mimicking deviceorientation's
 * arbitrary reference), and a delayed, noisy, low-rate vision pipeline -
 * then verifies that the fused output beats the zero-order-hold baseline
 * (latest vision pose held until the next one), stays bounded through a
 * vision dropout, and recovers.
 *
 * Run: node tests/test_fusion.js
 */

const { FusionEngine, QMath } = require('../static/sdk/core/fusion.js')

// ---------------- simulation config ----------------
const SIM = {
    durationS: 10,
    renderHz: 60,
    visionHz: Number(process.env.FUSION_VISION_HZ || 12),  // 12 = stress case; ~30 = our measured pipeline rate
    visionLatencyMs: 60,
    rotNoiseDeg: 0.5,        // vision rotation noise (sigma)
    posNoiseM: 0.005,        // vision position noise (sigma)
    imuNoiseDeg: 0.15,       // IMU per-sample noise
    dropoutStartS: 5.0,      // vision blackout window
    dropoutEndS: 5.5
}

// ---------------- ground truth motion ----------------
// Rotation: smooth pan around Y (30 deg/s) + nodding around X.
// Position: hand sway, a few cm in each axis.

function axisAngle(ax, ay, az, deg) {
    const r = deg * Math.PI / 180
    const s = Math.sin(r / 2)
    return QMath.normalize({ x: ax * s, y: ay * s, z: az * s, w: Math.cos(r / 2) })
}

function gtQuat(t) {
    const pan = axisAngle(0, 1, 0, 30 * t)
    const nod = axisAngle(1, 0, 0, 8 * Math.sin(2 * Math.PI * 0.4 * t))
    return QMath.multiply(pan, nod)
}

function gtPos(t) {
    return {
        x: 0.05 * Math.sin(2 * Math.PI * 0.5 * t),
        y: 0.03 * Math.sin(2 * Math.PI * 0.7 * t),
        z: 1.5 + 0.04 * Math.sin(2 * Math.PI * 0.3 * t)
    }
}

// ---------------- noise helpers (deterministic LCG for reproducibility) ----
let seed = 42
function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
}
function gauss(sigma) {
    // Box-Muller
    const u1 = Math.max(rand(), 1e-12), u2 = rand()
    return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}
function noisyQuat(q, sigmaDeg) {
    const n = QMath.multiply(q, axisAngle(
        Math.sin(rand() * 6.28), Math.cos(rand() * 6.28), Math.sin(rand() * 3.14),
        gauss(sigmaDeg)))
    return QMath.normalize(n)
}

// Quaternion -> column-major matrix (rotation only + translation)
function poseMatrix(q, p) {
    const { x, y, z, w } = q
    const m = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
        p.x, p.y, p.z, 1
    ]
    return m
}

function rotErrDeg(a, b) {
    return QMath.angleDeg(QMath.multiply(QMath.conjugate(a), b))
}
function posErrM(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// ---------------- run simulation ----------------

// Constant world-frame offset between the deviceorientation reference and
// the vision/world frame (fusion must be invariant to it: deltas only).
const IMU_OFFSET = axisAngle(0.3, 0.8, 0.52, 73)

// Optional gain overrides for parameter sweeps:
//   FUSION_CFG='{"tauPos":0.05}' node tests/test_fusion.js
const cfgOverride = process.env.FUSION_CFG ? JSON.parse(process.env.FUSION_CFG) : undefined
const fusion = new FusionEngine(cfgOverride)
let imuNow = null
fusion.setIMUProvider({ isActive: true, get rawQuaternion() { return imuNow } })

const renderDt = 1000 / SIM.renderHz
const visionDt = 1000 / SIM.visionHz
const steps = SIM.durationS * SIM.renderHz

let nextCaptureT = 0
let frameId = 0
const inflight = []   // {deliverAt, pose}

const errs = { fusedRot: [], fusedPos: [], zohRot: [], zohPos: [], dropRot: [], dropPos: [] }
let zoh = null        // zero-order-hold baseline: latest delivered vision pose
let nanCount = 0
let reacquired = false

for (let i = 0; i <= steps; i++) {
    const tMs = i * renderDt
    const tS = tMs / 1000

    // --- IMU sample (with constant world offset + noise) ---
    imuNow = noisyQuat(QMath.multiply(IMU_OFFSET, gtQuat(tS)), SIM.imuNoiseDeg)

    // --- vision capture (12Hz, except during dropout) ---
    if (tMs >= nextCaptureT) {
        nextCaptureT += visionDt
        const inDropout = tS >= SIM.dropoutStartS && tS < SIM.dropoutEndS
        if (!inDropout) {
            frameId++
            fusion.saveSnapshot(frameId, imuNow, tMs)
            const zq = noisyQuat(gtQuat(tS), SIM.rotNoiseDeg)
            const zp = gtPos(tS)
            const zpn = { x: zp.x + gauss(SIM.posNoiseM), y: zp.y + gauss(SIM.posNoiseM), z: zp.z + gauss(SIM.posNoiseM) }
            inflight.push({
                deliverAt: tMs + SIM.visionLatencyMs,
                pose: { id: frameId, matrix: poseMatrix(zq, zpn), position: zpn }
            })
        }
    }

    // --- delayed vision delivery ---
    while (inflight.length && inflight[0].deliverAt <= tMs) {
        const { pose } = inflight.shift()
        fusion.pushVisionPose(pose, tMs)
        zoh = pose
    }

    // --- render tick ---
    const out = fusion.getRenderPose(tMs)

    const gq = gtQuat(tS), gp = gtPos(tS)
    if (out.tracking) {
        const re = rotErrDeg(out.quaternion, gq)
        const pe = posErrM(out.position, gp)
        if (!isFinite(re) || !isFinite(pe)) nanCount++

        const inDropoutWindow = tS >= SIM.dropoutStartS && tS < SIM.dropoutEndS + 0.1
        if (inDropoutWindow) {
            errs.dropRot.push(re); errs.dropPos.push(pe)
        } else if (tS > 0.5) {  // skip convergence transient
            errs.fusedRot.push(re); errs.fusedPos.push(pe)
            if (zoh) {
                errs.zohRot.push(rotErrDeg(QMath.fromMatrixColMajor(zoh.matrix), gq))
                errs.zohPos.push(posErrM(zoh.position, gp))
            }
        }
        if (tS > SIM.dropoutEndS + 0.3) reacquired = true
    }
}

// ---------------- report ----------------
const rms = a => a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : NaN
const max = a => a.length ? Math.max(...a) : NaN

const fusedRotRMS = rms(errs.fusedRot), zohRotRMS = rms(errs.zohRot)
const fusedPosRMS = rms(errs.fusedPos), zohPosRMS = rms(errs.zohPos)

console.log(`=== Fusion simulation (10s, 60Hz render, ${SIM.visionHz}Hz vision @${SIM.visionLatencyMs}ms latency, 0.5s dropout) ===`)
console.log(`rotation RMS: fused ${fusedRotRMS.toFixed(3)}°  vs zero-order-hold ${zohRotRMS.toFixed(3)}°`)
console.log(`position RMS: fused ${(fusedPosRMS * 1000).toFixed(1)}mm vs zero-order-hold ${(zohPosRMS * 1000).toFixed(1)}mm`)
console.log(`dropout max:  rot ${max(errs.dropRot).toFixed(2)}°, pos ${(max(errs.dropPos) * 1000).toFixed(1)}mm`)

const checks = []
function check(name, cond, detail) {
    checks.push(cond)
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
}

check('No NaN/Inf in fused output', nanCount === 0)
check('Fused rotation beats zero-order-hold', fusedRotRMS < zohRotRMS,
    `${fusedRotRMS.toFixed(3)}° < ${zohRotRMS.toFixed(3)}°`)
check('Fused position beats zero-order-hold', fusedPosRMS < zohPosRMS,
    `${(fusedPosRMS * 1000).toFixed(1)}mm < ${(zohPosRMS * 1000).toFixed(1)}mm`)
check('Fused rotation RMS < 1.5°', fusedRotRMS < 1.5)
// Rate-dependent regression bar (information content scales with rate;
// "beats zero-order-hold" above is the primary criterion)
const posBarMm = { 12: 17, 30: 13, 60: 11 }[SIM.visionHz] || 17
check(`Fused position RMS < ${posBarMm}mm (regression bar @ ${SIM.visionHz}Hz)`,
    fusedPosRMS * 1000 < posBarMm)
check('Bounded during 0.5s dropout (rot < 6°)', max(errs.dropRot) < 6,
    `${max(errs.dropRot).toFixed(2)}°`)
check('Bounded during 0.5s dropout (pos < 80mm)', max(errs.dropPos) < 0.08,
    `${(max(errs.dropPos) * 1000).toFixed(1)}mm`)
check('Tracking continues after dropout', reacquired)
check('IMU world-frame offset invariance (implicit)', fusedRotRMS < 1.5,
    'IMU frame offset by 73° and fusion still converges')

const passed = checks.filter(Boolean).length
console.log(`========== ${passed}/${checks.length} checks passed ==========`)
process.exit(passed === checks.length ? 0 : 1)
