# Codebase Audit

Date: 2026-03-06

## Scope

Reviewed the current repo after switching back from the strict WebXR runtime to the repo-owned tracker path.

## Executive Summary

The codebase now contains a real custom image-tracking pipeline again:
- browser camera capture
- per-client Socket.IO transport
- OpenCV ORB matching
- `solvePnPRansac` pose estimation
- Three.js rendering with IMU-assisted prediction

This is a meaningful step toward owning the AR stack, but it is still an image tracker, not a complete SLAM system.

## Current Strengths

1. Tracking is no longer gated by browser WebXR support.
2. Camera permission is explicit and user-driven.
3. Backend sessions are isolated per socket.
4. Model transform logic is shared with the alignment tool.
5. The custom tracker path is now described consistently across the repo docs.

## Remaining Gaps

### 1. Full SLAM is still not present
Severity: critical

The repo owns target tracking, but it still does not implement:
- keyframe mapping
- relocalization
- persistent anchors without the target
- visual-inertial optimization over time

### 2. Camera intrinsics are still heuristic
Severity: high

`static/js/camera-intrinsics.js` estimates FOV from device class heuristics.

This is workable, but it is still a source of scale and alignment error.

### 3. Frame transport still uses JPEG + base64
Severity: high

The custom path is application-controlled, but it still pays the cost of:
- 2D canvas copy
- JPEG encode
- base64 expansion
- Socket.IO transport overhead

### 4. Tracking depends on the image target remaining observable
Severity: medium

The model can be predicted briefly with IMU assistance, but the system still needs the target image to reacquire strong pose.

## Implementation Plan

### Phase 1: Harden The Custom Tracker
1. keep the restored tracker path stable
2. improve runtime logs and session diagnostics
3. verify printed target size and alignment values

### Phase 2: Cut Transport Latency
1. replace JPEG/base64 with binary transport
2. reuse frame buffers aggressively
3. tune frame sizing and send cadence

### Phase 3: Improve Pose Quality
1. improve intrinsics calibration
2. add better rotation and translation filtering
3. add client-visible tracking quality diagnostics

### Phase 4: Start Real SLAM Work
1. add short-term feature track persistence
2. add keyframe storage
3. add relocalization against stored map points
4. add target-independent anchors

## Bottom Line

The repo now has a custom tracker path again.

It does not yet have the full SLAM system implied by the original goal, but the active code is now under repo control instead of being blocked by browser-native WebXR support.
