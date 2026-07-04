# WebAR SDK - slim OpenCV.js bindings whitelist
#
# Exactly what static/sdk/vision/pipeline.js calls - nothing else.
# Used with: opencv/platforms/js/build_js.py --config <this file>
#            --cmake_option="-DBUILD_LIST=core,imgproc,features2d,calib3d,video,flann"
#
# (makeWhiteList is injected by the embind generator before exec'ing this.)

core = {
    '': [
        'perspectiveTransform',   # corner projection + homography reproj error
    ],
    'Algorithm': [],
}

imgproc = {
    '': [
        'cvtColor',               # RGBA -> gray
        'resize',                 # target pyramid levels
    ],
}

features2d = {
    'Feature2D': ['detect', 'compute', 'detectAndCompute', 'descriptorSize',
                  'descriptorType', 'defaultNorm', 'empty', 'getDefaultName'],
    'ORB': ['create', 'setMaxFeatures', 'setScaleFactor', 'setNLevels',
            'setEdgeThreshold', 'setFastThreshold', 'setFirstLevel', 'setWTA_K',
            'setScoreType', 'setPatchSize', 'getFastThreshold', 'getDefaultName'],
    'DescriptorMatcher': ['add', 'clear', 'empty', 'isMaskSupported', 'train',
                          'match', 'knnMatch', 'radiusMatch', 'clone', 'create'],
    'BFMatcher': ['isMaskSupported', 'create'],
}

calib3d = {
    '': [
        'findHomography',         # RANSAC fit (detect + track)
        'solvePnP',               # pose (IPPE acquisition, iterative tracking)
        'Rodrigues',              # rvec -> rotation matrix
        'projectPoints',          # reprojection error check
    ],
}

video = {
    '': [
        'calcOpticalFlowPyrLK',   # KLT tracking with forward-backward check
    ],
}

white_list = makeWhiteList([core, imgproc, features2d, calib3d, video])
