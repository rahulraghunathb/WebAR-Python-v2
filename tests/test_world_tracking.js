/**
 * World tracking capability detection + backend selection tests (Node).
 * Mocks navigator.xr / XRSession across browser scenarios.
 *
 * Run: node tests/test_world_tracking.js
 */

const path = require('path')
const MODULE = path.join(__dirname, '..', 'static', 'sdk', 'core', 'world-tracking.js')

const checks = []
function check(name, cond, detail) {
    checks.push(cond)
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
}

/** Load the module fresh under a given global environment.
 *  Node 21+ defines `navigator` as a read-only global - plain assignment
 *  is silently ignored, so override via defineProperty. */
function loadWith(env) {
    delete require.cache[MODULE]
    const saved = {}
    for (const k of Object.keys(env)) {
        saved[k] = Object.getOwnPropertyDescriptor(global, k)
        Object.defineProperty(global, k, {
            value: env[k], configurable: true, writable: true
        })
    }
    const mod = require(MODULE)
    return {
        mod,
        restore() {
            for (const k of Object.keys(env)) {
                if (saved[k]) Object.defineProperty(global, k, saved[k])
                else delete global[k]
            }
        }
    }
}

async function main() {
    // --- Scenario 1: no WebXR at all (iOS Safari, desktop Firefox) ---
    {
        const { mod, restore } = loadWith({ navigator: {} })
        const caps = await mod.WorldTracking.detectCapabilities()
        check('no-xr: webxr=false with reason', !caps.webxr && /navigator\.xr/.test(caps.reason))
        const sel = await mod.WorldTracking.selectBackend()
        check('no-xr: auto-select falls back to image-target', sel.kind === 'image-target')
        const selPref = await mod.WorldTracking.selectBackend('webxr')
        check('no-xr: explicit webxr preference -> unavailable', selPref.kind === 'unavailable')
        restore()
    }

    // --- Scenario 2: WebXR present, immersive-ar unsupported (desktop Chrome) ---
    {
        const { mod, restore } = loadWith({
            navigator: { xr: { isSessionSupported: async () => false } }
        })
        const caps = await mod.WorldTracking.detectCapabilities()
        check('no-ar: webxr=true, immersiveAr=false', caps.webxr && !caps.immersiveAr)
        check('no-ar: reason mentions ARCore', /ARCore|not supported/.test(caps.reason))
        const sel = await mod.WorldTracking.selectBackend()
        check('no-ar: auto-select -> image-target', sel.kind === 'image-target')
        restore()
    }

    // --- Scenario 3: full ARCore Chrome with incubations ---
    {
        class XRSessionMock {}
        XRSessionMock.prototype.requestHitTestSource = function () {}
        XRSessionMock.prototype.getTrackedImageScores = function () {}
        XRSessionMock.prototype.domOverlayState = null

        const { mod, restore } = loadWith({
            navigator: { xr: { isSessionSupported: async (m) => m === 'immersive-ar' } },
            XRSession: XRSessionMock
        })
        const caps = await mod.WorldTracking.detectCapabilities()
        check('arcore: immersiveAr=true', caps.immersiveAr)
        check('arcore: hitTest detected', caps.hitTest)
        check('arcore: imageTracking detected (incubations)', caps.imageTracking)
        const sel = await mod.WorldTracking.selectBackend()
        check('arcore: auto-select -> webxr', sel.kind === 'webxr')
        const selImg = await mod.WorldTracking.selectBackend('image-target')
        check('arcore: explicit image-target preference honored', selImg.kind === 'image-target')

        // --- buildSessionInit shapes ---
        const plain = new mod.WebXRBackend({})
        const init1 = plain.buildSessionInit()
        check('init: local+hit-test required', init1.requiredFeatures.includes('local') &&
            init1.requiredFeatures.includes('hit-test'))
        check('init: no image-tracking without a target',
            !init1.optionalFeatures.includes('image-tracking') && !init1.trackedImages)

        const full = new mod.WebXRBackend({
            trackedImage: { bitmap: {}, widthInMeters: 0.42 },
            domOverlayRoot: {}
        })
        const init2 = full.buildSessionInit()
        check('init: image-tracking + trackedImages when target given',
            init2.optionalFeatures.includes('image-tracking') &&
            init2.trackedImages && init2.trackedImages[0].widthInMeters === 0.42)
        check('init: dom-overlay wired', init2.optionalFeatures.includes('dom-overlay') &&
            !!init2.domOverlay)

        // processFrame without a session/frame must be safe
        const out = plain.processFrame(null)
        check('processFrame(null) safe', out.hitMatrix === null && out.imagePose === null)
        restore()
    }

    const passed = checks.filter(Boolean).length
    console.log(`========== ${passed}/${checks.length} checks passed ==========`)
    process.exit(passed === checks.length ? 0 : 1)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
