# WebAR Research Program

## Mission
Create a repeatable phone-testing loop for image-target WebAR until target lock is fast, stable, and recoverable.

## Current Hypothesis
If we prefer reciprocal matches when they are healthy but fall back to the fuller forward match set when reciprocity is too sparse, we should preserve usable correspondences while still exposing the real solver reject stage.

## Active Target
- id: ranger-poster
- physical width: 0.20 m

## Standard Mobile Loop
1. Open the experimental room on desktop.
2. Open the AR runtime on the phone using the same network URL.
3. Start one run with the current experiment preset.
4. Start 35 to 55 cm away and keep the full poster inside the frame.
5. Move in slowly until DETECTED, keeping the full poster crisp and sharply framed, then hold the phone very still for 1 to 2 seconds.
6. Once lock happens, force one brief loss and reacquire.
7. Review latest run metrics before changing any knob.

## Success Criteria
- recover non-zero target inliers from the reciprocal-or-forward match pool
- record at least one committed target update from that solve
- transition into TRACKING without remaining stuck in DETECTED-only mode
- if lock still fails, capture a clear reject reason plus raw-versus-reciprocal match counts
- complete one clean reacquire if lock happens
- visual quality stays above 0.45 for most of the run

## Notes
- Keep edits small.
- Compare against the previous run before changing the hypothesis.
