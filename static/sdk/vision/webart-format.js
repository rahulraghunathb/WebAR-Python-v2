/**
 * WebAR SDK - .webart compiled target format (v1)
 *
 * Binary, little-endian, designed to be written by the offline compiler
 * (preprocess_target.py - the future cloud compiler) and parsed in one pass
 * with zero copies beyond typed-array views. Replaces both the legacy
 * pickle blob (unsafe, Python-only) and in-browser target compilation
 * (~1.2s of ORB on the UI's critical path).
 *
 * Layout:
 *   0   u8[4]  magic 'WART'
 *   4   u32    version (1)
 *   8   u32    imgW   - target image width, px
 *   12  u32    imgH   - target image height, px
 *   16  f32    physW  - physical width, meters
 *   20  f32    physH  - physical height, meters
 *   24  u32    nLevels
 *   then per level:
 *       f32    scale
 *       u32    count
 *       f32[count*2]  keypoints (x,y in FULL-RES target px)
 *       u8[count*32]  ORB descriptors
 */

const WEBART_MAGIC = 0x54524157  // 'WART' little-endian
const WEBART_VERSION = 1

/**
 * Parse a .webart ArrayBuffer.
 * @returns {{imgW, imgH, physW, physH, levels: [{scale, count, pts: Float32Array, desc: Uint8Array}]}}
 * @throws on malformed input
 */
function parseWebART(buffer) {
    const dv = new DataView(buffer)
    if (buffer.byteLength < 28) throw new Error('webart: truncated header')
    if (dv.getUint32(0, true) !== WEBART_MAGIC) throw new Error('webart: bad magic')
    const version = dv.getUint32(4, true)
    if (version !== WEBART_VERSION) throw new Error('webart: unsupported version ' + version)

    const imgW = dv.getUint32(8, true)
    const imgH = dv.getUint32(12, true)
    const physW = dv.getFloat32(16, true)
    const physH = dv.getFloat32(20, true)
    const nLevels = dv.getUint32(24, true)
    if (!imgW || !imgH || !nLevels || nLevels > 16) throw new Error('webart: implausible header')

    let off = 28
    const levels = []
    for (let i = 0; i < nLevels; i++) {
        if (off + 8 > buffer.byteLength) throw new Error('webart: truncated level header')
        const scale = dv.getFloat32(off, true); off += 4
        const count = dv.getUint32(off, true); off += 4
        const ptsBytes = count * 2 * 4
        const descBytes = count * 32
        if (off + ptsBytes + descBytes > buffer.byteLength) throw new Error('webart: truncated level data')

        // Float32Array views need 4-byte alignment; our layout guarantees it
        // (header 28B + levels of 8B + count*8B + count*32B are all 4-aligned)
        const pts = new Float32Array(buffer, off, count * 2); off += ptsBytes
        const desc = new Uint8Array(buffer, off, count * 32); off += descBytes
        levels.push({ scale, count, pts, desc })
    }

    return { imgW, imgH, physW, physH, levels }
}

// Exports: worker global, window, and Node (test harness)
if (typeof self !== 'undefined') self.parseWebART = parseWebART
if (typeof window !== 'undefined') window.parseWebART = parseWebART
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseWebART, WEBART_MAGIC, WEBART_VERSION }
}
