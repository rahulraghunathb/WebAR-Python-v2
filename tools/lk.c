/*
 * WebAR SDK - SIMD pyramidal Lucas-Kanade kernel.
 *
 * cv.calcOpticalFlowPyrLK on the slim WASM build measures 9-10ms for
 * ~130 points at 720px (win 31, 5 levels) - the ENTIRE tracking-frame
 * floor (profiled 2026-07-07: everything else is 0.1-0.5ms). This kernel
 * does the same Bouguet KLT with:
 *
 *   - [1 2 1]x[1 2 1]/16 pyramid downsample (SIMD rows), levels stored
 *     with a replicated border (PAD) so near-edge windows behave like
 *     cv's padded pyramids instead of dying at the image edge
 *   - Scharr-style [-1 0 1]x[3 10 3] template gradients as i16 planes,
 *     computed lazily once per image-generation when it plays the
 *     template role
 *   - 14-bit fixed-point bilinear; the template window and its gradient
 *     windows are interpolated ONCE per point-level (Phase A), the
 *     iteration loop resamples only the current image (Phase B)
 *   - i32x4.dot_i16x8 (pmaddwd) for every window reduction, f32
 *     accumulation per row (products overflow i32 over a full window)
 *
 * Scale bookkeeping: template intensities carry 5 fractional bits (x32),
 * gradient planes carry the raw Scharr response (32x the true /32-kernel
 * derivative). In G = sum(g g^T) and b = sum(dI g) the x32 factors cancel
 * exactly, so the solved delta is in PIXELS with no rescaling; err is
 * sum|dI| / (32*win^2) - the same per-pixel L1 intensity scale cv reports
 * (the pipeline's errMax gate transfers unchanged).
 *
 * Numerics are cv-FAITHFUL but not bit-identical (box-Gaussian pyramid,
 * f32 vs double accumulators) -> ships behind cfg.lkKernel with its own
 * paired A/B verdict, cv fallback always present.
 *
 * Build (emsdk):
 *   emcc tools/lk.c -O3 -msimd128 --no-entry \
 *        -s STANDALONE_WASM=1 -s INITIAL_MEMORY=41943040 -s TOTAL_STACK=65536 \
 *        -s "EXPORTED_FUNCTIONS=['_imgbuf','_prep','_track','_ptsbuf','_seedbuf','_outbuf','_stbuf','_errbuf','_capPts','_capW','_capH','_fast9','_fastbuf']" \
 *        -o build/lk.wasm
 *   node tools/embed-kernel.mjs build/lk.wasm static/sdk/vision/lk-kernel.js LK_KERNEL_B64
 */

#include <stdint.h>
#include <string.h>
#include <math.h>
#include <wasm_simd128.h>

#define MAX_W    1280
#define MAX_H    960
#define MAX_LVL  6          /* level indices 0..5 */
#define PAD      32         /* replicated border, covers halfWin+2 up to win 61 */
#define MAX_PTS  512
#define MAX_WIN  61
#define W_BITS   14

/* Per-slot padded pyramid storage. Level L dims: (w>>L, h>>L); each level
 * is stored at stride (levelW + 2*PAD) with PAD rows above/below. */
#define LSTRIDE(w) ((w) + 2 * PAD)
#define LBYTES(w, h) (LSTRIDE(w) * ((h) + 2 * PAD))

/* worst case accumulated over levels: sum (W/2^l + 64)(H/2^l + 64) */
#define SLOT_BYTES 2500000
static uint8_t IMG[2][SLOT_BYTES];          /* u8 pyramids, 2 slots      */
static int16_t GRX[2][SLOT_BYTES];          /* Scharr-x planes per slot  */
static int16_t GRY[2][SLOT_BYTES];          /* Scharr-y planes per slot  */
static uint8_t RAW[MAX_W * MAX_H];          /* upload staging (unpadded) */

static int   lvlW[2][MAX_LVL], lvlH[2][MAX_LVL];
static int   lvlOff[2][MAX_LVL];            /* offset of (0,0) inside padded level */
static int   nLvl[2] = {0, 0};
static int   gradGen[2] = {-1, -1};         /* generation whose grads are built */
static int   imgGen[2] = {-1, -1};
static int   genCounter = 0;

static float PTS[MAX_PTS * 2];              /* prev positions, full-res  */
static float SEED[MAX_PTS * 2];             /* initial guesses, full-res */
static float OUTP[MAX_PTS * 2];
static uint8_t ST[MAX_PTS];
static float ERR[MAX_PTS];

/* template window buffers (Phase A), row stride padded to multiple of 8 */
#define WSTRIDE 64
static int16_t winI[MAX_WIN * WSTRIDE];
static int16_t winGx[MAX_WIN * WSTRIDE];
static int16_t winGy[MAX_WIN * WSTRIDE];

uint8_t *imgbuf(void) { return RAW; }
float   *ptsbuf(void) { return PTS; }
float   *seedbuf(void) { return SEED; }
float   *outbuf(void) { return OUTP; }
uint8_t *stbuf(void)  { return ST; }
float   *errbuf(void) { return ERR; }
int32_t  capPts(void) { return MAX_PTS; }
int32_t  capW(void)   { return MAX_W; }
int32_t  capH(void)   { return MAX_H; }

/* ---- BORDER_REFLECT_101 padding for one level (cv's pyramid border:
 * col -k mirrors col +k without repeating the edge). Replicate was tried
 * first and SMEARED edge windows: their gradients/err collapsed, the err
 * gate kept half-off-image points cv kills, and those fed the map exactly
 * at the poster-exit bootstrap window (slam: mapPeak 59 -> 37). ---- */
static inline int refl(int i, int n) {
    /* reflect-101 index into [0, n) for i in [-PAD, n+PAD) */
    if (i < 0) i = -i;
    if (i >= n) i = 2 * n - 2 - i;
    return i;
}
static void replicate(uint8_t *base, int w, int h) {
    const int stride = LSTRIDE(w);
    /* left/right columns of every valid row */
    for (int y = 0; y < h; y++) {
        uint8_t *row = base + (size_t)y * stride;
        for (int p = 1; p <= PAD; p++) {
            row[-p] = row[refl(-p, w)];
            row[w - 1 + p] = row[refl(w - 1 + p, w)];
        }
    }
    /* top/bottom rows (full padded width, mirrored rows) */
    for (int p = 1; p <= PAD; p++) {
        memcpy(base - (size_t)p * stride - PAD,
               base + (size_t)refl(-p, h) * stride - PAD, stride);
        memcpy(base + (size_t)(h - 1 + p) * stride - PAD,
               base + (size_t)refl(h - 1 + p, h) * stride - PAD, stride);
    }
}

/*
 * prep(slot, w, h, maxLevel): stage RAW into slot's padded level 0, build
 * the pyramid with the [1 2 1]^2/16 kernel, replicate borders. Gradients
 * are built lazily by track() when the slot plays the template role.
 */
void prep(int slot, int w, int h, int maxLevel) {
    if (w > MAX_W) w = MAX_W;
    if (h > MAX_H) h = MAX_H;
    if (maxLevel >= MAX_LVL) maxLevel = MAX_LVL - 1;

    int off = PAD * LSTRIDE(w) + PAD;
    lvlW[slot][0] = w; lvlH[slot][0] = h; lvlOff[slot][0] = off;
    uint8_t *dst0 = IMG[slot] + off;
    for (int y = 0; y < h; y++)
        memcpy(dst0 + (size_t)y * LSTRIDE(w), RAW + (size_t)y * w, w);
    replicate(dst0, w, h);

    int total = LBYTES(w, h);   /* next level block starts after L0's */
    for (int L = 1; L <= maxLevel; L++) {
        const int sw = lvlW[slot][L - 1], sh = lvlH[slot][L - 1];
        const int dw = sw >> 1, dh = sh >> 1;
        if (dw < 8 || dh < 8) { maxLevel = L - 1; break; }
        const int soff = lvlOff[slot][L - 1];
        const int doff = total + PAD * LSTRIDE(dw) + PAD;
        lvlW[slot][L] = dw; lvlH[slot][L] = dh; lvlOff[slot][L] = doff;
        const uint8_t *src = IMG[slot] + soff;
        uint8_t *dst = IMG[slot] + doff;
        const int ss = LSTRIDE(sw), ds = LSTRIDE(dw);
        for (int y = 0; y < dh; y++) {
            const uint8_t *r0 = src + (size_t)(2 * y - 1 < 0 ? 0 : 2 * y - 1) * ss;
            const uint8_t *r1 = src + (size_t)(2 * y) * ss;
            const uint8_t *r2 = src + (size_t)(2 * y + 1 >= sh ? sh - 1 : 2 * y + 1) * ss;
            uint8_t *d = dst + (size_t)y * ds;
            for (int x = 0; x < dw; x++) {
                const int sx = 2 * x;
                const int xm = sx - 1 < 0 ? 0 : sx - 1;
                const int xp = sx + 1 >= sw ? sw - 1 : sx + 1;
                /* [1 2 1]^2 / 16 */
                const int v =
                    r0[xm] + 2 * r0[sx] + r0[xp] +
                    2 * (r1[xm] + 2 * r1[sx] + r1[xp]) +
                    r2[xm] + 2 * r2[sx] + r2[xp];
                d[x] = (uint8_t)((v + 8) >> 4);
            }
        }
        replicate(dst, dw, dh);
        total += LBYTES(dw, dh);
    }
    nLvl[slot] = maxLevel + 1;
    imgGen[slot] = ++genCounter;
    gradGen[slot] = -1;
}

/* Scharr-ish gradients for every level of a slot: gx = [3 10 3]v * [-1 0 1]h,
 * gy transposed. cv SEMANTICS: the image pyramid is reflect-101 padded but
 * the DERIVATIVE pyramid is zero-padded - border-crossing windows are
 * anchored by in-image gradient energy only. Mirrored border gradients
 * were measured to inject phantom energy into poster-exit edge windows
 * (the tilt freeze-anchor 2x class), so the pad region is zeroed. */
static void buildGrads(int slot) {
    for (int L = 0; L < nLvl[slot]; L++) {
        const int w = lvlW[slot][L], h = lvlH[slot][L];
        const int stride = LSTRIDE(w);
        const uint8_t *img = IMG[slot] + lvlOff[slot][L];
        int16_t *gx = GRX[slot] + lvlOff[slot][L];
        int16_t *gy = GRY[slot] + lvlOff[slot][L];
        /* zero the full padded extent, then fill the interior */
        for (int y = -PAD; y < h + PAD; y++) {
            memset(gx + (size_t)y * stride - PAD, 0, LSTRIDE(w) * sizeof(int16_t));
            memset(gy + (size_t)y * stride - PAD, 0, LSTRIDE(w) * sizeof(int16_t));
        }
        for (int y = 0; y < h; y++) {
            const uint8_t *rm = img + (size_t)(y - 1) * stride;
            const uint8_t *r0 = img + (size_t)y * stride;
            const uint8_t *rp = img + (size_t)(y + 1) * stride;
            int16_t *ox = gx + (size_t)y * stride;
            int16_t *oy = gy + (size_t)y * stride;
            int x = 0;
            /* SIMD: 8 at a time using widened u8 loads */
            for (; x + 8 <= w; x += 8) {
                v128_t rm_m = wasm_u16x8_load8x8(rm + x - 1);
                v128_t rm_p = wasm_u16x8_load8x8(rm + x + 1);
                v128_t r0_m = wasm_u16x8_load8x8(r0 + x - 1);
                v128_t r0_p = wasm_u16x8_load8x8(r0 + x + 1);
                v128_t rp_m = wasm_u16x8_load8x8(rp + x - 1);
                v128_t rp_p = wasm_u16x8_load8x8(rp + x + 1);
                /* gx = 3(rm_p - rm_m) + 10(r0_p - r0_m) + 3(rp_p - rp_m) */
                v128_t d0 = wasm_i16x8_sub(rm_p, rm_m);
                v128_t d1 = wasm_i16x8_sub(r0_p, r0_m);
                v128_t d2 = wasm_i16x8_sub(rp_p, rp_m);
                v128_t vx = wasm_i16x8_add(
                    wasm_i16x8_mul(wasm_i16x8_add(d0, d2), wasm_i16x8_splat(3)),
                    wasm_i16x8_mul(d1, wasm_i16x8_splat(10)));
                wasm_v128_store(ox + x, vx);
                /* gy = 3(rp_m - rm_m) + 10(rp0 - rm0) + 3(rp_p - rm_p) */
                v128_t rm_0 = wasm_u16x8_load8x8(rm + x);
                v128_t rp_0 = wasm_u16x8_load8x8(rp + x);
                v128_t e0 = wasm_i16x8_sub(rp_m, rm_m);
                v128_t e1 = wasm_i16x8_sub(rp_0, rm_0);
                v128_t e2 = wasm_i16x8_sub(rp_p, rm_p);
                v128_t vy = wasm_i16x8_add(
                    wasm_i16x8_mul(wasm_i16x8_add(e0, e2), wasm_i16x8_splat(3)),
                    wasm_i16x8_mul(e1, wasm_i16x8_splat(10)));
                wasm_v128_store(oy + x, vy);
            }
            for (; x < w; x++) {
                ox[x] = (int16_t)(3 * (rm[x + 1] - rm[x - 1]) + 10 * (r0[x + 1] - r0[x - 1]) + 3 * (rp[x + 1] - rp[x - 1]));
                oy[x] = (int16_t)(3 * (rp[x - 1] - rm[x - 1]) + 10 * (rp[x] - rm[x]) + 3 * (rp[x + 1] - rm[x + 1]));
            }
        }
    }
    gradGen[slot] = imgGen[slot];
}

/* bilinear i16 sample row helper: out[k] = DESCALE(s0[k]*iw00 + s0[k+1]*iw01 +
 * s1[k]*iw10 + s1[k+1]*iw11, shift) for k in [0, n). Works for u8 (via load8x8
 * widening, wu=1) and i16 (wu=0) sources. */
static inline void sampleRow_u8(const uint8_t *s0, const uint8_t *s1, int n,
                                int iw00, int iw01, int iw10, int iw11,
                                int shift, int16_t *out) {
    const v128_t w00 = wasm_i16x8_splat((int16_t)iw00);
    const v128_t w01 = wasm_i16x8_splat((int16_t)iw01);
    const v128_t w10 = wasm_i16x8_splat((int16_t)iw10);
    const v128_t w11 = wasm_i16x8_splat((int16_t)iw11);
    const int32_t half = 1 << (shift - 1);
    int k = 0;
    for (; k + 8 <= n; k += 8) {
        v128_t a = wasm_u16x8_load8x8(s0 + k);
        v128_t b = wasm_u16x8_load8x8(s0 + k + 1);
        v128_t c = wasm_u16x8_load8x8(s1 + k);
        v128_t d = wasm_u16x8_load8x8(s1 + k + 1);
        /* widen products to i32 via extmul (values fit: 255*16384 = 22 bits) */
        v128_t lo = wasm_i32x4_add(
            wasm_i32x4_add(wasm_i32x4_extmul_low_i16x8(a, w00),
                           wasm_i32x4_extmul_low_i16x8(b, w01)),
            wasm_i32x4_add(wasm_i32x4_extmul_low_i16x8(c, w10),
                           wasm_i32x4_extmul_low_i16x8(d, w11)));
        v128_t hi = wasm_i32x4_add(
            wasm_i32x4_add(wasm_i32x4_extmul_high_i16x8(a, w00),
                           wasm_i32x4_extmul_high_i16x8(b, w01)),
            wasm_i32x4_add(wasm_i32x4_extmul_high_i16x8(c, w10),
                           wasm_i32x4_extmul_high_i16x8(d, w11)));
        lo = wasm_i32x4_shr(wasm_i32x4_add(lo, wasm_i32x4_splat(half)), shift);
        hi = wasm_i32x4_shr(wasm_i32x4_add(hi, wasm_i32x4_splat(half)), shift);
        wasm_v128_store(out + k, wasm_i16x8_narrow_i32x4(lo, hi));
    }
    for (; k < n; k++) {
        out[k] = (int16_t)((s0[k] * iw00 + s0[k + 1] * iw01 +
                            s1[k] * iw10 + s1[k + 1] * iw11 + half) >> shift);
    }
}

static inline void sampleRow_i16(const int16_t *s0, const int16_t *s1, int n,
                                 int iw00, int iw01, int iw10, int iw11,
                                 int shift, int16_t *out) {
    const int32_t half = 1 << (shift - 1);
    const v128_t w00 = wasm_i16x8_splat((int16_t)iw00);
    const v128_t w01 = wasm_i16x8_splat((int16_t)iw01);
    const v128_t w10 = wasm_i16x8_splat((int16_t)iw10);
    const v128_t w11 = wasm_i16x8_splat((int16_t)iw11);
    int k = 0;
    for (; k + 8 <= n; k += 8) {
        v128_t a = wasm_v128_load(s0 + k);
        v128_t b = wasm_v128_load(s0 + k + 1);
        v128_t c = wasm_v128_load(s1 + k);
        v128_t d = wasm_v128_load(s1 + k + 1);
        v128_t lo = wasm_i32x4_add(
            wasm_i32x4_add(wasm_i32x4_extmul_low_i16x8(a, w00),
                           wasm_i32x4_extmul_low_i16x8(b, w01)),
            wasm_i32x4_add(wasm_i32x4_extmul_low_i16x8(c, w10),
                           wasm_i32x4_extmul_low_i16x8(d, w11)));
        v128_t hi = wasm_i32x4_add(
            wasm_i32x4_add(wasm_i32x4_extmul_high_i16x8(a, w00),
                           wasm_i32x4_extmul_high_i16x8(b, w01)),
            wasm_i32x4_add(wasm_i32x4_extmul_high_i16x8(c, w10),
                           wasm_i32x4_extmul_high_i16x8(d, w11)));
        lo = wasm_i32x4_shr(wasm_i32x4_add(lo, wasm_i32x4_splat(half)), shift);
        hi = wasm_i32x4_shr(wasm_i32x4_add(hi, wasm_i32x4_splat(half)), shift);
        wasm_v128_store(out + k, wasm_i16x8_narrow_i32x4(lo, hi));
    }
    for (; k < n; k++) {
        out[k] = (int16_t)(((int32_t)s0[k] * iw00 + (int32_t)s0[k + 1] * iw01 +
                            (int32_t)s1[k] * iw10 + (int32_t)s1[k + 1] * iw11 + half) >> shift);
    }
}

/* horizontal add of an i32x4 */
static inline int64_t hadd4(v128_t v) {
    return (int64_t)wasm_i32x4_extract_lane(v, 0) + wasm_i32x4_extract_lane(v, 1) +
           (int64_t)wasm_i32x4_extract_lane(v, 2) + wasm_i32x4_extract_lane(v, 3);
}

/* ================= FAST-9 corner detector =================
 *
 * The pipeline's corner-harvest pass ran full cv.ORB.detect (FAST + Harris
 * + pyramid + orientation) for corner POSITIONS only - ~9ms every
 * candidate-hungry frame on device. This detector runs on the level-0
 * image ALREADY RESIDENT in a slot (uploaded once per frame for LK):
 * vectorized quick-reject (center +/- t vs the 4 compass points of the
 * Bresenham circle - kills >90% of pixels 16 at a time), scalar 9-of-16
 * segment test + sum-of-|diff| score on survivors, 3x3 non-max
 * suppression. Output: [x, y, score] triples.
 */

#define FAST_MAX 4096
static float FOUT[FAST_MAX * 3];
static int16_t SMAP[MAX_W * MAX_H];   /* sparse score map, cleared per call
                                         at candidate positions only */
static int32_t FCAND[FAST_MAX * 2 * 2];

float *fastbuf(void) { return FOUT; }

/* segment-test score: sum over contiguous-arc pixels of |p - c| - t */
static inline int fastScore(const uint8_t *p, const int *off, int t) {
    int c = p[0];
    int bright = 0, dark = 0;
    for (int k = 0; k < 16; k++) {
        int d = p[off[k]] - c;
        if (d > t) bright += d - t;
        else if (d < -t) dark += -d - t;
    }
    return bright > dark ? bright : dark;
}

static inline int fastIsCorner(const uint8_t *p, const int *off, int t) {
    const int c = p[0];
    const int lo = c - t, hi = c + t;
    /* 9 contiguous of 16: walk the doubled arc */
    int nb = 0, nd = 0;
    for (int k = 0; k < 24; k++) {
        const int v = p[off[k & 15]];
        if (v > hi) { nb++; nd = 0; if (nb >= 9) return 1; }
        else if (v < lo) { nd++; nb = 0; if (nd >= 9) return 1; }
        else { nb = 0; nd = 0; }
    }
    return 0;
}

/*
 * fast9(slot, thresh, maxOut): detect over pyramid levels 0-2 of the
 * slot (all already resident - built for LK). MULTI-LEVEL is load-
 * bearing, not a nicety: at high pitch the view is foreshortened,
 * motion-blurred ceiling/floor texture where level-0 FAST finds nothing
 * while coarse levels still fire (measured: level-0-only harvests
 * dwindled 17 -> 7 -> 2 into rot-only starvation, tilt held 100 -> 18%;
 * cv ORB survives the same views through its octaves). Coordinates are
 * returned at FULL resolution (x_full = x_L << L, the same mapping
 * track() inverts). Scores are Shi-Tomasi minEig over the level's 7x7
 * gradient window - RANKING ONLY, no absolute floor: a weak corner is
 * still a valid 2D flow source for rotation-only tracking, and the LK
 * gates drop untrackable ones naturally (an absolute floor here starved
 * the exact regime it was meant to protect).
 * Returns the number of [x,y,score] triples in fastbuf().
 */
static int32_t fast9Level(int slot, int L, int thresh, int maxOut, int out);

int32_t fast9(int slot, int thresh, int maxOut) {
    if (maxOut > FAST_MAX) maxOut = FAST_MAX;
    if (gradGen[slot] != imgGen[slot]) buildGrads(slot);
    int out = 0;
    /* Deep levels (L3-L4) are the far-plane lifeline: a big backdrop
     * stretched over distance renders as screen-blurred mush where L0-L2
     * all starve, but becomes crisp corners a few octaves up (ORB's 8
     * octaves survive those scenes; L0-L2 alone died mid-stretch in
     * test-slam). Scale-normalized scores keep coarse corners FILL-ONLY:
     * they are harvested when nothing sharper claims the cells. +2% px. */
    const int top = nLvl[slot] - 1 < 4 ? nLvl[slot] - 1 : 4;
    for (int L = 0; L <= top; L++) {
        out = fast9Level(slot, L, thresh, maxOut, out);
    }
    return out;
}

static int32_t fast9Level(int slot, int L, int thresh, int maxOut, int out) {
    const int w = lvlW[slot][L], h = lvlH[slot][L];
    const int stride = LSTRIDE(w);
    const uint8_t *img = IMG[slot] + lvlOff[slot][L];

    /* Bresenham circle offsets (radius 3) in row-major strides */
    const int off[16] = {
        0 * stride + 3,  1 * stride + 3,  2 * stride + 2,  3 * stride + 1,
        3 * stride + 0,  3 * stride - 1,  2 * stride - 2,  1 * stride - 3,
        0 * stride - 3, -1 * stride - 3, -2 * stride - 2, -3 * stride - 1,
       -3 * stride + 0, -3 * stride + 1, -2 * stride + 2, -1 * stride + 3
    };

    /* Pass 1: SIMD quick-reject + scalar confirm/score into a sparse
     * score map. A FAST-9 corner needs 9 contiguous circle pixels outside
     * the band, so at least one of {p1,p9} (vertical compass) AND one of
     * {p5,p13} (horizontal) must escape it - the vector test kills >90%
     * of pixels 8 at a time, the scalar segment test confirms the rest. */
    const int candCap = FAST_MAX * 2;
    int nc = 0;
    const v128_t vt = wasm_i16x8_splat((int16_t)thresh);
    for (int y = 3; y < h - 3 && nc < candCap; y++) {
        const uint8_t *row = img + (size_t)y * stride;
        int x = 3;
        for (; x + 8 <= w - 3; x += 8) {
            v128_t c = wasm_u16x8_load8x8(row + x);
            v128_t d1 = wasm_i16x8_abs(wasm_i16x8_sub(wasm_u16x8_load8x8(row + x - 3 * stride), c));
            v128_t d9 = wasm_i16x8_abs(wasm_i16x8_sub(wasm_u16x8_load8x8(row + x + 3 * stride), c));
            v128_t d5 = wasm_i16x8_abs(wasm_i16x8_sub(wasm_u16x8_load8x8(row + x + 3), c));
            v128_t d13 = wasm_i16x8_abs(wasm_i16x8_sub(wasm_u16x8_load8x8(row + x - 3), c));
            v128_t v_ = wasm_v128_or(wasm_i16x8_gt(d1, vt), wasm_i16x8_gt(d9, vt));
            v128_t h_ = wasm_v128_or(wasm_i16x8_gt(d5, vt), wasm_i16x8_gt(d13, vt));
            v128_t any = wasm_v128_and(v_, h_);
            if (!wasm_v128_any_true(any)) continue;
            int16_t lanes[8];
            wasm_v128_store(lanes, any);   /* -1 per passing lane */
            for (int k = 0; k < 8 && nc < candCap; k++) {
                if (!lanes[k]) continue;
                const uint8_t *p = row + x + k;
                if (fastIsCorner(p, off, thresh)) {
                    SMAP[(size_t)y * w + x + k] = (int16_t)fastScore(p, off, thresh);
                    FCAND[nc * 2] = x + k; FCAND[nc * 2 + 1] = y; nc++;
                }
            }
        }
        for (; x < w - 3 && nc < candCap; x++) {
            const uint8_t *p = row + x;
            if (fastIsCorner(p, off, thresh)) {
                SMAP[(size_t)y * w + x] = (int16_t)fastScore(p, off, thresh);
                FCAND[nc * 2] = x; FCAND[nc * 2 + 1] = y; nc++;
            }
        }
    }

    /* Pass 2: 3x3 non-max suppression over the sparse map (equal-score
     * neighbors: exactly one survives - the bottom-right of the pair),
     * survivors re-scored by minEig (ranking only, see fast9 docstring)
     * and emitted at full-resolution coordinates. */
    const int16_t *ggx = GRX[slot] + lvlOff[slot][L];
    const int16_t *ggy = GRY[slot] + lvlOff[slot][L];
    for (int i = 0; i < nc && out < maxOut; i++) {
        const int cx = FCAND[i * 2], cy = FCAND[i * 2 + 1];
        const int s = SMAP[(size_t)cy * w + cx];
        int keep = 1;
        for (int dy = -1; dy <= 1 && keep; dy++) {
            for (int dx = -1; dx <= 1 && keep; dx++) {
                if (!dx && !dy) continue;
                const int ns = SMAP[(size_t)(cy + dy) * w + cx + dx];
                if (ns > s) keep = 0;
                else if (ns == s && (dy > 0 || (dy == 0 && dx > 0))) keep = 0;
            }
        }
        if (!keep) continue;
        /* gradient structure matrix over the 7x7 window; the same sums
         * give minEig (quality score) AND a one-shot Foerstner sub-pixel
         * solve: G x* = b with b = sum(g g^T p). Integer FAST corners
         * carry up to 0.5px anchor quantization straight into candidate
         * triangulation - on smooth low-texture blobs the localization
         * gap vs Harris-picked pixels is the quality difference. */
        float axx = 0.f, axy = 0.f, ayy = 0.f, bx = 0.f, by = 0.f;
        for (int dy = -3; dy <= 3; dy++) {
            const size_t ro = (size_t)(cy + dy) * stride + cx;
            for (int dx = -3; dx <= 3; dx++) {
                const float gx_ = ggx[ro + dx], gy_ = ggy[ro + dx];
                const float xx = gx_ * gx_, xy = gx_ * gy_, yy = gy_ * gy_;
                axx += xx; axy += xy; ayy += yy;
                bx += xx * dx + xy * dy;
                by += xy * dx + yy * dy;
            }
        }
        const float minEig =
            (axx + ayy - sqrtf((axx - ayy) * (axx - ayy) + 4.f * axy * axy)) / (2.f * 49.f);
        float ox = 0.f, oy = 0.f;
        const float det = axx * ayy - axy * axy;
        if (det > 1e-3f) {
            ox = (ayy * bx - axy * by) / det;
            oy = (axx * by - axy * bx) / det;
            /* beyond 1px the quadratic model is off its patch - clamp */
            if (ox > 1.f) ox = 1.f; else if (ox < -1.f) ox = -1.f;
            if (oy > 1.f) oy = 1.f; else if (oy < -1.f) oy = -1.f;
        }
        FOUT[out * 3] = ((float)cx + ox) * (float)(1 << L);
        FOUT[out * 3 + 1] = ((float)cy + oy) * (float)(1 << L);
        /* scale-normalized score: a coarse-level corner is localized to
         * ~2^L full-res px, so at equal structure a fine corner must
         * outrank it - coarse corners are the smooth-scene LIFELINE, not
         * the default diet (unnormalized, the strongest-first harvest
         * went coarse-heavy and anchors inherited 2-4px quantization) */
        FOUT[out * 3 + 2] = minEig / (float)(1 << L);
        out++;
    }

    /* sparse clear so the next call starts from a zero map */
    for (int i = 0; i < nc; i++) {
        SMAP[(size_t)FCAND[i * 2 + 1] * w + FCAND[i * 2]] = 0;
    }
    return out;
}

/*
 * track(prevSlot, curSlot, n, win, maxLevel, iters):
 * PTS = template positions (full-res), SEED = initial guesses (full-res;
 * pass PTS copy when unseeded). Writes OUTP/ST/ERR. Returns n processed.
 */
int32_t track(int prevSlot, int curSlot, int n, int win, int maxLevel, int iters) {
    if (n > MAX_PTS) n = MAX_PTS;
    if (win > MAX_WIN) win = MAX_WIN;
    if (!(win & 1)) win |= 1;
    const int lv = nLvl[prevSlot] < nLvl[curSlot] ? nLvl[prevSlot] : nLvl[curSlot];
    if (maxLevel >= lv) maxLevel = lv - 1;
    if (gradGen[prevSlot] != imgGen[prevSlot]) buildGrads(prevSlot);

    const int halfW = win >> 1;
    const float eps2 = 1e-4f;   /* cv: (0.01)^2 on |delta|^2 */

    for (int i = 0; i < n; i++) {
        ST[i] = 1;
        ERR[i] = 0.f;
        float nx = SEED[i * 2] / (float)(1 << maxLevel);
        float ny = SEED[i * 2 + 1] / (float)(1 << maxLevel);

        for (int L = maxLevel; L >= 0; L--) {
            const int w = lvlW[prevSlot][L], h = lvlH[prevSlot][L];
            const int stride = LSTRIDE(w);
            const uint8_t *pimg = IMG[prevSlot] + lvlOff[prevSlot][L];
            const int16_t *pgx = GRX[prevSlot] + lvlOff[prevSlot][L];
            const int16_t *pgy = GRY[prevSlot] + lvlOff[prevSlot][L];
            const uint8_t *cimg = IMG[curSlot] + lvlOff[curSlot][L];

            const float px = PTS[i * 2] / (float)(1 << L) - halfW;
            const float py = PTS[i * 2 + 1] / (float)(1 << L) - halfW;
            const int ipx = (int)floorf(px), ipy = (int)floorf(py);

            /* template window must sit within the GRADIENT-valid padded
             * extent ([-PAD+1, dim+PAD-2] rows/cols; +1 for bilinear) */
            if (ipx < -PAD + 1 || ipy < -PAD + 1 ||
                ipx + win + 2 > w + PAD - 1 || ipy + win + 2 > h + PAD - 1) {
                if (L == 0) { ST[i] = 0; }
                if (L > 0) { nx *= 2.f; ny *= 2.f; }
                continue;
            }

            /* Phase A: interpolate template + gradient windows, build G */
            const float fx = px - ipx, fy = py - ipy;
            int iw00 = (int)((1.f - fx) * (1.f - fy) * (1 << W_BITS) + 0.5f);
            int iw01 = (int)(fx * (1.f - fy) * (1 << W_BITS) + 0.5f);
            int iw10 = (int)((1.f - fx) * fy * (1 << W_BITS) + 0.5f);
            int iw11 = (1 << W_BITS) - iw00 - iw01 - iw10;

            float A11 = 0.f, A12 = 0.f, A22 = 0.f;
            for (int r = 0; r < win; r++) {
                const size_t ro = (size_t)(ipy + r) * stride + ipx;
                sampleRow_u8(pimg + ro, pimg + ro + stride, win,
                             iw00, iw01, iw10, iw11, W_BITS - 5, winI + r * WSTRIDE);
                sampleRow_i16(pgx + ro, pgx + ro + stride, win,
                              iw00, iw01, iw10, iw11, W_BITS, winGx + r * WSTRIDE);
                sampleRow_i16(pgy + ro, pgy + ro + stride, win,
                              iw00, iw01, iw10, iw11, W_BITS, winGy + r * WSTRIDE);
                /* zero the SIMD tail so dots read clean lanes */
                for (int t = win; t < ((win + 7) & ~7); t++) {
                    winI[r * WSTRIDE + t] = 0;
                    winGx[r * WSTRIDE + t] = 0;
                    winGy[r * WSTRIDE + t] = 0;
                }
                v128_t axx = wasm_i32x4_splat(0), axy = wasm_i32x4_splat(0), ayy = wasm_i32x4_splat(0);
                for (int k = 0; k < win; k += 8) {
                    v128_t gx = wasm_v128_load(winGx + r * WSTRIDE + k);
                    v128_t gy = wasm_v128_load(winGy + r * WSTRIDE + k);
                    axx = wasm_i32x4_add(axx, wasm_i32x4_dot_i16x8(gx, gx));
                    axy = wasm_i32x4_add(axy, wasm_i32x4_dot_i16x8(gx, gy));
                    ayy = wasm_i32x4_add(ayy, wasm_i32x4_dot_i16x8(gy, gy));
                }
                A11 += (float)hadd4(axx);
                A12 += (float)hadd4(axy);
                A22 += (float)hadd4(ayy);
            }
            const float D = A11 * A22 - A12 * A12;
            const float minEig = (A22 + A11 - sqrtf((A11 - A22) * (A11 - A22) + 4.f * A12 * A12)) /
                                 (2.f * win * win);
            /* cv gates on FLT_SCALE'd (1/2^20) sums with minEigThreshold
             * 1e-4 and D < FLT_EPSILON; our sums are raw (1024x true), so
             * the same physical gates in raw units are: */
            if (minEig < 104.8576f || D < 1.4e5f) {
                if (L == 0) ST[i] = 0;
                if (L > 0) { nx *= 2.f; ny *= 2.f; }
                continue;
            }
            const float Dinv = 1.f / D;

            /* Phase B: iterate on the current image */
            float prevDx = 0.f, prevDy = 0.f;
            int it = 0;
            for (; it < iters; it++) {
                const float qx = nx - halfW, qy = ny - halfW;
                const int iqx = (int)floorf(qx), iqy = (int)floorf(qy);
                if (iqx < -PAD + 1 || iqy < -PAD + 1 ||
                    iqx + win + 2 > w + PAD - 1 || iqy + win + 2 > h + PAD - 1) {
                    if (L == 0) ST[i] = 0;   /* cv: any level-0 escape fails */
                    break;
                }
                const float qfx = qx - iqx, qfy = qy - iqy;
                int jw00 = (int)((1.f - qfx) * (1.f - qfy) * (1 << W_BITS) + 0.5f);
                int jw01 = (int)(qfx * (1.f - qfy) * (1 << W_BITS) + 0.5f);
                int jw10 = (int)((1.f - qfx) * qfy * (1 << W_BITS) + 0.5f);
                int jw11 = (1 << W_BITS) - jw00 - jw01 - jw10;

                float b1 = 0.f, b2 = 0.f;
                int16_t rowJ[WSTRIDE];
                for (int r = 0; r < win; r++) {
                    const size_t ro = (size_t)(iqy + r) * stride + iqx;
                    sampleRow_u8(cimg + ro, cimg + ro + stride, win,
                                 jw00, jw01, jw10, jw11, W_BITS - 5, rowJ);
                    for (int t = win; t < ((win + 7) & ~7); t++) rowJ[t] = 0;
                    v128_t bx = wasm_i32x4_splat(0), by = wasm_i32x4_splat(0);
                    for (int k = 0; k < win; k += 8) {
                        v128_t dI = wasm_i16x8_sub(wasm_v128_load(rowJ + k),
                                                   wasm_v128_load(winI + r * WSTRIDE + k));
                        bx = wasm_i32x4_add(bx, wasm_i32x4_dot_i16x8(dI, wasm_v128_load(winGx + r * WSTRIDE + k)));
                        by = wasm_i32x4_add(by, wasm_i32x4_dot_i16x8(dI, wasm_v128_load(winGy + r * WSTRIDE + k)));
                    }
                    b1 += (float)hadd4(bx);
                    b2 += (float)hadd4(by);
                }
                /* cv's exact update arrangement */
                const float dx = (A12 * b2 - A22 * b1) * Dinv;
                const float dy = (A12 * b1 - A11 * b2) * Dinv;
                nx += dx; ny += dy;
                if (dx * dx + dy * dy <= eps2) break;
                if (it > 0 && fabsf(dx + prevDx) < 0.01f && fabsf(dy + prevDy) < 0.01f) {
                    nx -= dx * 0.5f; ny -= dy * 0.5f;
                    break;
                }
                prevDx = dx; prevDy = dy;
            }

            /* per-pixel L1 err at level 0, cv scale */
            if (L == 0 && ST[i]) {
                const float qx = nx - halfW, qy = ny - halfW;
                const int iqx = (int)floorf(qx), iqy = (int)floorf(qy);
                if (iqx >= -PAD + 1 && iqy >= -PAD + 1 &&
                    iqx + win + 2 <= w + PAD - 1 && iqy + win + 2 <= h + PAD - 1) {
                    const float qfx = qx - iqx, qfy = qy - iqy;
                    int jw00 = (int)((1.f - qfx) * (1.f - qfy) * (1 << W_BITS) + 0.5f);
                    int jw01 = (int)(qfx * (1.f - qfy) * (1 << W_BITS) + 0.5f);
                    int jw10 = (int)((1.f - qfx) * qfy * (1 << W_BITS) + 0.5f);
                    int jw11 = (1 << W_BITS) - jw00 - jw01 - jw10;
                    int16_t rowJ[WSTRIDE];
                    int64_t asum = 0;
                    for (int r = 0; r < win; r++) {
                        const size_t ro = (size_t)(iqy + r) * stride + iqx;
                        sampleRow_u8(cimg + ro, cimg + ro + stride, win,
                                     jw00, jw01, jw10, jw11, W_BITS - 5, rowJ);
                        for (int t = win; t < ((win + 7) & ~7); t++) rowJ[t] = 0;
                        v128_t acc = wasm_i32x4_splat(0);
                        for (int k = 0; k < win; k += 8) {
                            v128_t dI = wasm_i16x8_sub(wasm_v128_load(rowJ + k),
                                                       wasm_v128_load(winI + r * WSTRIDE + k));
                            acc = wasm_i32x4_add(acc,
                                wasm_i32x4_extadd_pairwise_i16x8(wasm_i16x8_abs(dI)));
                        }
                        asum += hadd4(acc);
                    }
                    ERR[i] = (float)asum / (32.f * win * win);
                } else {
                    ST[i] = 0;
                }
            }

            if (L > 0) { nx *= 2.f; ny *= 2.f; }
        }

        /* final in-image sanity (full res) */
        const int w0 = lvlW[curSlot][0], h0 = lvlH[curSlot][0];
        if (!(nx > -halfW && ny > -halfW && nx < w0 + halfW && ny < h0 + halfW)) ST[i] = 0;
        OUTP[i * 2] = nx;
        OUTP[i * 2 + 1] = ny;
    }
    return n;
}
