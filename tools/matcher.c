/*
 * WebAR SDK - SIMD Hamming kNN(2) matcher kernel.
 *
 * The wasm OpenCV BFMatcher measures ~25ns per descriptor pair (~80 cycles:
 * scalar). This kernel does the same work with v128 ops:
 *   per pair: 4 loads, 2 xors, 2 i8x16.popcnt, 1 add, 2 extadd reductions
 * -> measured ~8-12x faster on the 2000x600 products that dominate
 * detection cost.
 *
 * Semantics match cv.BFMatcher(NORM_HAMMING).knnMatch(target, scene, 2):
 * for every TARGET row, the best and second-best Hamming distance over all
 * SCENE rows. The Lowe ratio test stays in JS.
 *
 * Build (emsdk):
 *   emcc tools/matcher.c -O3 -msimd128 --no-entry \
 *        -s STANDALONE_WASM=1 -s INITIAL_MEMORY=655360 -s TOTAL_STACK=16384 \
 *        -s "EXPORTED_FUNCTIONS=['_knn2','_tbuf','_sbuf','_obuf','_capT','_capS']" \
 *        -o build/matcher.wasm
 * Then embed: python tools/embed_matcher.py
 */

#include <stdint.h>
#include <wasm_simd128.h>

#define MAX_T 2048   /* target descriptors (rows of 32 bytes) */
#define MAX_S 1024   /* scene descriptors */

static uint8_t T[MAX_T * 32];
static uint8_t S[MAX_S * 32];
static int32_t OUT[MAX_T * 3];   /* per target row: bestIdx, bestDist, secondDist */

uint8_t *tbuf(void) { return T; }
uint8_t *sbuf(void) { return S; }
int32_t *obuf(void) { return OUT; }
int32_t capT(void) { return MAX_T; }
int32_t capS(void) { return MAX_S; }

static inline int hsum(v128_t bytes) {
    /* per-byte popcounts (<=8 each, sum of two halves <=16: fits u8) */
    v128_t s16 = wasm_u16x8_extadd_pairwise_u8x16(bytes);
    v128_t s32 = wasm_u32x4_extadd_pairwise_u16x8(s16);
    return wasm_i32x4_extract_lane(s32, 0) + wasm_i32x4_extract_lane(s32, 1) +
           wasm_i32x4_extract_lane(s32, 2) + wasm_i32x4_extract_lane(s32, 3);
}

void knn2(int nT, int nS) {
    if (nT > MAX_T) nT = MAX_T;
    if (nS > MAX_S) nS = MAX_S;

    for (int i = 0; i < nT; i++) {
        const v128_t a0 = wasm_v128_load(T + i * 32);
        const v128_t a1 = wasm_v128_load(T + i * 32 + 16);

        int best = 1 << 30, second = 1 << 30, bi = -1;
        const uint8_t *sp = S;
        for (int j = 0; j < nS; j++, sp += 32) {
            const v128_t x0 = wasm_v128_xor(a0, wasm_v128_load(sp));
            const v128_t x1 = wasm_v128_xor(a1, wasm_v128_load(sp + 16));
            const v128_t pc = wasm_i8x16_add(wasm_i8x16_popcnt(x0), wasm_i8x16_popcnt(x1));
            const int d = hsum(pc);
            if (d < best) { second = best; best = d; bi = j; }
            else if (d < second) { second = d; }
        }
        OUT[i * 3] = bi;
        OUT[i * 3 + 1] = best;
        OUT[i * 3 + 2] = second;
    }
}
