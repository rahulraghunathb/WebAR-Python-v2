import cv2
import numpy as np
import pickle
import os
import argparse
import time
from src.detectors.orb_detector import ORBDetector

def preprocess_image(image_path, output_path, n_features=4000):
    """
    Offline preprocessing of target image.
    Extracts multi-scale features and saves as a compressed binary blob.
    """
    print(f"Reading target image: {image_path}")
    img = cv2.imread(image_path)
    if img is None:
        print(f"Error: Could not read image {image_path}")
        return False

    h, w = img.shape[:2]
    SCALES = [1.0, 0.75, 0.5, 0.4, 0.3]
    
    # Initialize detector with higher feature count for better offline extraction
    detector = ORBDetector(n_features=n_features)
    
    pyramid_data = []
    total_kp = 0
    
    start_time = time.time()
    
    for scale in SCALES:
        if scale == 1.0:
            scaled = img
        else:
            scaled = cv2.resize(img, (int(w * scale), int(h * scale)))
        
        kp, desc = detector.detect_and_compute(scaled)
        
        if desc is not None and len(kp) >= 4:
            # Store keypoint data in a serializable format
            # kp.pt, kp.size, kp.angle, kp.response, kp.octave, kp.class_id
            kp_serializable = []
            for k in kp:
                # Scale keypoints back to original size during storage
                # This matches current ImageProcessor behavior
                kp_serializable.append({
                    'pt': (k.pt[0]/scale, k.pt[1]/scale),
                    'size': k.size,
                    'angle': k.angle,
                    'response': k.response,
                    'octave': k.octave,
                    'class_id': k.class_id
                })
            
            pyramid_data.append({
                'scale': scale,
                'keypoints': kp_serializable,
                'descriptors': desc
            })
            total_kp += len(kp)
            print(f"  Scale {scale:.2f}: {len(kp)} keypoints")
    
    if not pyramid_data:
        print("Error: No features extracted!")
        return False
    
    # Bundle everything
    data_blob = {
        'version': '1.0',
        'original_size': (w, h),
        'pyramid': pyramid_data,
        'detector_type': 'ORB',
        'timestamp': time.time()
    }
    
    # Save as compressed pickle
    print(f"Saving to {output_path}...")
    with open(output_path, 'wb') as f:
        pickle.dump(data_blob, f, protocol=pickle.HIGHEST_PROTOCOL)
    
    duration = time.time() - start_time
    file_size = os.path.getsize(output_path) / 1024
    
    print(f"Successfully processed image in {duration:.2f}s")
    print(f"Total keypoints: {total_kp}")
    print(f"Output size: {file_size:.2f} KB")
    
    return True

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WebAR Target Image Preprocessor")
    parser.add_argument("input", help="Path to input image (e.g., static/assets/target.jpg)")
    parser.add_argument("--output", help="Path to output blob (default: same as input with .webarimg)")
    parser.add_argument("--features", type=int, default=4000, help="Number of features to extract per scale")
    
    args = parser.parse_args()
    
    output = args.output
    if not output:
        base, _ = os.path.splitext(args.input)
        output = base + ".webarimg"
        
    preprocess_image(args.input, output, args.features)
