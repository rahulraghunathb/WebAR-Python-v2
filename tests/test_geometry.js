/**
 * Geometry core verification (M1) - synthetic ground truth, Node.
 *
 * Builds a 3D scene (poster plane + off-plane environment points), a known
 * camera trajectory, projects with a pinhole model, then verifies:
 *  - rotation/SE(3) primitives
 *  - DLT triangulation accuracy + the sigma_Z ~ 1/baseline error law
 *  - cheirality/parallax gating behavior
 *  - robust motion-only GN pose recovery under noise + 20% outliers
 *
 * Run: node tests/test_geometry.js
 */

const G = require('../static/sdk/vision/geometry.js')

const checks = []
function check(name, cond, detail) {
    checks.push(cond)
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
}

// Deterministic noise
let seed = 7
function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
function gauss(s) {
    const u1 = Math.max(rand(), 1e-12), u2 = rand()
    return s * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

const K = { fx: 670, fy: 670, cx: 240, cy: 180 }  // the phone's processing intrinsics

// ---- camera poses: look-at in CV convention (world Y down) ----
function lookAtCV(C, target) {
    const z = G.normalize([target[0] - C[0], target[1] - C[1], target[2] - C[2]])
    let y = [0, 1, 0]  // world "down"
    const proj = G.dot(y, z)
    y = G.normalize([y[0] - proj * z[0], y[1] - proj * z[1], y[2] - proj * z[2]])
    const x = G.normalize(G.cross(y, z))
    const R = [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]
    const t = G.matVec3(R, C).map(v => -v)
    return { R, t }
}

// Cameras on an arc at radius ~1.5m looking at the origin.
// World: poster at z=0 plane (x right, y down, camera side z<0... in our CV
// convention cameras sit at negative? The pipeline has cameras at +Z? In CV,
// camera looks along +Z_cam; poses place cameras at z ~ -1.5 looking toward
// origin. Use z = -1.5 side consistently.
function cameraAt(angleDeg, radius) {
    const a = angleDeg * Math.PI / 180
    const C = [radius * Math.sin(a), -0.05, -radius * Math.cos(a)]
    return Object.assign(lookAtCV(C, [0, 0, 0]), { C })
}

// ---- scene points ----
const points = []
for (let i = 0; i < 20; i++) points.push([(rand() - 0.5) * 0.6, (rand() - 0.5) * 0.9, 0])         // on-poster
for (let i = 0; i < 40; i++) points.push([(rand() - 0.5) * 2.5, (rand() - 0.5) * 1.4, -0.1 - rand() * 0.7]) // environment (toward camera side)

// =============== 1. primitives ===============
{
    const th = 0.7
    const R = G.rodrigues([0, 0, th])
    const v = G.matVec3(R, [1, 0, 0])
    check('rodrigues: +Z rotation convention', Math.abs(v[0] - Math.cos(th)) < 1e-12 && Math.abs(v[1] - Math.sin(th)) < 1e-12)

    // orthonormality + det(+1)
    const Rt = G.matMul3([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]], R)
    const offDiag = Math.abs(Rt[1]) + Math.abs(Rt[2]) + Math.abs(Rt[5])
    check('rodrigues: orthonormal', offDiag < 1e-12 && Math.abs(Rt[0] - 1) < 1e-12)

    const { R: Re, t: te } = G.se3Exp([0.1, -0.2, 0.05, 0, 0, 0])
    check('se3Exp: pure translation', Math.abs(te[0] - 0.1) < 1e-12 && Math.abs(Re[4] - 1) < 1e-12)

    const a = cameraAt(10, 1.5)
    const inv = G.invertRT(a.R, a.t)
    const ident = G.composeRT(a.R, a.t, inv.R, inv.t)
    check('invertRT/composeRT roundtrip', Math.abs(ident.t[0]) < 1e-12 && Math.abs(ident.R[0] - 1) < 1e-12)
}

// =============== 2. triangulation accuracy ===============
{
    const cam1 = cameraAt(-8, 1.5)
    const cam2 = cameraAt(8, 1.5)    // ~42cm baseline
    const sigma = 0.3                 // px noise

    const errs = []
    let rejected = 0
    for (const X of points) {
        const p1 = G.project(K, cam1.R, cam1.t, X)
        const p2 = G.project(K, cam2.R, cam2.t, X)
        if (p1[2] <= 0 || p2[2] <= 0) { rejected++; continue }
        const r = G.triangulateDLT(K,
            cam1.R, cam1.t, p1[0] + gauss(sigma), p1[1] + gauss(sigma),
            cam2.R, cam2.t, p2[0] + gauss(sigma), p2[1] + gauss(sigma))
        if (!r) { rejected++; continue }
        errs.push(Math.hypot(r.X[0] - X[0], r.X[1] - X[1], r.X[2] - X[2]))
    }
    errs.sort((x, y) => x - y)
    const median = errs[Math.floor(errs.length / 2)]
    check('triangulation: all points recovered', errs.length === points.length, `${errs.length}/${points.length}`)
    check('triangulation: median error < 1cm', median < 0.01, `${(median * 1000).toFixed(2)}mm`)
    check('triangulation: max error < 5cm', errs[errs.length - 1] < 0.05, `${(errs[errs.length - 1] * 1000).toFixed(1)}mm`)
}

// =============== 3. error vs baseline law (sigma_Z ~ 1/b) ===============
{
    const sigma = 0.5
    function medianErrAt(angle) {
        const cam1 = cameraAt(-angle, 1.5)
        const cam2 = cameraAt(angle, 1.5)
        const errs = []
        for (const X of points) {
            const p1 = G.project(K, cam1.R, cam1.t, X)
            const p2 = G.project(K, cam2.R, cam2.t, X)
            const r = G.triangulateDLT(K,
                cam1.R, cam1.t, p1[0] + gauss(sigma), p1[1] + gauss(sigma),
                cam2.R, cam2.t, p2[0] + gauss(sigma), p2[1] + gauss(sigma))
            if (r) errs.push(Math.hypot(r.X[0] - X[0], r.X[1] - X[1], r.X[2] - X[2]))
        }
        errs.sort((a, b) => a - b)
        return errs[Math.floor(errs.length / 2)]
    }
    const wide = medianErrAt(8)      // ~42cm baseline
    const narrow = medianErrAt(1)    // ~5cm baseline
    check('sigma_Z ~ 1/baseline: narrow >= 3x wide error', narrow > 3 * wide,
        `narrow ${(narrow * 1000).toFixed(1)}mm vs wide ${(wide * 1000).toFixed(1)}mm`)

    // parallax angle measurement itself
    const cam1 = cameraAt(-8, 1.5), cam2 = cameraAt(8, 1.5)
    const X = [0, 0, 0]
    const p1 = G.project(K, cam1.R, cam1.t, X), p2 = G.project(K, cam2.R, cam2.t, X)
    const ang = G.rayAngleDeg(K, cam1.R, p1[0], p1[1], cam2.R, p2[0], p2[1])
    check('rayAngleDeg matches geometry (~16 deg)', Math.abs(ang - 16) < 0.5, `${ang.toFixed(2)} deg`)
}

// =============== 4. cheirality ===============
{
    // A point BEHIND camera 1 must come out with negative depth so callers gate it
    const cam1 = cameraAt(0, 1.5)
    const behind = [0, 0, -3]  // behind the camera at z=-1.5 looking at origin
    const fake1 = [K.cx + 10, K.cy - 5]   // bogus observation
    const cam2 = cameraAt(10, 1.5)
    const fake2 = [K.cx - 20, K.cy + 8]
    const r = G.triangulateDLT(K, cam1.R, cam1.t, fake1[0], fake1[1], cam2.R, cam2.t, fake2[0], fake2[1])
    check('cheirality: bogus correspondence flagged by depth/error', !r || r.depth1 < 0 || r.err1 > 5 || r.err2 > 5)
}

// =============== 5. motion-only GN ===============
{
    const gt = cameraAt(5, 1.4)
    const N = 100
    const pts3 = new Float64Array(N * 3)
    const pts2 = new Float64Array(N * 2)
    const isOutlier = new Uint8Array(N)
    for (let i = 0; i < N; i++) {
        const X = points[i % points.length].map(v => v + gauss(0.002))
        pts3[i * 3] = X[0]; pts3[i * 3 + 1] = X[1]; pts3[i * 3 + 2] = X[2]
        const p = G.project(K, gt.R, gt.t, X)
        let u = p[0] + gauss(0.5), v = p[1] + gauss(0.5)
        if (i % 5 === 4) {            // 20% outliers
            isOutlier[i] = 1
            u += (rand() - 0.5) * 60
            v += (rand() - 0.5) * 60
        }
        pts2[i * 2] = u; pts2[i * 2 + 1] = v
    }

    // start from a perturbed prior: ~5 deg rotation, 10cm translation
    const pert = G.se3Exp([0.06, -0.05, 0.05, 0.05, -0.04, 0.045])
    const prior = G.composeRT(pert.R, pert.t, gt.R, gt.t)

    const res = G.motionOnlyGN(K, prior.R, prior.t, pts3, pts2, {})
    check('GN: converged with enough inliers', res.ok && res.nInliers >= 70, `inliers=${res.nInliers}`)

    const tErr = Math.hypot(res.t[0] - gt.t[0], res.t[1] - gt.t[1], res.t[2] - gt.t[2])
    // rotation error angle
    const Rrel = G.matMul3([res.R[0], res.R[3], res.R[6], res.R[1], res.R[4], res.R[7], res.R[2], res.R[5], res.R[8]], gt.R)
    const angErr = Math.acos(Math.max(-1, Math.min(1, (Rrel[0] + Rrel[4] + Rrel[8] - 1) / 2))) * 180 / Math.PI
    check('GN: translation error < 5mm', tErr < 0.005, `${(tErr * 1000).toFixed(2)}mm`)
    check('GN: rotation error < 0.2 deg', angErr < 0.2, `${angErr.toFixed(3)} deg`)

    let misclass = 0
    for (let i = 0; i < N; i++) {
        if (isOutlier[i] && res.inliers[i]) misclass++
        if (!isOutlier[i] && !res.inliers[i]) misclass++
    }
    check('GN: outlier classification >= 95%', misclass <= N * 0.05, `${N - misclass}/${N} correct`)
    check('GN: mean inlier reprojection < 1px', res.meanErr < 1.0, `${res.meanErr.toFixed(2)}px`)

    // Degenerate input must fail gracefully, not explode
    const bad = G.motionOnlyGN(K, prior.R, prior.t, pts3.slice(0, 9), pts2.slice(0, 6), {})
    check('GN: degenerate input returns ok=false', bad.ok === false)
}

const passed = checks.filter(Boolean).length
console.log(`========== ${passed}/${checks.length} checks passed ==========`)
process.exit(passed === checks.length ? 0 : 1)
