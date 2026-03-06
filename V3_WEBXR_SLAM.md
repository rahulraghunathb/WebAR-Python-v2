# Custom Tracker Path Note

Date: 2026-03-06

## Status

The old WebXR-only runtime is no longer the active path.

The application now runs on a custom tracker stack based on browser camera capture plus Python OpenCV pose estimation.

## Active Tracking Path

- camera capture in the browser
- Socket.IO transport
- ORB feature matching on the backend
- homography validation
- `solvePnPRansac` pose estimation
- Three.js rendering with IMU assistance

## What Changed

Previous active idea:
- rely on browser-native WebXR AR
- fail when `immersive-ar` or tracked-image support is missing

Current active idea:
- rely on explicit camera permission and the repo-owned CV pipeline
- run without WebXR support
- keep the runtime under application control

## What This Enables

- browser compatibility beyond native WebXR AR
- explicit camera permission flow
- application-level control over the tracking pipeline
- continued use of the alignment tool and shared transform profile

## What Still Does Not Exist

This is still not a full SLAM implementation.

Not yet implemented:
- map persistence
- relocalization
- world anchors independent of the target image
- large-scale visual-inertial optimization

## Practical Description

The repo now has a custom tracker path.

It does not yet have a full 8th Wall-style SLAM engine.
