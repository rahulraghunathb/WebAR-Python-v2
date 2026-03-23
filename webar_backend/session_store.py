import os
from collections import Counter, OrderedDict, deque

from webar_backend.common import (
    average_float_metric,
    coerce_bool,
    coerce_float,
    coerce_int,
    iso_timestamp,
    max_float_metric,
    max_int_metric,
    most_common_text,
    most_common_text_excluding,
)


PERSIST_IMMEDIATE_KINDS = {"error", "milestone", "transition"}


class FrontendSessionStore:
    def __init__(
        self,
        *,
        session_event_limit,
        session_history_limit,
        active_session_window_s,
        lab_workspace,
        log_backend,
    ):
        self.session_event_limit = session_event_limit
        self.session_history_limit = session_history_limit
        self.active_session_window_s = active_session_window_s
        self.lab_workspace = lab_workspace
        self.log_backend = log_backend
        self.store = OrderedDict()

    def build_limits_payload(self):
        return {
            "sessionHistory": self.session_history_limit,
            "eventsPerSession": self.session_event_limit,
        }

    def build_session_event(self, payload, kind, received_at):
        return {
            "kind": kind,
            "seq": coerce_int(payload.get("seq"), -1),
            "source": str(payload.get("source", "-") or "-"),
            "message": payload.get("message"),
            "value": payload.get("value"),
            "sentAtIso": payload.get("sentAtIso"),
            "receivedAtIso": iso_timestamp(received_at),
            "elapsedMs": round(coerce_float(payload.get("elapsedMs"), 0.0), 2),
            "buildSignature": str(payload.get("buildSignature", "-") or "-"),
            "trackingMode": str(payload.get("trackingMode", "-") or "-"),
            "researchTrack": str(payload.get("researchTrack", "-") or "-"),
            "sessionState": str(payload.get("sessionState", "-") or "-"),
            "referenceSpace": str(payload.get("referenceSpace", "-") or "-"),
            "worldState": str(payload.get("worldState", "-") or "-"),
            "targetState": str(payload.get("targetState", "-") or "-"),
            "visualState": str(payload.get("visualState", "-") or "-"),
            "mapState": str(payload.get("mapState", "-") or "-"),
            "targetName": str(payload.get("targetName", "-") or "-"),
            "targetVisible": coerce_bool(payload.get("targetVisible")),
            "targetUpdates": coerce_int(payload.get("targetUpdates"), 0),
            "targetMeasuredWidthM": round(
                coerce_float(payload.get("targetMeasuredWidthM"), 0.0), 3
            ),
            "targetIndex": coerce_int(payload.get("targetIndex"), -1),
            "targetMatchCount": coerce_int(payload.get("targetMatchCount"), 0),
            "targetInlierCount": coerce_int(payload.get("targetInlierCount"), 0),
            "targetInlierRatio": round(
                coerce_float(payload.get("targetInlierRatio"), 0.0), 3
            ),
            "targetConfidence": round(
                coerce_float(payload.get("targetConfidence"), 0.0), 3
            ),
            "targetReprojectionPx": round(
                coerce_float(payload.get("targetReprojectionPx"), 0.0), 3
            ),
            "targetStableFrames": coerce_int(payload.get("targetStableFrames"), 0),
            "targetPrelockMisses": coerce_int(payload.get("targetPrelockMisses"), 0),
            "targetRejectReason": str(payload.get("targetRejectReason", "-") or "-"),
            "targetBestInliers": coerce_int(payload.get("targetBestInliers"), 0),
            "targetRefinedInliers": coerce_int(
                payload.get("targetRefinedInliers"), 0
            ),
            "targetRawMatchCount": coerce_int(payload.get("targetRawMatchCount"), 0),
            "targetReciprocalMatchCount": coerce_int(
                payload.get("targetReciprocalMatchCount"), 0
            ),
            "targetMatchStrategy": str(payload.get("targetMatchStrategy", "-") or "-"),
            "targetReferenceReady": coerce_bool(payload.get("targetReferenceReady")),
            "targetReferenceFeatures": coerce_int(
                payload.get("targetReferenceFeatures"), 0
            ),
            "hitTestState": str(payload.get("hitTestState", "-") or "-"),
            "anchorState": str(payload.get("anchorState", "-") or "-"),
            "workerState": str(payload.get("workerState", "-") or "-"),
            "wasmState": str(payload.get("wasmState", "-") or "-"),
            "cameraAccessState": str(payload.get("cameraAccessState", "-") or "-"),
            "visualFeatureCount": coerce_int(payload.get("visualFeatureCount"), 0),
            "visualQuality": round(coerce_float(payload.get("visualQuality"), 0.0), 3),
            "visualProcMs": round(coerce_float(payload.get("visualProcMs"), 0.0), 3),
            "visualCaptureMs": round(
                coerce_float(payload.get("visualCaptureMs"), 0.0), 3
            ),
            "trackCount": coerce_int(payload.get("trackCount"), 0),
            "averageTrackAge": round(
                coerce_float(payload.get("averageTrackAge"), 0.0), 3
            ),
            "maxTrackAge": round(coerce_float(payload.get("maxTrackAge"), 0.0), 3),
            "longTrackRatio": round(
                coerce_float(payload.get("longTrackRatio"), 0.0), 3
            ),
            "matchCount": coerce_int(payload.get("matchCount"), 0),
            "keyframeCount": coerce_int(payload.get("keyframeCount"), 0),
            "landmarkCount": coerce_int(payload.get("landmarkCount"), 0),
            "stableLandmarkCount": coerce_int(
                payload.get("stableLandmarkCount"), 0
            ),
            "staleLandmarkCount": coerce_int(payload.get("staleLandmarkCount"), 0),
            "staleLandmarkRatio": round(
                coerce_float(payload.get("staleLandmarkRatio"), 0.0), 3
            ),
            "keyframeGrowthPerSec": round(
                coerce_float(payload.get("keyframeGrowthPerSec"), 0.0), 3
            ),
            "landmarkGrowthPerSec": round(
                coerce_float(payload.get("landmarkGrowthPerSec"), 0.0), 3
            ),
            "motionObservability": round(
                coerce_float(payload.get("motionObservability"), 0.0), 3
            ),
            "relocalizationScore": round(
                coerce_float(payload.get("relocalizationScore"), 0.0), 3
            ),
            "relocalizationAttemptCount": coerce_int(
                payload.get("relocalizationAttemptCount"), 0
            ),
            "relocalizationRecoveryCount": coerce_int(
                payload.get("relocalizationRecoveryCount"), 0
            ),
            "lastRelocalizationDurationMs": round(
                coerce_float(payload.get("lastRelocalizationDurationMs"), 0.0), 2
            ),
            "currentRelocalizationDurationMs": round(
                coerce_float(payload.get("currentRelocalizationDurationMs"), 0.0), 2
            ),
            "filterConfidence": round(
                coerce_float(payload.get("filterConfidence"), 0.0), 3
            ),
            "surfaceHits": coerce_int(payload.get("surfaceHits"), 0),
            "hasPlacement": coerce_bool(payload.get("hasPlacement")),
            "xrFps": round(coerce_float(payload.get("xrFps"), 0.0), 1),
            "frameTimeMs": round(coerce_float(payload.get("frameTimeMs"), 0.0), 2),
            "workerProcMs": round(coerce_float(payload.get("workerProcMs"), 0.0), 3),
            "workerLatencyMs": round(
                coerce_float(payload.get("workerLatencyMs"), 0.0), 3
            ),
            "measurementDeltaTranslationM": round(
                coerce_float(payload.get("measurementDeltaTranslationM"), 0.0), 4
            ),
            "measurementDeltaRotationDeg": round(
                coerce_float(payload.get("measurementDeltaRotationDeg"), 0.0), 3
            ),
            "cameraAverageCaptureMs": round(
                coerce_float(payload.get("cameraAverageCaptureMs"), 0.0), 3
            ),
            "cameraCaptureIntervalMs": coerce_int(
                payload.get("cameraCaptureIntervalMs"), 0
            ),
            "cameraCaptureMaxDimension": coerce_int(
                payload.get("cameraCaptureMaxDimension"), 0
            ),
            "cameraSkippedThrottle": coerce_int(
                payload.get("cameraSkippedThrottle"), 0
            ),
            "cameraSkippedBusy": coerce_int(payload.get("cameraSkippedBusy"), 0),
            "cameraFramePending": coerce_bool(payload.get("cameraFramePending")),
            "experimentId": str(payload.get("experimentId", "-") or "-"),
            "programVersion": str(payload.get("programVersion", "-") or "-"),
            "hypothesis": str(payload.get("hypothesis", "") or ""),
            "presetId": str(payload.get("presetId", "-") or "-"),
            "deviceLabel": str(payload.get("deviceLabel", "-") or "-"),
            "runTag": str(payload.get("runTag", "-") or "-"),
            "operatorNote": str(payload.get("operatorNote", "") or ""),
            "successCriteria": str(payload.get("successCriteria", "") or ""),
            "targetId": str(payload.get("targetId", "-") or "-"),
        }

    def get_or_create_session(self, session_id, received_at):
        session = self.store.get(session_id)
        if session is None:
            run_id, artifact_path = self.lab_workspace.allocate_run_identity(received_at)
            session = {
                "sessionId": session_id,
                "runId": run_id,
                "artifactPath": artifact_path,
                "startedAt": received_at,
                "startedAtIso": iso_timestamp(received_at),
                "lastSeenAt": received_at,
                "lastSeenAtIso": iso_timestamp(received_at),
                "lastKind": "IDLE",
                "eventCount": 0,
                "events": deque(maxlen=self.session_event_limit),
                "lastPersistedAt": 0.0,
            }
            self.store[session_id] = session
            while len(self.store) > self.session_history_limit:
                evicted_session_id, _ = self.store.popitem(last=False)
                self.log_backend(
                    "frontend.telemetry.session-evicted",
                    session=evicted_session_id,
                    limit=self.session_history_limit,
                )
        else:
            self.store.move_to_end(session_id)
        return session

    def record(self, payload, kind, received_at):
        raw_session_id = str(payload.get("sessionId", "") or "").strip()
        session_id = raw_session_id or f"anonymous-{int(received_at * 1000)}"
        session = self.get_or_create_session(session_id, received_at)
        session["eventCount"] += 1
        session["lastSeenAt"] = received_at
        session["lastSeenAtIso"] = iso_timestamp(received_at)
        session["lastKind"] = kind
        session["events"].append(self.build_session_event(payload, kind, received_at))
        return session

    def build_session_summary(self, session, now):
        events = list(session["events"])
        last = events[-1] if events else {}
        kind_counts = Counter(event["kind"] for event in events)
        source_counts = Counter(
            event["source"]
            for event in events
            if event.get("source") not in {None, "", "-"}
        )
        server_duration_ms = round(
            max(session["lastSeenAt"] - session["startedAt"], 0) * 1000, 2
        )
        runtime_duration_ms = round(
            max((coerce_float(event.get("elapsedMs"), 0.0) for event in events), default=0.0),
            2,
        )

        return {
            "sessionId": session["sessionId"],
            "detailId": session["sessionId"],
            "runId": session.get("runId", session["sessionId"]),
            "startedAtIso": session["startedAtIso"],
            "lastSeenAtIso": session["lastSeenAtIso"],
            "active": (now - session["lastSeenAt"]) <= self.active_session_window_s,
            "durationMs": max(server_duration_ms, runtime_duration_ms),
            "eventCount": session["eventCount"],
            "storedEventCount": len(events),
            "truncated": session["eventCount"] > len(events),
            "lastKind": session.get("lastKind", "IDLE"),
            "lastSessionState": last.get("sessionState", "-"),
            "lastWorldState": last.get("worldState", "-"),
            "lastTargetState": last.get("targetState", "-"),
            "lastVisualState": last.get("visualState", "-"),
            "lastMapState": last.get("mapState", "-"),
            "lastSource": last.get("source", "-"),
            "lastTargetName": last.get("targetName", "-"),
            "experimentId": last.get("experimentId", "-"),
            "hypothesis": last.get("hypothesis", ""),
            "presetId": last.get("presetId", "-"),
            "deviceLabel": last.get("deviceLabel", "-"),
            "runTag": last.get("runTag", "-"),
            "operatorNote": last.get("operatorNote", ""),
            "successCriteria": last.get("successCriteria", ""),
            "targetId": last.get("targetId", "-"),
            "programVersion": last.get("programVersion", "-"),
            "buildSignature": last.get("buildSignature", "-"),
            "trackingMode": last.get("trackingMode", "-"),
            "runtimeSnapshotCount": kind_counts.get("runtime-snapshot", 0),
            "transitionCount": kind_counts.get("transition", 0),
            "errorCount": kind_counts.get("error", 0),
            "kindCounts": dict(kind_counts),
            "sourceCounts": dict(source_counts),
            "dominantWorldState": most_common_text(events, "worldState"),
            "dominantTargetState": most_common_text(events, "targetState"),
            "dominantVisualState": most_common_text(events, "visualState"),
            "dominantMapState": most_common_text(events, "mapState"),
            "peakTargetUpdates": max_int_metric(events, "targetUpdates"),
            "peakTargetMatches": max_int_metric(events, "targetMatchCount"),
            "peakTargetInliers": max_int_metric(events, "targetInlierCount"),
            "peakTargetInlierRatio": max_float_metric(
                events, "targetInlierRatio", digits=3
            ),
            "peakTargetConfidence": max_float_metric(
                events, "targetConfidence", digits=3
            ),
            "peakTargetStableFrames": max_int_metric(events, "targetStableFrames"),
            "peakTargetPrelockMisses": max_int_metric(
                events, "targetPrelockMisses"
            ),
            "peakTargetBestInliers": max_int_metric(events, "targetBestInliers"),
            "peakTargetRefinedInliers": max_int_metric(
                events, "targetRefinedInliers"
            ),
            "dominantTargetRejectReason": most_common_text_excluding(
                events, "targetRejectReason", excluded={"NONE"}
            ),
            "peakTargetRawMatches": max_int_metric(events, "targetRawMatchCount"),
            "peakTargetReciprocalMatches": max_int_metric(
                events, "targetReciprocalMatchCount"
            ),
            "dominantTargetMatchStrategy": most_common_text_excluding(
                events, "targetMatchStrategy", excluded={"NONE"}
            ),
            "avgTrackAge": average_float_metric(
                events, "averageTrackAge", digits=3, ignore_zero=True
            ),
            "peakTrackAge": max_float_metric(
                events, "maxTrackAge", digits=3, ignore_zero=True
            ),
            "avgLongTrackRatio": average_float_metric(
                events, "longTrackRatio", digits=3
            ),
            "peakKeyframes": max_int_metric(events, "keyframeCount"),
            "peakLandmarks": max_int_metric(events, "landmarkCount"),
            "peakStaleLandmarkRatio": max_float_metric(
                events, "staleLandmarkRatio", digits=3
            ),
            "peakKeyframeGrowthPerSec": max_float_metric(
                events, "keyframeGrowthPerSec", digits=3, ignore_zero=True
            ),
            "peakLandmarkGrowthPerSec": max_float_metric(
                events, "landmarkGrowthPerSec", digits=3, ignore_zero=True
            ),
            "avgMotionObservability": average_float_metric(
                events, "motionObservability", digits=3
            ),
            "peakMotionObservability": max_float_metric(
                events, "motionObservability", digits=3
            ),
            "peakRelocalizationScore": max_float_metric(
                events, "relocalizationScore", digits=3
            ),
            "peakRelocalizationAttempts": max_int_metric(
                events, "relocalizationAttemptCount"
            ),
            "peakRelocalizationRecoveries": max_int_metric(
                events, "relocalizationRecoveryCount"
            ),
            "maxRelocalizationDurationMs": max_float_metric(
                events,
                "lastRelocalizationDurationMs",
                digits=2,
                ignore_zero=True,
            ),
            "avgMeasurementDeltaTranslationM": average_float_metric(
                events,
                "measurementDeltaTranslationM",
                digits=4,
                ignore_zero=True,
            ),
            "avgMeasurementDeltaRotationDeg": average_float_metric(
                events, "measurementDeltaRotationDeg", digits=3, ignore_zero=True
            ),
            "peakVisualQuality": max_float_metric(
                events, "visualQuality", digits=3
            ),
            "maxFps": max_float_metric(events, "xrFps", digits=1, ignore_zero=True),
            "avgFps": average_float_metric(
                events, "xrFps", digits=1, ignore_zero=True
            ),
            "avgFrameMs": average_float_metric(
                events, "frameTimeMs", digits=2, ignore_zero=True
            ),
            "avgCaptureMs": average_float_metric(
                events, "cameraAverageCaptureMs", digits=2, ignore_zero=True
            ),
            "avgVisualProcMs": average_float_metric(
                events, "visualProcMs", digits=2, ignore_zero=True
            ),
            "avgVisualQuality": average_float_metric(
                events, "visualQuality", digits=3
            ),
        }

    def persist_session(self, session, received_at, force=False):
        persist_due = force or (
            received_at - float(session.get("lastPersistedAt", 0.0)) >= 1.0
        )
        if not persist_due:
            return None
        run_id = str(
            session.get("runId")
            or self.lab_workspace.sanitize_run_id(session.get("sessionId"))
        )
        artifact_path = session.get("artifactPath") or os.path.join(
            self.lab_workspace.lab_runs_dir, f"{run_id}.json"
        )
        artifact_payload = {
            "updatedAtIso": iso_timestamp(received_at),
            "session": self.build_session_summary(session, now=received_at),
            "events": list(session.get("events", [])),
        }
        self.lab_workspace.write_json_file(artifact_path, artifact_payload)
        session["lastPersistedAt"] = received_at
        return artifact_path

    def live_summaries(self, now):
        return [
            self.build_session_summary(session, now=now)
            for session in reversed(list(self.store.values()))
        ]

    def list_sessions(self, now):
        summaries = OrderedDict()
        for session in self.live_summaries(now):
            summaries[session["runId"]] = session
        for artifact in self.lab_workspace.read_recent_run_artifacts(
            limit=max(self.session_history_limit, 10)
        ):
            summaries.setdefault(artifact["runId"], artifact)
        return list(summaries.values())

    def get_session_detail(self, detail_id, now):
        session = self.store.get(detail_id)
        if session is not None:
            return {
                "limits": self.build_limits_payload(),
                "session": self.build_session_summary(session, now=now),
                "events": list(session["events"]),
            }
        for live_session in self.store.values():
            if live_session.get("runId") == detail_id:
                return {
                    "limits": self.build_limits_payload(),
                    "session": self.build_session_summary(live_session, now=now),
                    "events": list(live_session["events"]),
                }
        artifact = self.lab_workspace.read_run_artifact(detail_id)
        if not isinstance(artifact, dict):
            return None
        summary = artifact.get("session") or {}
        summary.setdefault("detailId", summary.get("runId", detail_id))
        return {
            "limits": self.build_limits_payload(),
            "session": summary,
            "events": list(artifact.get("events") or []),
        }
