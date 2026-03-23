import hashlib
import json
import os
import re
import socket
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from time import time


DEFAULT_ACTIVE_EXPERIMENT = {
    "experimentId": "exp-image-target-lock",
    "hypothesis": (
        "A stable centered scan with even lighting should reduce time-to-first-lock "
        "and reduce relocalization churn."
    ),
    "targetId": "ranger-poster",
    "presetId": "baseline",
    "deviceLabel": "mobile-phone",
    "runTag": "manual-lab-loop",
    "operatorNote": "Start with the target flat, centered, and fully visible.",
    "successCriteria": (
        "Lock within 3 seconds, keep lock for 10 seconds, and avoid more than one "
        "reacquire event."
    ),
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


@dataclass
class LabWorkspace:
    repo_root: str
    default_active_experiment: dict = field(
        default_factory=lambda: dict(DEFAULT_ACTIVE_EXPERIMENT)
    )
    default_research_program: str = DEFAULT_RESEARCH_PROGRAM

    def __post_init__(self):
        self.lab_dir = os.path.join(self.repo_root, "lab")
        self.lab_runs_dir = os.path.join(self.lab_dir, "runs")
        self.lab_program_path = os.path.join(self.lab_dir, "program.md")
        self.lab_active_experiment_path = os.path.join(
            self.lab_dir, "active_experiment.json"
        )
        self.ensure_workspace()

    def ensure_workspace(self):
        os.makedirs(self.lab_runs_dir, exist_ok=True)
        if not os.path.exists(self.lab_program_path):
            with open(self.lab_program_path, "w", encoding="utf-8") as handle:
                handle.write(self.default_research_program)
        if not os.path.exists(self.lab_active_experiment_path):
            self.write_json_file(
                self.lab_active_experiment_path, self.default_active_experiment
            )

    def read_text_file(self, path, fallback=""):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return handle.read()
        except OSError:
            return fallback

    def read_json_file(self, path, fallback=None):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, json.JSONDecodeError):
            if isinstance(fallback, dict):
                return dict(fallback)
            if isinstance(fallback, list):
                return list(fallback)
            return fallback

    def write_json_file(self, path, payload):
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)

    def normalize_active_experiment(self, payload=None):
        experiment = dict(self.default_active_experiment)
        experiment.update(payload or {})
        for key in (
            "experimentId",
            "hypothesis",
            "targetId",
            "presetId",
            "deviceLabel",
            "runTag",
            "operatorNote",
            "successCriteria",
        ):
            fallback = self.default_active_experiment.get(key, "")
            experiment[key] = str(experiment.get(key, fallback) or fallback)
        return experiment

    def read_active_experiment(self):
        self.ensure_workspace()
        return self.normalize_active_experiment(
            self.read_json_file(
                self.lab_active_experiment_path, self.default_active_experiment
            )
        )

    def write_active_experiment(self, payload):
        self.ensure_workspace()
        experiment = self.normalize_active_experiment(payload)
        self.write_json_file(self.lab_active_experiment_path, experiment)
        return experiment

    def read_research_program(self):
        self.ensure_workspace()
        return self.read_text_file(
            self.lab_program_path, self.default_research_program
        )

    def build_program_version(self, program_text):
        digest = hashlib.sha1((program_text or "").encode("utf-8")).hexdigest()
        return digest[:12]

    def relative_program_path(self):
        return os.path.relpath(self.lab_program_path, self.repo_root).replace("\\", "/")

    def sanitize_run_id(self, value):
        cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())
        cleaned = cleaned.strip("-")
        return cleaned or f"run-{int(time() * 1000)}"

    def format_run_timestamp(self, timestamp):
        dt = datetime.fromtimestamp(timestamp)
        return dt.strftime("%Y%m%d_%H%M%S")

    def parse_run_index(self, name):
        match = re.match(r"^(\d+)__", str(name or ""))
        if not match:
            return 0
        try:
            return int(match.group(1))
        except ValueError:
            return 0

    def allocate_run_identity(self, received_at):
        self.ensure_workspace()
        max_index = 0
        try:
            for name in os.listdir(self.lab_runs_dir):
                if not name.endswith(".json"):
                    continue
                max_index = max(max_index, self.parse_run_index(name))
        except OSError:
            max_index = 0

        next_index = max_index + 1
        run_id = f"{next_index:03d}__{self.format_run_timestamp(received_at)}"
        artifact_path = os.path.join(self.lab_runs_dir, f"{run_id}.json")
        return run_id, artifact_path

    def discover_local_ipv4_addresses(self):
        addresses = []
        try:
            hostname = socket.gethostname()
            for info in socket.getaddrinfo(
                hostname, None, socket.AF_INET, socket.SOCK_STREAM
            ):
                candidate = info[4][0]
                if candidate.startswith("127."):
                    continue
                if candidate not in addresses:
                    addresses.append(candidate)
        except OSError:
            return addresses
        return addresses

    def build_connection_payload(self, req):
        scheme = req.headers.get("X-Forwarded-Proto", req.scheme or "http")
        request_host = str(req.host or "").strip()
        port = ""
        if ":" in request_host:
            _, port = request_host.rsplit(":", 1)
        candidates = OrderedDict()

        def add_host(host_value):
            host_text = str(host_value or "").strip()
            if not host_text or host_text in {"0.0.0.0", "127.0.0.1", "localhost"}:
                return
            authority = host_text if not port else f"{host_text}:{port}"
            candidates[authority] = {
                "host": host_text,
                "runtimeUrl": f"{scheme}://{authority}/",
                "roomUrl": f"{scheme}://{authority}/research-room",
                "dashboardUrl": f"{scheme}://{authority}/reconstruction-dashboard",
            }

        if request_host:
            add_host(request_host.split(":", 1)[0])
        for address in self.discover_local_ipv4_addresses():
            add_host(address)

        return {
            "sameNetwork": list(candidates.values()),
            "requestHost": request_host,
            "bindHost": os.environ.get("WEBAR_HOST", "0.0.0.0"),
            "port": port or os.environ.get("WEBAR_PORT", "5000"),
        }

    def read_recent_run_artifacts(self, limit=8):
        self.ensure_workspace()
        artifacts = []
        try:
            filenames = [
                os.path.join(self.lab_runs_dir, name)
                for name in os.listdir(self.lab_runs_dir)
                if name.endswith(".json")
            ]
        except OSError:
            return artifacts

        filenames.sort(key=lambda path: os.path.getmtime(path), reverse=True)
        for path in filenames[:limit]:
            artifact = self.read_json_file(path, {})
            summary = artifact.get("session")
            if isinstance(summary, dict):
                if not summary.get("runId"):
                    summary["runId"] = os.path.splitext(os.path.basename(path))[0]
                summary.setdefault("detailId", summary["runId"])
                artifacts.append(summary)
        return artifacts

    def read_run_artifact(self, run_id):
        self.ensure_workspace()
        safe_run_id = self.sanitize_run_id(run_id)
        artifact_path = os.path.join(self.lab_runs_dir, f"{safe_run_id}.json")
        artifact = self.read_json_file(artifact_path, None)
        if not isinstance(artifact, dict):
            return None
        summary = artifact.get("session")
        if isinstance(summary, dict):
            summary.setdefault("runId", safe_run_id)
            summary.setdefault("detailId", safe_run_id)
        return artifact

    def build_research_room_payload(
        self,
        req,
        current_sessions,
        build_signature,
        tracking_mode,
        research_track,
    ):
        program_text = self.read_research_program()
        experiment = self.read_active_experiment()
        recent_sessions = current_sessions or self.read_recent_run_artifacts(limit=10)
        latest_session = recent_sessions[0] if recent_sessions else None
        return {
            "build_signature": build_signature,
            "tracking_mode": tracking_mode,
            "research_track": research_track,
            "program": program_text,
            "program_path": self.relative_program_path(),
            "program_version": self.build_program_version(program_text),
            "experiment": experiment,
            "connection": self.build_connection_payload(req),
            "latest_session": latest_session,
            "recent_sessions": recent_sessions[:10],
            "reconstruction_dashboard_endpoint": "/reconstruction-dashboard",
            "runtime_endpoint": "/",
        }
