"""
WebAR Target Compiler

Compiles a target image into the binary `.webart` format consumed by the
client-side SDK (static/sdk/vision/webart-format.js documents the layout).
This is the offline/cloud half of the product: extraction quality here is
not constrained by the user's device.

Also (optionally) writes the legacy `.webarimg` pickle used by the
server-side fallback pipeline.

Usage:
    python preprocess_target.py static/assets/ranger-base-image.jpg
    python preprocess_target.py poster.jpg --features 2000 --width-m 0.42
"""

import argparse
import os
import pickle
import struct
import time

import cv2
import numpy as np

# Must match the SDK pipeline scales (static/sdk/vision/pipeline.js).
# Sparse on purpose: ORB's internal 8-level pyramid covers intermediates.
SCALES = [1.0, 0.5, 0.3]

WEBART_MAGIC = b"WART"
WEBART_VERSION = 1


def physical_size(w, h, width_m=None):
    """Physical target size in meters. If the real printed width is given,
    use it; otherwise normalize the longest side to 1m (SDK default)."""
    aspect = w / h
    if width_m:
        return width_m, width_m / aspect
    if w >= h:
        return 1.0, 1.0 / aspect
    return aspect, 1.0


def extract_pyramid(img, n_features):
    """Multi-scale ORB extraction, keypoints scaled back to full-res px."""
    h, w = img.shape[:2]
    orb = cv2.ORB_create(nfeatures=n_features)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    levels = []
    for scale in SCALES:
        scaled = gray if scale == 1.0 else cv2.resize(
            gray, (int(w * scale), int(h * scale)))
        kp, desc = orb.detectAndCompute(scaled, None)
        if desc is None or len(kp) < 4:
            print(f"  Scale {scale:.2f}: insufficient features, skipped")
            continue
        # Sub-pixel refine the TARGET-side keypoints (precisionV2): the
        # runtime refines the scene side of each correspondence onto its
        # physical corner - the anchored pair is only consistent if the
        # target side is refined onto the same corner too. ORB positions
        # are pyramid-quantized (~0.5-1px); this removes that floor.
        pts = np.array([k.pt for k in kp], dtype=np.float32).reshape(-1, 1, 2)
        refined = cv2.cornerSubPix(
            scaled, pts.copy(), (5, 5), (-1, -1),
            (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 8, 0.03))
        # reject refinements that jumped onto a different corner (> 1.5px)
        for i, k in enumerate(kp):
            dx = refined[i, 0, 0] - pts[i, 0, 0]
            dy = refined[i, 0, 1] - pts[i, 0, 1]
            if dx * dx + dy * dy <= 2.25:
                k.pt = (float(refined[i, 0, 0]), float(refined[i, 0, 1]))
        levels.append({"scale": scale, "keypoints": kp, "descriptors": desc})
        print(f"  Scale {scale:.2f}: {len(kp)} keypoints (subpixel-refined)")
    return levels


def write_webart(path, img_w, img_h, phys_w, phys_h, levels):
    """Serialize to the binary .webart format (little-endian)."""
    with open(path, "wb") as f:
        f.write(WEBART_MAGIC)
        f.write(struct.pack("<IIIffI", WEBART_VERSION, img_w, img_h,
                            phys_w, phys_h, len(levels)))
        for lv in levels:
            kp, desc, scale = lv["keypoints"], lv["descriptors"], lv["scale"]
            f.write(struct.pack("<fI", scale, len(kp)))
            pts = []
            for k in kp:
                pts.append(k.pt[0] / scale)  # back to full-res coords
                pts.append(k.pt[1] / scale)
            f.write(struct.pack(f"<{len(pts)}f", *pts))
            f.write(desc.astype("uint8").tobytes())
    return os.path.getsize(path)


def write_legacy_pickle(path, img_w, img_h, levels):
    """Legacy .webarimg pickle for the server-side fallback pipeline."""
    pyramid_data = []
    for lv in levels:
        kp_serializable = [{
            "pt": (k.pt[0] / lv["scale"], k.pt[1] / lv["scale"]),
            "size": k.size, "angle": k.angle, "response": k.response,
            "octave": k.octave, "class_id": k.class_id,
        } for k in lv["keypoints"]]
        pyramid_data.append({
            "scale": lv["scale"],
            "keypoints": kp_serializable,
            "descriptors": lv["descriptors"],
        })
    blob = {
        "version": "1.0",
        "original_size": (img_w, img_h),
        "pyramid": pyramid_data,
        "detector_type": "ORB",
        "timestamp": time.time(),
    }
    with open(path, "wb") as f:
        pickle.dump(blob, f, protocol=pickle.HIGHEST_PROTOCOL)
    return os.path.getsize(path)


def compile_target(image_path, output_path=None, n_features=2000,
                   width_m=None, legacy=True):
    print(f"Reading target image: {image_path}")
    img = cv2.imread(image_path)
    if img is None:
        print(f"Error: Could not read image {image_path}")
        return False

    h, w = img.shape[:2]
    phys_w, phys_h = physical_size(w, h, width_m)
    print(f"Target: {w}x{h}px, physical {phys_w:.3f}m x {phys_h:.3f}m")

    t0 = time.time()
    levels = extract_pyramid(img, n_features)
    if not levels:
        print("Error: No features extracted!")
        return False

    base, _ = os.path.splitext(image_path)
    out = output_path or (base + ".webart")
    size = write_webart(out, w, h, phys_w, phys_h, levels)
    total = sum(len(lv["keypoints"]) for lv in levels)
    print(f"OK {out}  ({size / 1024:.1f} KB, {total} keypoints, "
          f"{time.time() - t0:.2f}s)")

    if legacy:
        legacy_path = base + ".webarimg"
        lsize = write_legacy_pickle(legacy_path, w, h, levels)
        print(f"OK {legacy_path}  ({lsize / 1024:.1f} KB, legacy server format)")

    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WebAR Target Compiler")
    parser.add_argument("input", help="Path to target image")
    parser.add_argument("--output", help="Output .webart path (default: alongside input)")
    parser.add_argument("--features", type=int, default=2000,
                        help="ORB features per scale (default 2000, matches runtime)")
    parser.add_argument("--width-m", type=float, default=None,
                        help="Real printed width in meters (default: longest side = 1m)")
    parser.add_argument("--no-legacy", action="store_true",
                        help="Skip writing the legacy .webarimg pickle")
    args = parser.parse_args()

    compile_target(args.input, args.output, args.features,
                   args.width_m, legacy=not args.no_legacy)
