import logging
import os
import sys
from datetime import datetime
from time import time

from flask import Flask, Response, jsonify, render_template, request


class MillisecondFormatter(logging.Formatter):
    default_msec_format = '%s.%03d'

    def formatTime(self, record, datefmt=None):
        dt = datetime.fromtimestamp(record.created)
        if datefmt:
            return dt.strftime(datefmt) + f'.{int(record.msecs):03d}'
        return dt.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]


def create_backend_logger():
    logger = logging.getLogger('webar.backend')
    if logger.handlers:
        return logger

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        MillisecondFormatter(
            '%(asctime)s | %(levelname)s | backend | %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S',
        )
    )
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    logger.propagate = False
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
    return logger


def format_fields(**fields):
    parts = []
    for key, value in fields.items():
        if value is None:
            continue
        parts.append(f'{key}={value}')
    return ' '.join(parts)


def log_backend(event, **fields):
    suffix = format_fields(**fields)
    if suffix:
        LOGGER.info('%s %s', event, suffix)
        return
    LOGGER.info('%s', event)


def rounded_metric(value, digits=3):
    try:
        return f'{float(value):.{digits}f}'
    except (TypeError, ValueError):
        return None


app = Flask(__name__, static_folder='static', template_folder='static')
app.config['SECRET_KEY'] = 'custom-tracker-secret-key'

LOGGER = create_backend_logger()
BUILD_SIGNATURE = 'research-webxr-worker-wasm-owned-target-20260311d'

FEATURES = [
    'immersive-ar-required',
    'camera-access-required',
    'repo-owned-image-target-tracking',
    'target-image-reference-profile-enforced',
    'xr-raw-camera-frame-ingestion',
    'worker-pose-filter',
    'wasm-pose-kernel',
    'worker-feature-tracking',
    'worker-keyframe-map',
    'visual-quality-feedback-loop',
    'worker-reference-image-pose-estimation',
    'target-image-placement',
    'threejs-xr-render-loop',
    'repo-vendored-threejs',
    'browser-smoke-harness',
    'compatibility-contract-enforced',
    'optional-motion-telemetry',
    'expanded-debug-hud',
    'no-tracking-fallback-paths',
]
REQUIRED_RUNTIME_CAPABILITIES = [
    'navigator.xr',
    'immersive-ar',
    'XRWebGLBinding',
    'camera-access',
    'Worker',
    'WebAssembly',
    'createImageBitmap',
]
SMOKE_REPORT = {
    'status': 'IDLE',
    'payload': None,
    'updated_at': None,
}
FRONTEND_TELEMETRY = {
    'count': 0,
    'last_kind': 'IDLE',
    'last_payload': None,
    'updated_at': None,
}


@app.after_request
def disable_dev_cache(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


@app.route('/')
def index():
    return render_template('index.html', build_signature=BUILD_SIGNATURE)


@app.route('/status')
def status():
    return jsonify(
        {
            'ready': True,
            'build_signature': BUILD_SIGNATURE,
            'research_track': 'client-owned-image-target-with-worker-wasm-feature-map',
            'tracking_mode': 'webxr-camera-access-worker-owned-image-target',
            'server_tracking': False,
            'no_fallbacks': True,
            'asset_mode': 'repo-vendored-threejs',
            'features': FEATURES,
            'feature_count': len(FEATURES),
            'required_runtime_capabilities': REQUIRED_RUNTIME_CAPABILITIES,
            'required_capability_count': len(REQUIRED_RUNTIME_CAPABILITIES),
            'smoke_report_endpoint': '/smoke-report',
            'frontend_telemetry_endpoint': '/frontend-telemetry',
            'backend_logging_mode': 'frontend-runtime-telemetry',
        }
    )


@app.route('/frontend-telemetry', methods=['POST'])
def frontend_telemetry():
    payload = request.get_json(silent=True) or {}
    kind = str(payload.get('kind', 'unknown')).strip() or 'unknown'
    FRONTEND_TELEMETRY['count'] += 1
    FRONTEND_TELEMETRY['last_kind'] = kind
    FRONTEND_TELEMETRY['last_payload'] = payload
    FRONTEND_TELEMETRY['updated_at'] = time()
    log_backend(
        'frontend.telemetry',
        count=FRONTEND_TELEMETRY['count'],
        kind=kind,
        session=payload.get('sessionId', '-'),
        seq=payload.get('seq', '-'),
        source=payload.get('source', '-'),
        build=payload.get('buildSignature'),
        tracking_mode=payload.get('trackingMode'),
        session_state=payload.get('sessionState'),
        reference_space=payload.get('referenceSpace'),
        world_state=payload.get('worldState'),
        target_state=payload.get('targetState'),
        target_name=payload.get('targetName'),
        target_visible=payload.get('targetVisible'),
        target_updates=payload.get('targetUpdates'),
        target_width_m=rounded_metric(payload.get('targetMeasuredWidthM')),
        target_index=payload.get('targetIndex'),
        target_matches=payload.get('targetMatchCount'),
        target_inliers=payload.get('targetInlierCount'),
        target_confidence=rounded_metric(payload.get('targetConfidence')),
        target_reproj_px=rounded_metric(payload.get('targetReprojectionPx'), 2),
        target_reference_ready=payload.get('targetReferenceReady'),
        target_reference_features=payload.get('targetReferenceFeatures'),
        hit_test=payload.get('hitTestState'),
        anchor_state=payload.get('anchorState'),
        worker_state=payload.get('workerState'),
        wasm_state=payload.get('wasmState'),
        camera_access=payload.get('cameraAccessState'),
        visual_state=payload.get('visualState'),
        visual_features=payload.get('visualFeatureCount'),
        tracks=payload.get('trackCount'),
        matches=payload.get('matchCount'),
        keyframes=payload.get('keyframeCount'),
        landmarks=payload.get('landmarkCount'),
        map_state=payload.get('mapState'),
        reloc=rounded_metric(payload.get('relocalizationScore')),
        confidence=rounded_metric(payload.get('filterConfidence')),
        visual_quality=rounded_metric(payload.get('visualQuality')),
        visual_proc_ms=rounded_metric(payload.get('visualProcMs'), 2),
        visual_capture_ms=rounded_metric(payload.get('visualCaptureMs'), 2),
        surface_hits=payload.get('surfaceHits'),
        placed=payload.get('hasPlacement'),
        fps=rounded_metric(payload.get('xrFps'), 1),
        frame_ms=rounded_metric(payload.get('frameTimeMs'), 2),
        worker_ms=rounded_metric(payload.get('workerProcMs'), 2),
        capture_ms=rounded_metric(payload.get('cameraAverageCaptureMs'), 2),
        capture_interval_ms=payload.get('cameraCaptureIntervalMs'),
        capture_max_dim=payload.get('cameraCaptureMaxDimension'),
        skipped_throttle=payload.get('cameraSkippedThrottle'),
        skipped_busy=payload.get('cameraSkippedBusy'),
        pending=payload.get('cameraFramePending'),
        message=payload.get('message'),
    )
    return jsonify({'ok': True, 'count': FRONTEND_TELEMETRY['count']})


@app.route('/smoke-report', methods=['GET', 'POST', 'DELETE'])
def smoke_report():
    if request.method == 'GET':
        return jsonify(SMOKE_REPORT)

    if request.method == 'DELETE':
        SMOKE_REPORT['status'] = 'IDLE'
        SMOKE_REPORT['payload'] = None
        SMOKE_REPORT['updated_at'] = time()
        return jsonify({'ok': True})

    payload = request.get_json(silent=True) or {}
    SMOKE_REPORT['status'] = str(payload.get('status', 'UNKNOWN')).upper()
    SMOKE_REPORT['payload'] = payload
    SMOKE_REPORT['updated_at'] = time()
    return jsonify({'ok': True})


@app.route('/favicon.ico')
def favicon():
    return Response(status=204)


@app.route('/.well-known/appspecific/com.chrome.devtools.json')
def chrome_devtools_probe():
    return Response(status=204)


if __name__ == '__main__':
    host = os.environ.get('WEBAR_HOST', '0.0.0.0')
    port = int(os.environ.get('WEBAR_PORT', '5000'))
    log_backend(
        'server.start',
        host=host,
        port=port,
        build=BUILD_SIGNATURE,
        logging_mode='frontend-runtime-telemetry',
    )
    app.run(host=host, port=port, debug=False)






