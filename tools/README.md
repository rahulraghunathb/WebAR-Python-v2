# Build tools

## Slim OpenCV WASM core (`opencv-slim.js`)

The full opencv.js is ~11MB (3.5MB gzipped) and includes dnn/photo/objdetect
modules we never call. The slim build compiles ONLY
`core,imgproc,features2d,calib3d,video,flann` with the bindings whitelist in
`opencv_js_slim.config.py` (the exact functions `static/sdk/vision/pipeline.js`
uses), with WASM SIMD enabled.

Measured (2026-06-11, OpenCV 4.x @ emscripten 6.0): **3,895,823 bytes raw /
1,007,596 bytes gzip** vs full 10,964,323 / 3,542,512 - 72% smaller over the
wire. Pipeline page: avg KLT track step 4.1ms (slim-simd) vs 6.6ms (full).

The vision worker (`static/sdk/vision/vision-worker.js`) feature-detects SIMD
and loads `vendor/opencv-slim.js`, falling back to `vendor/opencv.js`
(universal, non-SIMD) when the slim file is absent or SIMD unsupported.

### One-time setup (Windows)

```bash
# toolchain via pip wheels (no admin needed)
venv/Scripts/pip install cmake ninja

# emscripten SDK
cd %USERPROFILE%
git clone --depth 1 https://github.com/emscripten-core/emsdk.git
cd emsdk
<venv>/python.exe emsdk.py install latest   # NOT ./emsdk - it hits the
<venv>/python.exe emsdk.py activate latest  # Windows Store python stub

# opencv source
cd %USERPROFILE%
git clone --depth 1 --branch 4.x https://github.com/opencv/opencv.git opencv-src
```

### Build

```bash
export EMSDK="$USERPROFILE/emsdk"
export EM_CONFIG="$EMSDK/.emscripten"
export PATH="$EMSDK:$EMSDK/upstream/emscripten:$EMSDK/node/<ver>/bin:<venv>/Scripts:$PATH"

cd "$USERPROFILE/opencv-src"
"$EMSDK/python/<ver>/python.exe" platforms/js/build_js.py build_wasm_slim \
  --build_wasm --simd \
  --config <repo>/tools/opencv_js_slim.config.py \
  --cmake_option="-GNinja" \
  --cmake_option="-DCMAKE_MAKE_PROGRAM=<venv>/Scripts/ninja.exe" \
  --cmake_option="-DCMAKE_CXX_STANDARD=17" \
  --cmake_option="-DBUILD_LIST=core,imgproc,features2d,calib3d,video,flann,js"

# build_js.py's build step hardcodes `make` (absent on Windows) and dies
# after a SUCCESSFUL configure - run the compile yourself with ninja:
cd build_wasm_slim
<venv>/Scripts/ninja.exe -j 14 modules/js/opencv.js   # output: bin/opencv.js
```

GOTCHAS (each one was a real configure/build failure on Windows):

1. Without `-GNinja`, CMake on Windows picks the Visual Studio generator
   and feeds Emscripten flags to MSVC's cl.exe ("Compiler doesn't support
   baseline optimization flags").
2. `-DCMAKE_CXX_STANDARD=17` is required with Emscripten >= 6.0: its Embind
   needs C++17 but build_js.py pins C++11. Configure dies at
   `modules/js/CMakeLists.txt:83`. (CMakeError.log is a red herring - it
   only holds benign compiler-feature probes; the real error is in cmake's
   stdout, so capture the full build_js.py output to a file.)
3. `BUILD_LIST` must include `js` itself, or the js module lands in
   "Disabled by dependency" and no opencv.js target exists (ninja:
   "unknown target"). Configure still reports success.
4. The Ninja target is `modules/js/opencv.js`, not `opencv.js` (that name
   only exists with the Makefile generator).
5. **`Mat.clone()` returns a buffer ALIAS on this build** (OpenCV 4.x HEAD
   + emscripten 6.0 embind regression; the official full build deep-copies).
   A clone of a Mat that is later overwritten (e.g. the worker's reused
   gray Mat) silently sees the new contents - this froze KLT tracking
   (LK compared each frame against itself: zero flow, status all 1, the
   12/12 page failed only the corner-motion check). Use
   `gray.copyTo(persistentMat)` instead of `clone()` (pipeline.js does).
   `/static/test-heap.html?build=opencv-slim.js` probes exactly this.

### Verification tooling (no camera, no npm deps; Node >= 22)

```bash
venv/Scripts/python.exe app.py   # serve on :5000, then:
node tools/run-pipeline-test.mjs                                  # 12-check pipeline page, exits 0 on 12/12
node tools/run-pipeline-test.mjs "http://127.0.0.1:5000/static/test-heap.html?build=opencv-slim.js"
```

`tools/run-pipeline-test.mjs` drives headless Chrome over the DevTools
protocol and prints the page's `#log` plus `window.__TEST_DONE__`. It works
on any page that sets `__TEST_DONE__ = {passed, failed, ...}`:

- `/static/test-pipeline.html` - the 12-check end-to-end suite (reports
  the selected runtime; expect `slim-simd` when slim is deployed)
- `/static/test-lk.html?build=...` - isolated calcOpticalFlowPyrLK check
- `/static/test-heap.html?build=...` - Mat.data staleness + clone-alias +
  copyTo probes
- `/static/test-track-debug.html?build=...[&pattern=persistent]` - pipeline
  on the main thread; `pattern=persistent` replicates the worker's reused-Mat
  input path
- `/static/test-track-worker.html` - per-frame corner trace through the
  real vision worker

To verify the fallback chain: rename `opencv-slim.js`/`.gz` away, re-run
the pipeline page (must report `runtime: full`, still 12/12), restore.

### Deploy

```bash
cp "$USERPROFILE/opencv-src/build_wasm_slim/bin/opencv.js" static/sdk/vendor/opencv-slim.js
python -c "import gzip,shutil; shutil.copyfileobj(open('static/sdk/vendor/opencv-slim.js','rb'), gzip.open('static/sdk/vendor/opencv-slim.js.gz','wb',9))"
```

Verify with `/static/test-pipeline.html` (must stay 12/12) and check the
`runtime` field in the engine-ready info says `slim-simd`.

## Precompressed static serving

`app.py` serves `<file>.gz` siblings with `Content-Encoding: gzip` when the
client accepts it. Regenerate after updating any vendor file:

```bash
python -c "import gzip,shutil; shutil.copyfileobj(open('FILE','rb'), gzip.open('FILE.gz','wb',9))"
```
