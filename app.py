import os
from time import time

from flask import Flask, Response, abort, jsonify, render_template, request

from backend.lab import LabWorkspace, build_program_version
from backend.runtime import BACKEND_LOGGING_MODE, BUILD_SIGNATURE, build_frontend_log_fields, build_status_payload, log_backend
from backend.session_store import RuntimeStore


app = Flask(__name__, static_folder='static', template_folder='static')
app.config['SECRET_KEY'] = 'custom-tracker-secret-key'

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
LAB_WORKSPACE = LabWorkspace(REPO_ROOT)
LAB_WORKSPACE.ensure()
RUNTIME_STORE = RuntimeStore(LAB_WORKSPACE)


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


@app.route('/research-room')
def research_room():
    LAB_WORKSPACE.ensure()
    return render_template('research-room.html', build_signature=BUILD_SIGNATURE)


@app.route('/status')
def status():
    return jsonify(build_status_payload())


@app.route('/api/research-program')
def research_program():
    program_text = LAB_WORKSPACE.read_research_program()
    return jsonify(
        {
            'program': program_text,
            'program_path': os.path.relpath(LAB_WORKSPACE.lab_program_path, REPO_ROOT).replace('\\', '/'),
            'program_version': build_program_version(program_text),
        }
    )


@app.route('/api/experiments/current', methods=['GET', 'POST'])
def current_experiment():
    if request.method == 'POST':
        payload = request.get_json(silent=True) or {}
        experiment = LAB_WORKSPACE.write_active_experiment(payload)
        return jsonify({'ok': True, 'experiment': experiment})
    return jsonify({'experiment': LAB_WORKSPACE.read_active_experiment()})


@app.route('/api/research-room')
def research_room_state():
    recent_sessions = RUNTIME_STORE.get_recent_session_summaries()
    latest_session = recent_sessions[0] if recent_sessions else None
    return jsonify(
        LAB_WORKSPACE.build_research_room_payload(
            request,
            recent_sessions,
            latest_session=latest_session,
        )
    )


@app.route('/frontend-telemetry', methods=['POST'])
def frontend_telemetry():
    payload = request.get_json(silent=True) or {}
    kind = str(payload.get('kind', 'unknown')).strip() or 'unknown'
    received_at = time()
    counters = RUNTIME_STORE.record_frontend_telemetry(payload, kind, received_at)
    log_backend(
        'frontend.telemetry',
        **build_frontend_log_fields(payload, kind, RUNTIME_STORE.get_frontend_telemetry_count()),
    )
    return jsonify({'ok': True, **counters})


@app.route('/api/reconstruction-sessions')
def reconstruction_sessions():
    return jsonify(RUNTIME_STORE.get_reconstruction_sessions())


@app.route('/api/reconstruction-sessions/<session_id>')
def reconstruction_session_detail(session_id):
    payload = RUNTIME_STORE.get_reconstruction_session_detail(session_id)
    if payload is None:
        abort(404)
    return jsonify(payload)


@app.route('/smoke-report', methods=['GET', 'POST', 'DELETE'])
def smoke_report():
    if request.method == 'GET':
        return jsonify(RUNTIME_STORE.get_smoke_report())
    if request.method == 'DELETE':
        return jsonify(RUNTIME_STORE.reset_smoke_report())
    payload = request.get_json(silent=True) or {}
    return jsonify(RUNTIME_STORE.update_smoke_report(payload))


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
        logging_mode=BACKEND_LOGGING_MODE,
    )
    app.run(host=host, port=port, debug=False)
