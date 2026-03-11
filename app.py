import logging
import os
import sys
from collections import Counter, OrderedDict, deque
from datetime import datetime
from time import time

from flask import Flask, Response, abort, jsonify, render_template, request


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


def iso_timestamp(timestamp=None):
    value = time() if timestamp is None else timestamp
    return datetime.fromtimestamp(value).isoformat(timespec='milliseconds')


def coerce_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def coerce_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def coerce_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {'1', 'true', 'yes', 'on'}
    return False


def max_int_metric(events, field):
    return max((coerce_int(event.get(field), 0) for event in events), default=0)


def max_float_metric(events, field, digits=3, ignore_zero=False):
    values = [coerce_float(event.get(field), 0.0) for event in events]
    if ignore_zero:
        values = [value for value in values if value > 0]
    if not values:
        return 0
    return round(max(values), digits)


def average_float_metric(events, field, digits=3, ignore_zero=False):
    values = [coerce_float(event.get(field), 0.0) for event in events]
    if ignore_zero:
        values = [value for value in values if value > 0]
    if not values:
        return 0
    return round(sum(values) / len(values), digits)


def most_common_text(events, field, fallback='-'):
    values = [str(event.get(field, fallback) or fallback) for event in events]
    filtered = [value for value in values if value not in {'', '-', 'None'}]
    if not filtered:
        return fallback
    return Counter(filtered).most_common(1)[0][0]


app = Flask(__name__, static_folder='static', template_folder='static')
app.config['SECRET_KEY'] = 'custom-tracker-secret-key'

LOGGER = create_backend_logger()
BUILD_SIGNATURE = 'research-webxr-worker-wasm-owned-target-20260311d'
SESSION_EVENT_LIMIT = 240
SESSION_HISTORY_LIMIT = 40
ACTIVE_SESSION_WINDOW_S = 20

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
FRONTEND_SESSION_STORE = OrderedDict()


def build_session_event(payload, kind, received_at):
    return {
        'kind': kind,
        'seq': coerce_int(payload.get('seq'), -1),
        'source': str(payload.get('source', '-') or '-'),
        'message': payload.get('message'),
        'value': payload.get('value'),
        'sentAtIso': payload.get('sentAtIso'),
        'receivedAtIso': iso_timestamp(received_at),
        'elapsedMs': round(coerce_float(payload.get('elapsedMs'), 0.0), 2),
        'buildSignature': str(payload.get('buildSignature', '-') or '-'),
        'trackingMode': str(payload.get('trackingMode', '-') or '-'),
        'researchTrack': str(payload.get('researchTrack', '-') or '-'),
        'sessionState': str(payload.get('sessionState', '-') or '-'),
        'referenceSpace': str(payload.get('referenceSpace', '-') or '-'),
        'worldState': str(payload.get('worldState', '-') or '-'),
        'targetState': str(payload.get('targetState', '-') or '-'),
        'visualState': str(payload.get('visualState', '-') or '-'),
        'mapState': str(payload.get('mapState', '-') or '-'),
        'targetName': str(payload.get('targetName', '-') or '-'),
        'targetVisible': coerce_bool(payload.get('targetVisible')),
        'targetUpdates': coerce_int(payload.get('targetUpdates'), 0),
        'targetMeasuredWidthM': round(coerce_float(payload.get('targetMeasuredWidthM'), 0.0), 3),
        'targetIndex': coerce_int(payload.get('targetIndex'), -1),
        'targetMatchCount': coerce_int(payload.get('targetMatchCount'), 0),
        'targetInlierCount': coerce_int(payload.get('targetInlierCount'), 0),
        'targetInlierRatio': round(coerce_float(payload.get('targetInlierRatio'), 0.0), 3),
        'targetConfidence': round(coerce_float(payload.get('targetConfidence'), 0.0), 3),
        'targetReprojectionPx': round(coerce_float(payload.get('targetReprojectionPx'), 0.0), 3),
        'targetReferenceReady': coerce_bool(payload.get('targetReferenceReady')),
        'targetReferenceFeatures': coerce_int(payload.get('targetReferenceFeatures'), 0),
        'hitTestState': str(payload.get('hitTestState', '-') or '-'),
        'anchorState': str(payload.get('anchorState', '-') or '-'),
        'workerState': str(payload.get('workerState', '-') or '-'),
        'wasmState': str(payload.get('wasmState', '-') or '-'),
        'cameraAccessState': str(payload.get('cameraAccessState', '-') or '-'),
        'visualFeatureCount': coerce_int(payload.get('visualFeatureCount'), 0),
        'visualQuality': round(coerce_float(payload.get('visualQuality'), 0.0), 3),
        'visualProcMs': round(coerce_float(payload.get('visualProcMs'), 0.0), 3),
        'visualCaptureMs': round(coerce_float(payload.get('visualCaptureMs'), 0.0), 3),
        'trackCount': coerce_int(payload.get('trackCount'), 0),
        'averageTrackAge': round(coerce_float(payload.get('averageTrackAge'), 0.0), 3),
        'maxTrackAge': round(coerce_float(payload.get('maxTrackAge'), 0.0), 3),
        'longTrackRatio': round(coerce_float(payload.get('longTrackRatio'), 0.0), 3),
        'matchCount': coerce_int(payload.get('matchCount'), 0),
        'keyframeCount': coerce_int(payload.get('keyframeCount'), 0),
        'landmarkCount': coerce_int(payload.get('landmarkCount'), 0),
        'stableLandmarkCount': coerce_int(payload.get('stableLandmarkCount'), 0),
        'staleLandmarkCount': coerce_int(payload.get('staleLandmarkCount'), 0),
        'staleLandmarkRatio': round(coerce_float(payload.get('staleLandmarkRatio'), 0.0), 3),
        'keyframeGrowthPerSec': round(coerce_float(payload.get('keyframeGrowthPerSec'), 0.0), 3),
        'landmarkGrowthPerSec': round(coerce_float(payload.get('landmarkGrowthPerSec'), 0.0), 3),
        'motionObservability': round(coerce_float(payload.get('motionObservability'), 0.0), 3),
        'relocalizationScore': round(coerce_float(payload.get('relocalizationScore'), 0.0), 3),
        'relocalizationAttemptCount': coerce_int(payload.get('relocalizationAttemptCount'), 0),
        'relocalizationRecoveryCount': coerce_int(payload.get('relocalizationRecoveryCount'), 0),
        'lastRelocalizationDurationMs': round(coerce_float(payload.get('lastRelocalizationDurationMs'), 0.0), 2),
        'currentRelocalizationDurationMs': round(coerce_float(payload.get('currentRelocalizationDurationMs'), 0.0), 2),
        'filterConfidence': round(coerce_float(payload.get('filterConfidence'), 0.0), 3),
        'surfaceHits': coerce_int(payload.get('surfaceHits'), 0),
        'hasPlacement': coerce_bool(payload.get('hasPlacement')),
        'xrFps': round(coerce_float(payload.get('xrFps'), 0.0), 1),
        'frameTimeMs': round(coerce_float(payload.get('frameTimeMs'), 0.0), 2),
        'workerProcMs': round(coerce_float(payload.get('workerProcMs'), 0.0), 3),
        'workerLatencyMs': round(coerce_float(payload.get('workerLatencyMs'), 0.0), 3),
        'measurementDeltaTranslationM': round(coerce_float(payload.get('measurementDeltaTranslationM'), 0.0), 4),
        'measurementDeltaRotationDeg': round(coerce_float(payload.get('measurementDeltaRotationDeg'), 0.0), 3),
        'cameraAverageCaptureMs': round(coerce_float(payload.get('cameraAverageCaptureMs'), 0.0), 3),
        'cameraCaptureIntervalMs': coerce_int(payload.get('cameraCaptureIntervalMs'), 0),
        'cameraCaptureMaxDimension': coerce_int(payload.get('cameraCaptureMaxDimension'), 0),
        'cameraSkippedThrottle': coerce_int(payload.get('cameraSkippedThrottle'), 0),
        'cameraSkippedBusy': coerce_int(payload.get('cameraSkippedBusy'), 0),
        'cameraFramePending': coerce_bool(payload.get('cameraFramePending')),
    }


def get_or_create_frontend_session(session_id, received_at):
    session = FRONTEND_SESSION_STORE.get(session_id)
    if session is None:
        session = {
            'sessionId': session_id,
            'startedAt': received_at,
            'startedAtIso': iso_timestamp(received_at),
            'lastSeenAt': received_at,
            'lastSeenAtIso': iso_timestamp(received_at),
            'lastKind': 'IDLE',
            'eventCount': 0,
            'events': deque(maxlen=SESSION_EVENT_LIMIT),
        }
        FRONTEND_SESSION_STORE[session_id] = session
        while len(FRONTEND_SESSION_STORE) > SESSION_HISTORY_LIMIT:
            evicted_session_id, _ = FRONTEND_SESSION_STORE.popitem(last=False)
            log_backend('frontend.telemetry.session-evicted', session=evicted_session_id, limit=SESSION_HISTORY_LIMIT)
    else:
        FRONTEND_SESSION_STORE.move_to_end(session_id)
    return session


def record_frontend_session(payload, kind, received_at):
    raw_session_id = str(payload.get('sessionId', '') or '').strip()
    session_id = raw_session_id or f'anonymous-{int(received_at * 1000)}'
    session = get_or_create_frontend_session(session_id, received_at)
    session['eventCount'] += 1
    session['lastSeenAt'] = received_at
    session['lastSeenAtIso'] = iso_timestamp(received_at)
    session['lastKind'] = kind
    session['events'].append(build_session_event(payload, kind, received_at))
    return session


def build_session_summary(session):
    events = list(session['events'])
    last = events[-1] if events else {}
    kind_counts = Counter(event['kind'] for event in events)
    source_counts = Counter(event['source'] for event in events if event.get('source') not in {None, '', '-'})
    server_duration_ms = round(max(session['lastSeenAt'] - session['startedAt'], 0) * 1000, 2)
    runtime_duration_ms = round(max((coerce_float(event.get('elapsedMs'), 0.0) for event in events), default=0.0), 2)

    return {
        'sessionId': session['sessionId'],
        'startedAtIso': session['startedAtIso'],
        'lastSeenAtIso': session['lastSeenAtIso'],
        'active': (time() - session['lastSeenAt']) <= ACTIVE_SESSION_WINDOW_S,
        'durationMs': max(server_duration_ms, runtime_duration_ms),
        'eventCount': session['eventCount'],
        'storedEventCount': len(events),
        'truncated': session['eventCount'] > len(events),
        'lastKind': session.get('lastKind', 'IDLE'),
        'lastSessionState': last.get('sessionState', '-'),
        'lastWorldState': last.get('worldState', '-'),
        'lastTargetState': last.get('targetState', '-'),
        'lastVisualState': last.get('visualState', '-'),
        'lastMapState': last.get('mapState', '-'),
        'lastSource': last.get('source', '-'),
        'buildSignature': last.get('buildSignature', '-'),
        'trackingMode': last.get('trackingMode', '-'),
        'runtimeSnapshotCount': kind_counts.get('runtime-snapshot', 0),
        'transitionCount': kind_counts.get('transition', 0),
        'errorCount': kind_counts.get('error', 0),
        'kindCounts': dict(kind_counts),
        'sourceCounts': dict(source_counts),
        'dominantWorldState': most_common_text(events, 'worldState'),
        'dominantTargetState': most_common_text(events, 'targetState'),
        'dominantVisualState': most_common_text(events, 'visualState'),
        'dominantMapState': most_common_text(events, 'mapState'),
        'peakTargetUpdates': max_int_metric(events, 'targetUpdates'),
        'peakTargetMatches': max_int_metric(events, 'targetMatchCount'),
        'peakTargetInliers': max_int_metric(events, 'targetInlierCount'),
        'peakTargetInlierRatio': max_float_metric(events, 'targetInlierRatio', digits=3),
        'peakTargetConfidence': max_float_metric(events, 'targetConfidence', digits=3),
        'avgTrackAge': average_float_metric(events, 'averageTrackAge', digits=3, ignore_zero=True),
        'peakTrackAge': max_float_metric(events, 'maxTrackAge', digits=3, ignore_zero=True),
        'avgLongTrackRatio': average_float_metric(events, 'longTrackRatio', digits=3),
        'peakKeyframes': max_int_metric(events, 'keyframeCount'),
        'peakLandmarks': max_int_metric(events, 'landmarkCount'),
        'peakStaleLandmarkRatio': max_float_metric(events, 'staleLandmarkRatio', digits=3),
        'peakKeyframeGrowthPerSec': max_float_metric(events, 'keyframeGrowthPerSec', digits=3, ignore_zero=True),
        'peakLandmarkGrowthPerSec': max_float_metric(events, 'landmarkGrowthPerSec', digits=3, ignore_zero=True),
        'avgMotionObservability': average_float_metric(events, 'motionObservability', digits=3),
        'peakMotionObservability': max_float_metric(events, 'motionObservability', digits=3),
        'peakRelocalizationScore': max_float_metric(events, 'relocalizationScore', digits=3),
        'peakRelocalizationAttempts': max_int_metric(events, 'relocalizationAttemptCount'),
        'peakRelocalizationRecoveries': max_int_metric(events, 'relocalizationRecoveryCount'),
        'maxRelocalizationDurationMs': max_float_metric(events, 'lastRelocalizationDurationMs', digits=2, ignore_zero=True),
        'avgMeasurementDeltaTranslationM': average_float_metric(events, 'measurementDeltaTranslationM', digits=4, ignore_zero=True),
        'avgMeasurementDeltaRotationDeg': average_float_metric(events, 'measurementDeltaRotationDeg', digits=3, ignore_zero=True),
        'peakVisualQuality': max_float_metric(events, 'visualQuality', digits=3),
        'maxFps': max_float_metric(events, 'xrFps', digits=1, ignore_zero=True),
        'avgFps': average_float_metric(events, 'xrFps', digits=1, ignore_zero=True),
        'avgFrameMs': average_float_metric(events, 'frameTimeMs', digits=2, ignore_zero=True),
        'avgCaptureMs': average_float_metric(events, 'cameraAverageCaptureMs', digits=2, ignore_zero=True),
        'avgVisualProcMs': average_float_metric(events, 'visualProcMs', digits=2, ignore_zero=True),
        'avgVisualQuality': average_float_metric(events, 'visualQuality', digits=3),
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


@app.route('/reconstruction-dashboard')
def reconstruction_dashboard():
    return render_template('session-dashboard.html', build_signature=BUILD_SIGNATURE)


@app.route('/camera-diagnostics')
def camera_diagnostics():
    return render_template('camera-diagnostics.html', build_signature=BUILD_SIGNATURE)


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
            'session_dashboard_endpoint': '/reconstruction-dashboard',
            'camera_diagnostics_endpoint': '/camera-diagnostics',
            'reconstruction_sessions_endpoint': '/api/reconstruction-sessions',
            'backend_logging_mode': 'frontend-runtime-telemetry',
        }
    )


@app.route('/frontend-telemetry', methods=['POST'])
def frontend_telemetry():
    payload = request.get_json(silent=True) or {}
    kind = str(payload.get('kind', 'unknown')).strip() or 'unknown'
    received_at = time()
    FRONTEND_TELEMETRY['count'] += 1
    FRONTEND_TELEMETRY['last_kind'] = kind
    FRONTEND_TELEMETRY['last_payload'] = payload
    FRONTEND_TELEMETRY['updated_at'] = received_at
    session = record_frontend_session(payload, kind, received_at)
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
        target_inlier_ratio=rounded_metric(payload.get('targetInlierRatio')),
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
        track_age=rounded_metric(payload.get('averageTrackAge')),
        matches=payload.get('matchCount'),
        keyframes=payload.get('keyframeCount'),
        landmarks=payload.get('landmarkCount'),
        stale_ratio=rounded_metric(payload.get('staleLandmarkRatio')),
        observability=rounded_metric(payload.get('motionObservability')),
        map_state=payload.get('mapState'),
        reloc=rounded_metric(payload.get('relocalizationScore')),
        reloc_ms=rounded_metric(payload.get('lastRelocalizationDurationMs'), 2),
        confidence=rounded_metric(payload.get('filterConfidence')),
        visual_quality=rounded_metric(payload.get('visualQuality')),
        visual_proc_ms=rounded_metric(payload.get('visualProcMs'), 2),
        visual_capture_ms=rounded_metric(payload.get('visualCaptureMs'), 2),
        surface_hits=payload.get('surfaceHits'),
        placed=payload.get('hasPlacement'),
        fps=rounded_metric(payload.get('xrFps'), 1),
        frame_ms=rounded_metric(payload.get('frameTimeMs'), 2),
        worker_ms=rounded_metric(payload.get('workerProcMs'), 2),
        delta_m=rounded_metric(payload.get('measurementDeltaTranslationM'), 4),
        delta_deg=rounded_metric(payload.get('measurementDeltaRotationDeg'), 3),
        capture_ms=rounded_metric(payload.get('cameraAverageCaptureMs'), 2),
        capture_interval_ms=payload.get('cameraCaptureIntervalMs'),
        capture_max_dim=payload.get('cameraCaptureMaxDimension'),
        skipped_throttle=payload.get('cameraSkippedThrottle'),
        skipped_busy=payload.get('cameraSkippedBusy'),
        pending=payload.get('cameraFramePending'),
        message=payload.get('message'),
    )
    return jsonify(
        {
            'ok': True,
            'count': FRONTEND_TELEMETRY['count'],
            'stored_sessions': len(FRONTEND_SESSION_STORE),
            'session_events': session['eventCount'],
        }
    )


@app.route('/api/reconstruction-sessions')
def reconstruction_sessions():
    sessions = [build_session_summary(session) for session in reversed(list(FRONTEND_SESSION_STORE.values()))]
    return jsonify(
        {
            'count': len(sessions),
            'limits': {
                'sessionHistory': SESSION_HISTORY_LIMIT,
                'eventsPerSession': SESSION_EVENT_LIMIT,
            },
            'sessions': sessions,
        }
    )


@app.route('/api/reconstruction-sessions/<session_id>')
def reconstruction_session_detail(session_id):
    session = FRONTEND_SESSION_STORE.get(session_id)
    if session is None:
        abort(404)
    return jsonify(
        {
            'limits': {
                'sessionHistory': SESSION_HISTORY_LIMIT,
                'eventsPerSession': SESSION_EVENT_LIMIT,
            },
            'session': build_session_summary(session),
            'events': list(session['events']),
        }
    )


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