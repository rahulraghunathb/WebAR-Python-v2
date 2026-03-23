import logging
import os
import socket
import sys
from collections import OrderedDict
from datetime import datetime
from time import time


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


LOGGER = create_backend_logger()

BUILD_SIGNATURE = 'research-webxr-worker-wasm-owned-target-20260311d'
RESEARCH_TRACK = 'client-owned-image-target-with-worker-wasm-feature-map'
TRACKING_MODE = 'webxr-camera-access-worker-owned-image-target'
BACKEND_LOGGING_MODE = 'frontend-runtime-telemetry'
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


def build_reconstruction_limits():
    return {
        'sessionHistory': SESSION_HISTORY_LIMIT,
        'eventsPerSession': SESSION_EVENT_LIMIT,
    }


def build_status_payload():
    return {
        'ready': True,
        'build_signature': BUILD_SIGNATURE,
        'research_track': RESEARCH_TRACK,
        'tracking_mode': TRACKING_MODE,
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
        'research_room_endpoint': '/research-room',
        'camera_diagnostics_endpoint': '/camera-diagnostics',
        'reconstruction_sessions_endpoint': '/api/reconstruction-sessions',
        'research_program_endpoint': '/api/research-program',
        'active_experiment_endpoint': '/api/experiments/current',
        'backend_logging_mode': BACKEND_LOGGING_MODE,
    }


def build_frontend_log_fields(payload, kind, count):
    return {
        'count': count,
        'kind': kind,
        'session': payload.get('sessionId', '-'),
        'seq': payload.get('seq', '-'),
        'source': payload.get('source', '-'),
        'build': payload.get('buildSignature'),
        'tracking_mode': payload.get('trackingMode'),
        'experiment': payload.get('experimentId'),
        'program_version': payload.get('programVersion'),
        'preset': payload.get('presetId'),
        'device': payload.get('deviceLabel'),
        'run_tag': payload.get('runTag'),
        'session_state': payload.get('sessionState'),
        'reference_space': payload.get('referenceSpace'),
        'world_state': payload.get('worldState'),
        'target_state': payload.get('targetState'),
        'target_name': payload.get('targetName'),
        'target_visible': payload.get('targetVisible'),
        'target_updates': payload.get('targetUpdates'),
        'target_width_m': rounded_metric(payload.get('targetMeasuredWidthM')),
        'target_index': payload.get('targetIndex'),
        'target_matches': payload.get('targetMatchCount'),
        'target_inliers': payload.get('targetInlierCount'),
        'target_inlier_ratio': rounded_metric(payload.get('targetInlierRatio')),
        'target_confidence': rounded_metric(payload.get('targetConfidence')),
        'target_reproj_px': rounded_metric(payload.get('targetReprojectionPx'), 2),
        'target_stable_frames': payload.get('targetStableFrames'),
        'target_prelock_misses': payload.get('targetPrelockMisses'),
        'target_reject_reason': payload.get('targetRejectReason'),
        'target_best_inliers': payload.get('targetBestInliers'),
        'target_refined_inliers': payload.get('targetRefinedInliers'),
        'target_raw_matches': payload.get('targetRawMatchCount'),
        'target_reciprocal_matches': payload.get('targetReciprocalMatchCount'),
        'target_match_strategy': payload.get('targetMatchStrategy'),
        'target_reference_ready': payload.get('targetReferenceReady'),
        'target_reference_features': payload.get('targetReferenceFeatures'),
        'hit_test': payload.get('hitTestState'),
        'anchor_state': payload.get('anchorState'),
        'worker_state': payload.get('workerState'),
        'wasm_state': payload.get('wasmState'),
        'camera_access': payload.get('cameraAccessState'),
        'visual_state': payload.get('visualState'),
        'visual_features': payload.get('visualFeatureCount'),
        'tracks': payload.get('trackCount'),
        'track_age': rounded_metric(payload.get('averageTrackAge')),
        'matches': payload.get('matchCount'),
        'keyframes': payload.get('keyframeCount'),
        'landmarks': payload.get('landmarkCount'),
        'stale_ratio': rounded_metric(payload.get('staleLandmarkRatio')),
        'observability': rounded_metric(payload.get('motionObservability')),
        'map_state': payload.get('mapState'),
        'relocalization': rounded_metric(payload.get('relocalizationScore')),
        'fps': rounded_metric(payload.get('xrFps'), 1),
        'frame_ms': rounded_metric(payload.get('frameTimeMs'), 2),
        'worker_ms': rounded_metric(payload.get('workerProcMs'), 2),
        'capture_ms': rounded_metric(payload.get('cameraAverageCaptureMs'), 2),
    }


def discover_local_ipv4_addresses():
    addresses = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_STREAM):
            candidate = info[4][0]
            if candidate.startswith('127.'):
                continue
            if candidate not in addresses:
                addresses.append(candidate)
    except OSError:
        return addresses
    return addresses


def build_connection_payload(req):
    scheme = req.headers.get('X-Forwarded-Proto', req.scheme or 'http')
    request_host = str(req.host or '').strip()
    port = ''
    if ':' in request_host:
        _, port = request_host.rsplit(':', 1)
    candidates = OrderedDict()

    def add_host(host_value):
        host_text = str(host_value or '').strip()
        if not host_text or host_text in {'0.0.0.0', '127.0.0.1', 'localhost'}:
            return
        authority = host_text if not port else f'{host_text}:{port}'
        candidates[authority] = {
            'host': host_text,
            'runtimeUrl': f'{scheme}://{authority}/',
            'roomUrl': f'{scheme}://{authority}/research-room',
            'dashboardUrl': f'{scheme}://{authority}/reconstruction-dashboard',
        }

    if request_host:
        add_host(request_host.split(':', 1)[0])
    for address in discover_local_ipv4_addresses():
        add_host(address)

    return {
        'sameNetwork': list(candidates.values()),
        'requestHost': request_host,
        'bindHost': os.environ.get('WEBAR_HOST', '0.0.0.0'),
        'port': port or os.environ.get('WEBAR_PORT', '5000'),
    }
