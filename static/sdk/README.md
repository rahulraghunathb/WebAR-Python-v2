# WebAR SDK

Client-side WebAR image tracking. All per-frame vision runs in a Web Worker
(OpenCV WASM) — **no server in the frame loop**. A latency-compensated
VISION-ONLY fusion engine produces render-rate (60Hz) poses (motion sensors
removed 2026-07-04 — no permission prompts; measured cost was rotation
smoothness only, position identical).

- ~8ms/frame tracking (detect-then-track: ORB acquisition, forward-backward
  KLT + PnP while tracking)
- Fusion verified against ground-truth simulation: 0.3–0.5° rotation RMS,
  9–16mm position RMS at 12–60Hz vision rates
- Compiled `.webart` targets (binary, 4x smaller than the source image,
  zero extraction time on device)

## Quick start (vanilla JS)

```html
<script src="/static/sdk/core/fusion.js"></script>
<script src="/static/sdk/webar-sdk.js"></script>
<script>
  const sdk = new WebARSDK({
    video: document.querySelector('video'),       // playing camera stream
    targetUrl: ['/assets/poster.webart', '/assets/poster.jpg'],  // candidates in order
    intrinsicsProvider: intrinsicsManager,        // optional, see camera-intrinsics.js
    maxDimension: 480                             // processing resolution
  })

  const fusion = new FusionEngine()

  // capture-time snapshots drive the latency compensation
  sdk.on('framesent', ({id, timestamp}) =>
    fusion.saveSnapshot(id, null, timestamp || performance.now()))
  sdk.on('result', (r) => { if (r.detected && r.pose) fusion.pushVisionPose(r.pose) })

  await sdk.start()

  // In your render loop (60Hz):
  const pose = fusion.getRenderPose(performance.now())
  if (pose.tracking) {
    camera.position.copy(pose.position)
    camera.quaternion.copy(pose.quaternion)
  }
</script>
```

World convention: origin at target center, X right, Y up, Z out of the
target toward the viewer, units in meters.

## A-Frame

```html
<script src="aframe.min.js"></script>
<script src="/static/sdk/core/fusion.js"></script>
<script src="/static/sdk/webar-sdk.js"></script>
<script src="/static/sdk/adapters/aframe-webar.js"></script>

<a-scene webar="targets: /assets/poster.webart" renderer="alpha: true">
  <a-entity webar-target>
    <a-box position="0 0 0.1" scale="0.2 0.2 0.2"></a-box>
  </a-entity>
  <a-entity camera look-controls="enabled: false"></a-entity>
</a-scene>

<script>
  // From a user gesture (mobile permission requirements):
  document.querySelector('a-scene').systems.webar.startCamera()
</script>
```

Events on the scene: `webar-ready`, `webar-camera-started`,
`webar-target-found`, `webar-target-lost`, `webar-error`. On the target
entity: `targetFound` / `targetLost`. See `/static/examples/aframe.html`.

## Compiling targets

```bash
python preprocess_target.py poster.jpg                 # -> poster.webart
python preprocess_target.py poster.jpg --width-m 0.42  # real printed width -> metric poses
```

The `.webart` format is documented in `vision/webart-format.js`. Passing the
real printed width makes `pose.position` / `pose.distance` metrically true.

## API surface

### `new WebARSDK(options)`
| option | type | default | |
|---|---|---|---|
| `video` | HTMLVideoElement | required | source of frames |
| `targetUrl` | string \| string[] | required | `.webart` or image URL(s), tried in order |
| `intrinsicsProvider` | object | null | `getIntrinsicsForFrame(w,h)` → `{fx,fy,cx,cy}` |
| `maxDimension` | number | 480 | processing resolution (long side) |
| `pipelineConfig` | object | null | overrides for the vision pipeline thresholds |

Methods: `start() → Promise<info>`, `stop()`, `resetTracking()`.
Events: `ready`, `result`, `framesent`, `error`. `sdk.stats` exposes
`{fps, procMs, captureMs}`.

### `new FusionEngine(config?)`
`pushVisionPose(pose)`, `saveSnapshot(id, quat, t)`, `setIMUProvider(imu)`,
`getRenderPose(now) → {tracking, position, quaternion}`, `reset()`.
Gains (`tauRot`, `tauPos`, `velTau`, `deadReckonMs`) are tuned via the
simulation harness in `tests/test_fusion.js` — re-run it after changing any.

## Verification

- `tests/test_fusion.js` (Node) — fusion vs ground truth simulation
- `tests/test_webart.js` (Node) — target format round-trip
- `/static/test-pipeline.html` (browser) — full WASM pipeline on synthetic
  frames, no camera needed
