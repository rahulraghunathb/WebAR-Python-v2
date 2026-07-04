/**
 * WebAR SDK - SIMD Hamming matcher (drop-in for BFMatcher.knnMatch k=2).
 *
 * Embedded standalone wasm kernel (tools/matcher.c, 868 bytes): XOR +
 * i8x16.popcnt over 32-byte ORB descriptors. Measured 3.5ns/pair vs the
 * OpenCV wasm BFMatcher's 25ns/pair (7x) - matching was 92% of detection
 * cost, so this multiplies through every detect.
 *
 * Loads in workers and Node. Falls back gracefully: callers must check
 * SimdMatcher.ready (no SIMD support / instantiation failure -> false).
 */

const SimdMatcher = {
    ready: false,
    _ex: null,
    _capT: 0,
    _capS: 0,

    init: function () {
        const bin = (typeof atob !== 'undefined')
            ? Uint8Array.from(atob(SIMD_MATCHER_B64), c => c.charCodeAt(0))
            : Buffer.from(SIMD_MATCHER_B64, 'base64')
        return WebAssembly.instantiate(bin, {}).then((r) => {
            const ex = r.instance.exports
            SimdMatcher._ex = ex
            SimdMatcher._capT = ex.capT()
            SimdMatcher._capS = ex.capS()
            SimdMatcher.ready = true
            return true
        }).catch(() => false)
    },

    /**
     * kNN(2) + Lowe ratio test. Inputs are CV_8U Nx32 cv.Mats (or any
     * objects exposing .rows and .data as a Uint8Array).
     * @returns [{q, t}] like the pipeline's BFMatcher path.
     */
    match: function (targetDesc, sceneDesc, ratio) {
        ratio = ratio || 0.8
        const ex = SimdMatcher._ex
        const nS = sceneDesc.rows
        const out = []
        if (nS < 2) return out

        const mem = ex.memory.buffer
        const S = new Uint8Array(mem, ex.sbuf(), SimdMatcher._capS * 32)
        const nSc = Math.min(nS, SimdMatcher._capS)
        S.set(sceneDesc.data.subarray(0, nSc * 32))

        const T = new Uint8Array(mem, ex.tbuf(), SimdMatcher._capT * 32)
        const OUT = new Int32Array(mem, ex.obuf(), SimdMatcher._capT * 3)

        // Chunk over target rows (kernel capacity is 2048; budgets fit in one)
        const nT = targetDesc.rows
        for (let off = 0; off < nT; off += SimdMatcher._capT) {
            const n = Math.min(SimdMatcher._capT, nT - off)
            T.set(targetDesc.data.subarray(off * 32, (off + n) * 32))
            ex.knn2(n, nSc)
            for (let i = 0; i < n; i++) {
                const bi = OUT[i * 3]
                if (bi >= 0 && OUT[i * 3 + 1] < ratio * OUT[i * 3 + 2]) {
                    out.push({ q: off + i, t: bi })
                }
            }
        }
        return out
    }
}

const SIMD_MATCHER_B64 = 'AGFzbQEAAAABEQRgAAF/YAAAYAJ/fwBgAX8AAwkIAQAAAAACAwAEBQFwAQICBQQBAQoKBggBfwFBgMgICweZAQsGbWVtb3J5AgAEdGJ1ZgABBHNidWYAAgRvYnVmAAMEY2FwVAAEBGNhcFMAAQRrbm4yAAULX2luaXRpYWxpemUAABlfX2luZGlyZWN0X2Z1bmN0aW9uX3RhYmxlAQAZX2Vtc2NyaXB0ZW5fc3RhY2tfcmVzdG9yZQAGHGVtc2NyaXB0ZW5fc3RhY2tfZ2V0X2N1cnJlbnQABwkHAQBBAQsBAAr/BAgDAAELBQBBgAgLBgBBgIgECwYAQYCIBgsFAEGAEAvSBAIIfwN7AkAgAEEATA0AQYAQIAAgAEGAEE4bIQYgAUEASgRAQYAIIAEgAUGACE4bIQkDQCACQQV0IgD9AASQCCELIAD9AASACCEMQYCAgIAEIQFBfyEEQYCIBCEAQQAhBUGAgICABCEDA0AgASAA/QAAECAL/VH9YiAA/QAAACAM/VH9Yv1u/X39fyIK/RsAIAr9GwFqIAr9GwJqIAr9GwNqIgcgAyADIAdKGyABIAdKIggbIQMgBSAEIAgbIQQgAEEgaiEAIAcgASAIGyEBIAVBAWoiBSAJRw0ACyACQQxsIgAgAzYCiIgGIAAgATYChIgGIAAgBDYCgIgGIAJBAWoiAiAGRw0ACwwBC0EAIQEgAEEETgRAIAZB/B9xIQH9DAAAAAABAAAAAgAAAAMAAAAhCkEAIQADQCAK/QwMAAAADAAAAAwAAAAMAAAA/bUBIgv9GwAiAkF/NgKAiAYgC/0bASIDQX82AoCIBiAL/RsCIgRBfzYCgIgGIAv9GwMiBUF/NgKAiAYgAkGAgICABDYChIgGIANBgICAgAQ2AoSIBiAEQYCAgIAENgKEiAYgBUGAgICABDYChIgGIAJBgICAgAQ2AoiIBiADQYCAgIAENgKIiAYgBEGAgICABDYCiIgGIAVBgICAgAQ2AoiIBiAK/QwEAAAABAAAAAQAAAAEAAAA/a4BIQogAEEEaiIAIAFHDQALIAEgBkYNAQsDQCABQQxsIgBBgICAgAQ2AoiIBiAAQv////+PgICAwAA3AoCIBiABQQFqIgEgBkcNAAsLCwYAIAAkAAsEACMACw=='

if (typeof self !== 'undefined') self.SimdMatcher = SimdMatcher
if (typeof module !== 'undefined' && module.exports) module.exports = SimdMatcher
