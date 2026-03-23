import hashlib
import json
import os
import re
from datetime import datetime
from time import time

from backend.runtime import BUILD_SIGNATURE, RESEARCH_TRACK, TRACKING_MODE, build_connection_payload, iso_timestamp


DEFAULT_ACTIVE_EXPERIMENT = {
    'experimentId': 'exp-image-target-lock',
    'hypothesis': 'A stable centered scan with even lighting should reduce time-to-first-lock and reduce relocalization churn.',
    'targetId': 'ranger-poster',
    'presetId': 'baseline',
    'deviceLabel': 'mobile-phone',
    'runTag': 'manual-lab-loop',
    'operatorNote': 'Start with the target flat, centered, and fully visible.',
    'successCriteria': 'Lock within 3 seconds, keep lock for 10 seconds, and avoid more than one reacquire event.',
}
DEFAULT_RESEARCH_PROGRAM = """# WebAR Research Program

## Mission
Create a repeatable phone-testing loop for image-target WebAR until target lock is fast, stable, and recoverable.

## Current Hypothesis
A stable centered scan with even lighting should reduce time-to-first-lock and relocalization churn.

## Active Target
- id: ranger-poster
- physical width: 0.20 m

## Standard Mobile Loop
1. Open the experimental room on desktop.
2. Open the AR runtime on the phone using the same network URL.
3. Start one run with the current experiment preset.
4. Scan the target image, hold lock, then force a brief loss and reacquire.
5. Review latest run metrics before changing any knob.

## Success Criteria
- first lock in under 3 seconds
- stable lock for at least 10 seconds
- at most 1 reacquire episode
- visual quality stays above 0.45 for most of the run

## Notes
- Keep edits small.
- Compare against the previous run before changing the hypothesis.
"""


def read_text_file(path, fallback=''):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return handle.read()
    except OSError:
        return fallback


def read_json_file(path, fallback=None):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        if isinstance(fallback, dict):
            return dict(fallback)
        if isinstance(fallback, list):
            return list(fallback)
        return fallback


def write_json_file(path, payload):
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2)


def normalize_active_experiment(payload=None):
    experiment = dict(DEFAULT_ACTIVE_EXPERIMENT)
    experiment.update(payload or {})
    for key in (
        'experimentId',
        'hypothesis',
        'targetId',
        'presetId',
        'deviceLabel',
        'runTag',
        'operatorNote',
        'successCriteria',
    ):
        fallback = DEFAULT_ACTIVE_EXPERIMENT.get(key, '')
        experiment[key] = str(experiment.get(key, fallback) or fallback)
    return experiment


def build_program_version(program_text):
    digest = hashlib.sha1((program_text or '').encode('utf-8')).hexdigest()
    return digest[:12]


def sanitize_run_id(value):
    cleaned = re.sub(r'[^A-Za-z0-9._-]+', '-', str(value or '').strip())
    cleaned = cleaned.strip('-')
    return cleaned or f'run-{int(time() * 1000)}'


def format_run_timestamp(timestamp):
    dt = datetime.fromtimestamp(timestamp)
    return dt.strftime('%Y%m%d_%H%M%S')


def parse_run_index(name):
    match = re.match(r'^(\d+)__', str(name or ''))
    if not match:
        return 0
    try:
        return int(match.group(1))
    except ValueError:
        return 0


class LabWorkspace:
    def __init__(self, repo_root):
        self.repo_root = repo_root
        self.lab_dir = os.path.join(repo_root, 'lab')
        self.lab_runs_dir = os.path.join(self.lab_dir, 'runs')
        self.lab_program_path = os.path.join(self.lab_dir, 'program.md')
        self.lab_active_experiment_path = os.path.join(self.lab_dir, 'active_experiment.json')

    def ensure(self):
        os.makedirs(self.lab_runs_dir, exist_ok=True)
        if not os.path.exists(self.lab_program_path):
            with open(self.lab_program_path, 'w', encoding='utf-8') as handle:
                handle.write(DEFAULT_RESEARCH_PROGRAM)
        if not os.path.exists(self.lab_active_experiment_path):
            with open(self.lab_active_experiment_path, 'w', encoding='utf-8') as handle:
                json.dump(DEFAULT_ACTIVE_EXPERIMENT, handle, indent=2)

    def read_active_experiment(self):
        self.ensure()
        payload = read_json_file(self.lab_active_experiment_path, DEFAULT_ACTIVE_EXPERIMENT)
        return normalize_active_experiment(payload)

    def write_active_experiment(self, payload):
        self.ensure()
        experiment = normalize_active_experiment(payload)
        write_json_file(self.lab_active_experiment_path, experiment)
        return experiment

    def read_research_program(self):
        self.ensure()
        return read_text_file(self.lab_program_path, DEFAULT_RESEARCH_PROGRAM)

    def allocate_run_identity(self, received_at):
        self.ensure()
        max_index = 0
        try:
            for name in os.listdir(self.lab_runs_dir):
                if not name.endswith('.json'):
                    continue
                max_index = max(max_index, parse_run_index(name))
        except OSError:
            max_index = 0

        next_index = max_index + 1
        run_id = f'{next_index:03d}__{format_run_timestamp(received_at)}'
        artifact_path = os.path.join(self.lab_runs_dir, f'{run_id}.json')
        return run_id, artifact_path

    def read_recent_run_artifacts(self, limit=8):
        self.ensure()
        artifacts = []
        try:
            filenames = self.iter_run_artifact_paths()
        except OSError:
            return artifacts

        for path in filenames[:limit]:
            artifact = read_json_file(path, {})
            summary = artifact.get('session')
            if isinstance(summary, dict):
                if not summary.get('runId'):
                    summary['runId'] = os.path.splitext(os.path.basename(path))[0]
                artifacts.append(summary)
        return artifacts

    def iter_run_artifact_paths(self):
        self.ensure()
        filenames = [
            os.path.join(self.lab_runs_dir, name)
            for name in os.listdir(self.lab_runs_dir)
            if name.endswith('.json')
        ]
        filenames.sort(key=lambda path: os.path.getmtime(path), reverse=True)
        return filenames

    def read_session_artifact_detail(self, session_id):
        for path in self.iter_run_artifact_paths():
            artifact = read_json_file(path, {})
            summary = artifact.get('session')
            if not isinstance(summary, dict):
                continue
            summary = dict(summary)
            run_id = summary.get('runId') or os.path.splitext(os.path.basename(path))[0]
            if session_id not in {summary.get('sessionId'), run_id}:
                continue
            return {
                'session': {**summary, 'runId': run_id},
                'events': artifact.get('events') if isinstance(artifact.get('events'), list) else [],
            }
        return None

    def build_research_room_payload(self, req, recent_sessions, latest_session=None):
        program_text = self.read_research_program()
        experiment = self.read_active_experiment()
        selected_latest = latest_session or (recent_sessions[0] if recent_sessions else None)
        return {
            'build_signature': BUILD_SIGNATURE,
            'tracking_mode': TRACKING_MODE,
            'research_track': RESEARCH_TRACK,
            'program': program_text,
            'program_path': os.path.relpath(self.lab_program_path, self.repo_root).replace('\\', '/'),
            'program_version': build_program_version(program_text),
            'experiment': experiment,
            'connection': build_connection_payload(req),
            'latest_session': selected_latest,
            'recent_sessions': recent_sessions[:10],
            'reconstruction_dashboard_endpoint': '/reconstruction-dashboard',
            'runtime_endpoint': '/',
        }

    def persist_session_artifact(self, session_summary, events, artifact_path):
        self.ensure()
        payload = {
            'updatedAtIso': iso_timestamp(),
            'session': session_summary,
            'events': events,
        }
        write_json_file(artifact_path, payload)
