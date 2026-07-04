/**
 * WebAR SDK - Geometry core for marker-bootstrapped visual odometry (M1)
 *
 * Pure math, zero dependencies (no cv, no THREE) so every routine is
 * verifiable in Node against synthetic ground truth (tests/test_geometry.js).
 *
 * CONVENTIONS (OpenCV throughout):
 * - World frame = the poster frame used by the pipeline: X right, Y DOWN,
 *   Z out of the poster *away* from the viewer-side; poses are T_cw
 *   (world -> camera): Pc = R*Pw + t.
 * - Rotations R are row-major Array(9). Vectors are Array(3).
 * - Pixels: u = fx*X/Z + cx, v = fy*Y/Z + cy.
 *
 * Contents:
 *   rodrigues(w)            axis-angle (3) -> R           R = exp([w]x)
 *   se3Exp(xi)              twist (6: [rho, omega]) -> {R, t}
 *   composeRT / invertRT    SE(3) composition / inverse
 *   triangulateDLT          two-view homogeneous DLT via 4x4 Jacobi eigen
 *   rayAngleDeg             parallax angle between two observations
 *   motionOnlyGN            robust pose refinement on SE(3)
 *                           (Gauss-Newton, Huber, hard outlier rejection)
 */

// ---------------- small linear algebra ----------------

function matMul3(a, b) {
    const r = new Array(9)
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
    return r
}

function matVec3(a, v) {
    return [
        a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
        a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
        a[6] * v[0] + a[7] * v[1] + a[8] * v[2]
    ]
}

function matTVec3(a, v) {  // a^T * v
    return [
        a[0] * v[0] + a[3] * v[1] + a[6] * v[2],
        a[1] * v[0] + a[4] * v[1] + a[7] * v[2],
        a[2] * v[0] + a[5] * v[1] + a[8] * v[2]
    ]
}

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
function norm(a) { return Math.hypot(a[0], a[1], a[2]) }
function normalize(a) {
    const n = norm(a)
    return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0]
}

function skew(w) {
    return [0, -w[2], w[1], w[2], 0, -w[0], -w[1], w[0], 0]
}

// ---------------- Lie group ops ----------------

/** Axis-angle (3) -> rotation matrix. R = I + sin/θ [w]x + (1-cos)/θ² [w]x². */
function rodrigues(w) {
    const th = norm(w)
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    if (th < 1e-12) return I
    const K = skew(w)
    const K2 = matMul3(K, K)
    const a = Math.sin(th) / th
    const b = (1 - Math.cos(th)) / (th * th)
    const R = new Array(9)
    for (let i = 0; i < 9; i++) R[i] = I[i] + a * K[i] + b * K2[i]
    return R
}

/** SE(3) exponential: twist [rho(3), omega(3)] -> {R, t}. t = V·rho. */
function se3Exp(xi) {
    const rho = [xi[0], xi[1], xi[2]]
    const w = [xi[3], xi[4], xi[5]]
    const th = norm(w)
    const R = rodrigues(w)
    let V
    if (th < 1e-9) {
        V = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    } else {
        const K = skew(w)
        const K2 = matMul3(K, K)
        const b = (1 - Math.cos(th)) / (th * th)
        const c = (th - Math.sin(th)) / (th * th * th)
        V = new Array(9)
        const I = [1, 0, 0, 0, 1, 0, 0, 0, 1]
        for (let i = 0; i < 9; i++) V[i] = I[i] + b * K[i] + c * K2[i]
    }
    return { R, t: matVec3(V, rho) }
}

/** (Ra,ta) ∘ (Rb,tb): first apply b, then a. */
function composeRT(Ra, ta, Rb, tb) {
    return { R: matMul3(Ra, Rb), t: addV(matVec3(Ra, tb), ta) }
}

function invertRT(R, t) {
    const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]
    const ti = matVec3(Rt, t)
    return { R: Rt, t: [-ti[0], -ti[1], -ti[2]] }
}

function addV(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }

// ---------------- projection ----------------

/** Project world point with T_cw=(R,t). Returns [u, v, depthZ]. */
function project(K, R, t, X) {
    const P = addV(matVec3(R, X), t)
    return [K.fx * P[0] / P[2] + K.cx, K.fy * P[1] / P[2] + K.cy, P[2]]
}

/** Pixel -> normalized camera ray (unit), then rotated into world. */
function bearingWorld(K, R, u, v) {
    const r = normalize([(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1])
    return matTVec3(R, r)  // R^T: cam -> world direction
}

/** Parallax between two observations of the same point (degrees). */
function rayAngleDeg(K, R1, u1, v1, R2, u2, v2) {
    const f1 = bearingWorld(K, R1, u1, v1)
    const f2 = bearingWorld(K, R2, u2, v2)
    const c = Math.max(-1, Math.min(1, dot(f1, f2)))
    return Math.acos(c) * 180 / Math.PI
}

// ---------------- symmetric eigen (4x4, Jacobi) ----------------

/** Eigen-decomposition of a symmetric n x n matrix via cyclic Jacobi.
 *  Returns {values: Array(n), vectors: Array(n) of Array(n) columns}. */
function jacobiEigenSym(A0, n) {
    const A = A0.slice()
    const V = new Array(n * n).fill(0)
    for (let i = 0; i < n; i++) V[i * n + i] = 1

    for (let sweep = 0; sweep < 50; sweep++) {
        let off = 0
        for (let p = 0; p < n - 1; p++)
            for (let q = p + 1; q < n; q++) off += A[p * n + q] * A[p * n + q]
        if (off < 1e-22) break

        for (let p = 0; p < n - 1; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = A[p * n + q]
                if (Math.abs(apq) < 1e-15) continue
                const app = A[p * n + p], aqq = A[q * n + q]
                const theta = (aqq - app) / (2 * apq)
                const tSign = theta >= 0 ? 1 : -1
                const tTan = tSign / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
                const c = 1 / Math.sqrt(tTan * tTan + 1)
                const s = tTan * c

                for (let k = 0; k < n; k++) {
                    const akp = A[k * n + p], akq = A[k * n + q]
                    A[k * n + p] = c * akp - s * akq
                    A[k * n + q] = s * akp + c * akq
                }
                for (let k = 0; k < n; k++) {
                    const apk = A[p * n + k], aqk = A[q * n + k]
                    A[p * n + k] = c * apk - s * aqk
                    A[q * n + k] = s * apk + c * aqk
                }
                for (let k = 0; k < n; k++) {
                    const vkp = V[k * n + p], vkq = V[k * n + q]
                    V[k * n + p] = c * vkp - s * vkq
                    V[k * n + q] = s * vkp + c * vkq
                }
            }
        }
    }
    const values = new Array(n)
    const vectors = new Array(n)
    for (let i = 0; i < n; i++) {
        values[i] = A[i * n + i]
        const col = new Array(n)
        for (let k = 0; k < n; k++) col[k] = V[k * n + i]
        vectors[i] = col
    }
    return { values, vectors }
}

// ---------------- triangulation ----------------

/**
 * Two-view DLT triangulation.
 * Rows of A: u·P[2,:] − P[0,:] and v·P[2,:] − P[1,:] per view (P = K[R|t]);
 * the solution is the eigenvector of AᵀA with the smallest eigenvalue
 * (homogeneous least squares).
 *
 * @returns {X: [x,y,z], depth1, depth2, err1, err2} or null (degenerate)
 */
function triangulateDLT(K, R1, t1, u1, v1, R2, t2, u2, v2) {
    // P = K [R | t] rows
    function projRows(R, t) {
        const p0 = [K.fx * R[0] + K.cx * R[6], K.fx * R[1] + K.cx * R[7], K.fx * R[2] + K.cx * R[8],
                    K.fx * t[0] + K.cx * t[2]]
        const p1 = [K.fy * R[3] + K.cy * R[6], K.fy * R[4] + K.cy * R[7], K.fy * R[5] + K.cy * R[8],
                    K.fy * t[1] + K.cy * t[2]]
        const p2 = [R[6], R[7], R[8], t[2]]
        return [p0, p1, p2]
    }
    const Pa = projRows(R1, t1)
    const Pb = projRows(R2, t2)

    const rows = [
        [u1 * Pa[2][0] - Pa[0][0], u1 * Pa[2][1] - Pa[0][1], u1 * Pa[2][2] - Pa[0][2], u1 * Pa[2][3] - Pa[0][3]],
        [v1 * Pa[2][0] - Pa[1][0], v1 * Pa[2][1] - Pa[1][1], v1 * Pa[2][2] - Pa[1][2], v1 * Pa[2][3] - Pa[1][3]],
        [u2 * Pb[2][0] - Pb[0][0], u2 * Pb[2][1] - Pb[0][1], u2 * Pb[2][2] - Pb[0][2], u2 * Pb[2][3] - Pb[0][3]],
        [v2 * Pb[2][0] - Pb[1][0], v2 * Pb[2][1] - Pb[1][1], v2 * Pb[2][2] - Pb[1][2], v2 * Pb[2][3] - Pb[1][3]]
    ]

    // AtA (4x4 symmetric)
    const AtA = new Array(16).fill(0)
    for (const r of rows)
        for (let i = 0; i < 4; i++)
            for (let j = 0; j < 4; j++)
                AtA[i * 4 + j] += r[i] * r[j]

    const eig = jacobiEigenSym(AtA, 4)
    let minI = 0
    for (let i = 1; i < 4; i++) if (eig.values[i] < eig.values[minI]) minI = i
    const h = eig.vectors[minI]
    if (Math.abs(h[3]) < 1e-12) return null
    const X = [h[0] / h[3], h[1] / h[3], h[2] / h[3]]

    const a = project(K, R1, t1, X)
    const b = project(K, R2, t2, X)
    return {
        X,
        depth1: a[2], depth2: b[2],
        err1: Math.hypot(a[0] - u1, a[1] - v1),
        err2: Math.hypot(b[0] - u2, b[1] - v2)
    }
}

// ---------------- robust motion-only pose refinement ----------------

/**
 * Robust pose refinement: minimize over T_cw ∈ SE(3)
 *     Σ ρ_Huber( || π(K (R Xᵢ + t)) − xᵢ ||² )
 * by Gauss-Newton with left-multiplied increments T ← exp(δξ^)·T.
 * Reprojection Jacobian: ∂e/∂ξ = J_π · [ I₃ | −[P_c]ₓ ].
 *
 * @param K       {fx, fy, cx, cy}
 * @param R0, t0  prior pose (T_cw)
 * @param pts3    Float-array-like, 3N world points
 * @param pts2    Float-array-like, 2N pixel observations
 * @param opts    {iterations=6, huberPx=2.0, outlierPx=4.0, minDepth=0.05}
 * @returns {R, t, inliers: Uint8Array(N), nInliers, meanErr, ok}
 */
function motionOnlyGN(K, R0, t0, pts3, pts2, opts) {
    opts = opts || {}
    const iterations = opts.iterations || 6
    const huber = opts.huberPx || 2.0
    const outlierPx = opts.outlierPx || 4.0
    const minDepth = opts.minDepth || 0.05

    const N = pts2.length / 2
    let R = R0.slice(), t = t0.slice()
    const active = new Uint8Array(N).fill(1)

    const H = new Array(36)
    const g = new Array(6)
    const J = new Array(12)  // 2x6 row-major

    for (let it = 0; it < iterations; it++) {
        H.fill(0); g.fill(0)
        let used = 0

        for (let i = 0; i < N; i++) {
            if (!active[i]) continue
            const X = [pts3[i * 3], pts3[i * 3 + 1], pts3[i * 3 + 2]]
            const P = addV(matVec3(R, X), t)
            if (P[2] < minDepth) { active[i] = 0; continue }

            const iz = 1 / P[2]
            const u = K.fx * P[0] * iz + K.cx
            const v = K.fy * P[1] * iz + K.cy
            const ex = u - pts2[i * 2]
            const ey = v - pts2[i * 2 + 1]
            const e = Math.hypot(ex, ey)

            // After the first iteration, drop gross outliers entirely so a
            // contaminated correspondence cannot bias subsequent steps.
            if (it > 0 && e > outlierPx * 2.5) { active[i] = 0; continue }

            const w = e <= huber ? 1 : huber / e   // Huber IRLS weight

            // J_pi (2x3) composed with [I | -[P]x] -> 2x6
            const fxiz = K.fx * iz, fyiz = K.fy * iz
            const x = P[0], y = P[1]
            // translation part (d e / d rho)
            J[0] = fxiz;      J[1] = 0;          J[2] = -fxiz * x * iz
            J[6] = 0;         J[7] = fyiz;       J[8] = -fyiz * y * iz
            // rotation part (d e / d omega) = J_pi * (-[P]x)
            J[3] = J[1] * -P[2] - J[2] * -P[1]
            J[4] = J[2] * -P[0] - J[0] * -P[2]
            J[5] = J[0] * -P[1] - J[1] * -P[0]
            J[9] = J[7] * -P[2] - J[8] * -P[1]
            J[10] = J[8] * -P[0] - J[6] * -P[2]
            J[11] = J[6] * -P[1] - J[7] * -P[0]

            for (let r = 0; r < 6; r++) {
                for (let c = r; c < 6; c++) {
                    H[r * 6 + c] += w * (J[r] * J[c] + J[6 + r] * J[6 + c])
                }
                g[r] += w * (J[r] * ex + J[6 + r] * ey)
            }
            used++
        }

        if (used < 6) return { R, t, inliers: active, nInliers: 0, meanErr: Infinity, ok: false }

        // symmetrize + Levenberg damping for safety
        for (let r = 0; r < 6; r++) {
            for (let c = 0; c < r; c++) H[r * 6 + c] = H[c * 6 + r]
            H[r * 6 + r] *= 1.0001
            H[r * 6 + r] += 1e-9
        }

        const delta = solveCholesky6(H, g)
        if (!delta) break
        for (let k = 0; k < 6; k++) delta[k] = -delta[k]

        const inc = se3Exp(delta)
        const next = composeRT(inc.R, inc.t, R, t)
        R = next.R; t = next.t

        if (Math.hypot(delta[0], delta[1], delta[2], delta[3], delta[4], delta[5]) < 1e-7) break
    }

    // final classification
    let nIn = 0, errSum = 0
    const inliers = new Uint8Array(N)
    for (let i = 0; i < N; i++) {
        const X = [pts3[i * 3], pts3[i * 3 + 1], pts3[i * 3 + 2]]
        const P = addV(matVec3(R, X), t)
        if (P[2] < minDepth) continue
        const u = K.fx * P[0] / P[2] + K.cx
        const v = K.fy * P[1] / P[2] + K.cy
        const e = Math.hypot(u - pts2[i * 2], v - pts2[i * 2 + 1])
        if (e < outlierPx) { inliers[i] = 1; nIn++; errSum += e }
    }

    return {
        R, t, inliers, nInliers: nIn,
        meanErr: nIn ? errSum / nIn : Infinity,
        ok: nIn >= 6
    }
}

/** Solve H x = g for symmetric positive-definite 6x6 H (Cholesky). */
function solveCholesky6(H, g) {
    const L = new Array(36).fill(0)
    for (let i = 0; i < 6; i++) {
        for (let j = 0; j <= i; j++) {
            let s = H[i * 6 + j]
            for (let k = 0; k < j; k++) s -= L[i * 6 + k] * L[j * 6 + k]
            if (i === j) {
                if (s <= 0) return null
                L[i * 6 + i] = Math.sqrt(s)
            } else {
                L[i * 6 + j] = s / L[j * 6 + j]
            }
        }
    }
    // forward, then backward substitution
    const y = new Array(6)
    for (let i = 0; i < 6; i++) {
        let s = g[i]
        for (let k = 0; k < i; k++) s -= L[i * 6 + k] * y[k]
        y[i] = s / L[i * 6 + i]
    }
    const x = new Array(6)
    for (let i = 5; i >= 0; i--) {
        let s = y[i]
        for (let k = i + 1; k < 6; k++) s -= L[k * 6 + i] * x[k]
        x[i] = s / L[i * 6 + i]
    }
    return x
}

const Geometry = {
    rodrigues, se3Exp, composeRT, invertRT,
    matMul3, matVec3, matTVec3, cross, dot, norm, normalize,
    project, bearingWorld, rayAngleDeg,
    jacobiEigenSym, triangulateDLT, motionOnlyGN, solveCholesky6
}

// Exports: worker global + window + Node
if (typeof self !== 'undefined') self.Geometry = Geometry
if (typeof window !== 'undefined') window.Geometry = Geometry
if (typeof module !== 'undefined' && module.exports) module.exports = Geometry
