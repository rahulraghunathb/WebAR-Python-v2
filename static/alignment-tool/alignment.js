/**
 * 3D Model Alignment Tool
 *
 * CRITICAL: This tool uses the SAME coordinate system as the AR runtime:
 * - Origin: Center of target image
 * - X-axis: Right (positive)
 * - Y-axis: Up (positive) - Three.js/OpenGL convention
 * - Z-axis: Out of target toward camera (positive)
 * - Units: Meters (target defaults to 1m x 1m)
 *
 * The transform values exported here can be directly applied in the AR runtime
 * to position the 3D model relative to the detected target.
 */

class AlignmentTool {
    constructor() {
        // Asset paths (hardcoded as requested)
        this.targetImagePath = '/static/assets/ranger-base-image.jpg';
        this.modelPath = '/static/assets/ranger-3d-model.glb';

        // Target physical size (meters) - must match AR runtime
        this.targetWidth = 1.0;
        this.targetHeight = 1.0;

        // Three.js components
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.model = null;
        this.targetPlane = null;
        this.modelLoaded = false;

        // Transform state
        this.transform = {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },  // Euler angles in degrees
            scale: { x: 1, y: 1, z: 1 },
            uniformScale: 1
        };

        // Model's original bounding box (for normalization)
        this.modelOriginalSize = null;
        this.modelOriginalCenter = null;

        this.init();
    }

    init() {
        this.initThreeJS();
        this.loadTargetImage();
        this.loadModel();
        this.setupControls();
        this.setupEventListeners();
        this.updateOutput();
        this.animate();
    }

    initThreeJS() {
        const canvas = document.getElementById('alignmentCanvas');
        const container = canvas.parentElement;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a2e);

        // Camera - Perspective for alignment visualization
        const aspect = container.clientWidth / container.clientHeight;
        this.camera = new THREE.PerspectiveCamera(50, aspect, 0.01, 100);
        this.camera.position.set(0, 0.5, 2);
        this.camera.lookAt(0, 0, 0);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.outputEncoding = THREE.sRGBEncoding;

        // Lights
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambient);

        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(5, 10, 7);
        this.scene.add(dirLight);

        const backLight = new THREE.DirectionalLight(0xffffff, 0.3);
        backLight.position.set(-5, 5, -5);
        this.scene.add(backLight);

        // Orbit controls
        this.controls = new THREE.OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.target.set(0, 0, 0);

        // Grid helper (XZ plane, Y-up)
        const gridHelper = new THREE.GridHelper(2, 20, 0x444444, 0x333333);
        gridHelper.position.y = -this.targetHeight / 2 - 0.01;  // Just below target
        this.scene.add(gridHelper);

        // Axes helper at origin
        const axesHelper = new THREE.AxesHelper(0.3);
        this.scene.add(axesHelper);

        // Handle resize
        window.addEventListener('resize', () => this.onResize());
    }

    loadTargetImage() {
        const textureLoader = new THREE.TextureLoader();

        textureLoader.load(
            this.targetImagePath,
            (texture) => {
                texture.encoding = THREE.sRGBEncoding;

                // Calculate aspect ratio from loaded image
                const imgAspect = texture.image.width / texture.image.height;

                // Adjust target dimensions based on image aspect ratio
                // Keep width at 1m, adjust height
                this.targetHeight = this.targetWidth / imgAspect;

                // Create plane geometry for target
                const geometry = new THREE.PlaneGeometry(this.targetWidth, this.targetHeight);
                const material = new THREE.MeshBasicMaterial({
                    map: texture,
                    side: THREE.DoubleSide
                });

                this.targetPlane = new THREE.Mesh(geometry, material);
                // Target lies in XY plane, facing +Z (toward camera)
                // No rotation needed - PlaneGeometry faces +Z by default
                this.targetPlane.position.set(0, 0, 0);
                this.scene.add(this.targetPlane);

                // Add border to target
                const borderGeometry = new THREE.EdgesGeometry(geometry);
                const borderMaterial = new THREE.LineBasicMaterial({ color: 0x00c870 });
                const border = new THREE.LineSegments(borderGeometry, borderMaterial);
                this.targetPlane.add(border);

                console.log(`Target loaded: ${this.targetWidth}m x ${this.targetHeight.toFixed(3)}m`);
            },
            undefined,
            (error) => console.error('Failed to load target image:', error)
        );
    }

    loadModel() {
        const loader = new THREE.GLTFLoader();

        loader.load(
            this.modelPath,
            (gltf) => {
                this.model = gltf.scene;

                // Calculate original bounding box
                const box = new THREE.Box3().setFromObject(this.model);
                this.modelOriginalSize = box.getSize(new THREE.Vector3());
                this.modelOriginalCenter = box.getCenter(new THREE.Vector3());

                // Center the model at origin
                this.model.position.set(
                    -this.modelOriginalCenter.x,
                    -this.modelOriginalCenter.y,
                    -this.modelOriginalCenter.z
                );

                // IMPORTANT: Normalize model so max dimension = 1 unit
                // This MUST match what model-renderer.js does
                const maxDim = Math.max(
                    this.modelOriginalSize.x,
                    this.modelOriginalSize.y,
                    this.modelOriginalSize.z
                );
                this.modelNormalizeScale = 1.0 / maxDim;
                this.model.scale.setScalar(this.modelNormalizeScale);

                // Create wrapper group for alignment transforms
                // The wrapper handles position/rotation/scale from alignment controls
                // The inner model is already centered and normalized
                this.modelWrapper = new THREE.Group();
                this.modelWrapper.add(this.model);
                this.scene.add(this.modelWrapper);

                this.modelLoaded = true;

                // Apply initial transform
                this.applyTransform();

                console.log('Model loaded:', {
                    size: this.modelOriginalSize,
                    center: this.modelOriginalCenter,
                    normalizeScale: this.modelNormalizeScale
                });
            },
            undefined,
            (error) => console.error('Failed to load model:', error)
        );
    }

    setupControls() {
        // Position controls
        this.bindSliderPair('posX', 'posXNum', (val) => {
            this.transform.position.x = val;
            this.applyTransform();
        });
        this.bindSliderPair('posY', 'posYNum', (val) => {
            this.transform.position.y = val;
            this.applyTransform();
        });
        this.bindSliderPair('posZ', 'posZNum', (val) => {
            this.transform.position.z = val;
            this.applyTransform();
        });

        // Rotation controls
        this.bindSliderPair('rotX', 'rotXNum', (val) => {
            this.transform.rotation.x = val;
            this.applyTransform();
        });
        this.bindSliderPair('rotY', 'rotYNum', (val) => {
            this.transform.rotation.y = val;
            this.applyTransform();
        });
        this.bindSliderPair('rotZ', 'rotZNum', (val) => {
            this.transform.rotation.z = val;
            this.applyTransform();
        });

        // Scale controls
        this.bindSliderPair('scaleUniform', 'scaleUniformNum', (val) => {
            this.transform.uniformScale = val;
            if (!document.getElementById('nonUniformScale').checked) {
                this.transform.scale.x = val;
                this.transform.scale.y = val;
                this.transform.scale.z = val;
            }
            this.applyTransform();
        });

        this.bindSliderPair('scaleX', 'scaleXNum', (val) => {
            this.transform.scale.x = val;
            this.applyTransform();
        });
        this.bindSliderPair('scaleY', 'scaleYNum', (val) => {
            this.transform.scale.y = val;
            this.applyTransform();
        });
        this.bindSliderPair('scaleZ', 'scaleZNum', (val) => {
            this.transform.scale.z = val;
            this.applyTransform();
        });

        // Non-uniform scale toggle
        document.getElementById('nonUniformScale').addEventListener('change', (e) => {
            const controls = document.getElementById('nonUniformControls');
            controls.classList.toggle('hidden', !e.target.checked);
            if (!e.target.checked) {
                // Reset to uniform scale
                const uniform = this.transform.uniformScale;
                this.transform.scale = { x: uniform, y: uniform, z: uniform };
                this.updateSliderPair('scaleX', 'scaleXNum', uniform);
                this.updateSliderPair('scaleY', 'scaleYNum', uniform);
                this.updateSliderPair('scaleZ', 'scaleZNum', uniform);
                this.applyTransform();
            }
        });
    }

    bindSliderPair(sliderId, numberId, onChange) {
        const slider = document.getElementById(sliderId);
        const number = document.getElementById(numberId);

        slider.addEventListener('input', () => {
            const val = parseFloat(slider.value);
            number.value = val;
            onChange(val);
            this.updateOutput();
        });

        number.addEventListener('input', () => {
            const val = parseFloat(number.value) || 0;
            slider.value = val;
            onChange(val);
            this.updateOutput();
        });
    }

    updateSliderPair(sliderId, numberId, value) {
        document.getElementById(sliderId).value = value;
        document.getElementById(numberId).value = value;
    }

    setupEventListeners() {
        // Reset button
        document.getElementById('resetBtn').addEventListener('click', () => {
            this.resetTransform();
        });

        // Center button
        document.getElementById('centerBtn').addEventListener('click', () => {
            this.transform.position = { x: 0, y: 0, z: 0 };
            this.updateSliderPair('posX', 'posXNum', 0);
            this.updateSliderPair('posY', 'posYNum', 0);
            this.updateSliderPair('posZ', 'posZNum', 0);
            this.applyTransform();
            this.updateOutput();
        });

        // Flip buttons
        document.getElementById('flipXBtn').addEventListener('click', () => {
            this.transform.scale.x *= -1;
            this.updateSliderPair('scaleX', 'scaleXNum', this.transform.scale.x);
            this.applyTransform();
            this.updateOutput();
        });
        document.getElementById('flipYBtn').addEventListener('click', () => {
            this.transform.scale.y *= -1;
            this.updateSliderPair('scaleY', 'scaleYNum', this.transform.scale.y);
            this.applyTransform();
            this.updateOutput();
        });
        document.getElementById('flipZBtn').addEventListener('click', () => {
            this.transform.scale.z *= -1;
            this.updateSliderPair('scaleZ', 'scaleZNum', this.transform.scale.z);
            this.applyTransform();
            this.updateOutput();
        });

        // Rotate 90 buttons
        document.getElementById('rotate90XBtn').addEventListener('click', () => {
            this.transform.rotation.x = (this.transform.rotation.x + 90) % 360;
            if (this.transform.rotation.x > 180) this.transform.rotation.x -= 360;
            this.updateSliderPair('rotX', 'rotXNum', this.transform.rotation.x);
            this.applyTransform();
            this.updateOutput();
        });
        document.getElementById('rotate90YBtn').addEventListener('click', () => {
            this.transform.rotation.y = (this.transform.rotation.y + 90) % 360;
            if (this.transform.rotation.y > 180) this.transform.rotation.y -= 360;
            this.updateSliderPair('rotY', 'rotYNum', this.transform.rotation.y);
            this.applyTransform();
            this.updateOutput();
        });
        document.getElementById('rotate90ZBtn').addEventListener('click', () => {
            this.transform.rotation.z = (this.transform.rotation.z + 90) % 360;
            if (this.transform.rotation.z > 180) this.transform.rotation.z -= 360;
            this.updateSliderPair('rotZ', 'rotZNum', this.transform.rotation.z);
            this.applyTransform();
            this.updateOutput();
        });

        // Output format change
        document.getElementById('outputFormat').addEventListener('change', () => {
            this.updateOutput();
        });

        // Copy button
        document.getElementById('copyBtn').addEventListener('click', () => {
            this.copyToClipboard();
        });
    }

    resetTransform() {
        this.transform = {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            uniformScale: 1
        };

        // Update all sliders
        this.updateSliderPair('posX', 'posXNum', 0);
        this.updateSliderPair('posY', 'posYNum', 0);
        this.updateSliderPair('posZ', 'posZNum', 0);
        this.updateSliderPair('rotX', 'rotXNum', 0);
        this.updateSliderPair('rotY', 'rotYNum', 0);
        this.updateSliderPair('rotZ', 'rotZNum', 0);
        this.updateSliderPair('scaleUniform', 'scaleUniformNum', 1);
        this.updateSliderPair('scaleX', 'scaleXNum', 1);
        this.updateSliderPair('scaleY', 'scaleYNum', 1);
        this.updateSliderPair('scaleZ', 'scaleZNum', 1);

        document.getElementById('nonUniformScale').checked = false;
        document.getElementById('nonUniformControls').classList.add('hidden');

        this.applyTransform();
        this.updateOutput();
    }

    applyTransform() {
        if (!this.modelWrapper) return;

        // Position (in meters, relative to target center)
        this.modelWrapper.position.set(
            this.transform.position.x,
            this.transform.position.y,
            this.transform.position.z
        );

        // Rotation (convert degrees to radians)
        // Use XYZ order for consistency with AR runtime
        this.modelWrapper.rotation.set(
            THREE.MathUtils.degToRad(this.transform.rotation.x),
            THREE.MathUtils.degToRad(this.transform.rotation.y),
            THREE.MathUtils.degToRad(this.transform.rotation.z),
            'XYZ'
        );

        // Scale on wrapper
        // The inner model is already normalized (maxDim = 1)
        // So scale=1 means the model is 1 meter in its largest dimension
        // This matches the AR runtime behavior exactly
        const useNonUniform = document.getElementById('nonUniformScale').checked;
        if (useNonUniform) {
            this.modelWrapper.scale.set(
                this.transform.scale.x,
                this.transform.scale.y,
                this.transform.scale.z
            );
        } else {
            this.modelWrapper.scale.setScalar(this.transform.uniformScale);
        }
    }

    /**
     * Compute quaternion from Euler angles (for export)
     */
    eulerToQuaternion(rotX, rotY, rotZ) {
        const euler = new THREE.Euler(
            THREE.MathUtils.degToRad(rotX),
            THREE.MathUtils.degToRad(rotY),
            THREE.MathUtils.degToRad(rotZ),
            'XYZ'
        );
        const quat = new THREE.Quaternion().setFromEuler(euler);
        return {
            x: quat.x,
            y: quat.y,
            z: quat.z,
            w: quat.w
        };
    }

    /**
     * Get the full 4x4 transformation matrix
     */
    getMatrix4() {
        if (!this.modelWrapper) return null;

        // Update world matrix
        this.modelWrapper.updateMatrixWorld(true);

        // Return as array (column-major for Three.js)
        return this.modelWrapper.matrix.elements.slice();
    }

    updateOutput() {
        const format = document.getElementById('outputFormat').value;
        const outputEl = document.getElementById('outputCode');

        const useNonUniform = document.getElementById('nonUniformScale').checked;
        const quaternion = this.eulerToQuaternion(
            this.transform.rotation.x,
            this.transform.rotation.y,
            this.transform.rotation.z
        );

        let output = '';

        switch (format) {
            case 'json':
                output = this.formatJSON(quaternion, useNonUniform);
                break;
            case 'js':
                output = this.formatJS(quaternion, useNonUniform);
                break;
            case 'threejs':
                output = this.formatThreeJS(useNonUniform);
                break;
        }

        outputEl.textContent = output;
    }

    formatJSON(quaternion, useNonUniform) {
        const data = {
            position: {
                x: parseFloat(this.transform.position.x.toFixed(4)),
                y: parseFloat(this.transform.position.y.toFixed(4)),
                z: parseFloat(this.transform.position.z.toFixed(4))
            },
            rotation: {
                euler: {
                    x: parseFloat(this.transform.rotation.x.toFixed(2)),
                    y: parseFloat(this.transform.rotation.y.toFixed(2)),
                    z: parseFloat(this.transform.rotation.z.toFixed(2)),
                    order: 'XYZ'
                },
                quaternion: {
                    x: parseFloat(quaternion.x.toFixed(6)),
                    y: parseFloat(quaternion.y.toFixed(6)),
                    z: parseFloat(quaternion.z.toFixed(6)),
                    w: parseFloat(quaternion.w.toFixed(6))
                }
            },
            scale: useNonUniform ? {
                x: parseFloat(this.transform.scale.x.toFixed(4)),
                y: parseFloat(this.transform.scale.y.toFixed(4)),
                z: parseFloat(this.transform.scale.z.toFixed(4))
            } : parseFloat(this.transform.uniformScale.toFixed(4))
        };

        return JSON.stringify(data, null, 2);
    }

    formatJS(quaternion, useNonUniform) {
        const scaleStr = useNonUniform
            ? `{ x: ${this.transform.scale.x.toFixed(4)}, y: ${this.transform.scale.y.toFixed(4)}, z: ${this.transform.scale.z.toFixed(4)} }`
            : this.transform.uniformScale.toFixed(4);

        // Convert degrees to radians for direct use in AR runtime
        const rotXRad = THREE.MathUtils.degToRad(this.transform.rotation.x);
        const rotYRad = THREE.MathUtils.degToRad(this.transform.rotation.y);
        const rotZRad = THREE.MathUtils.degToRad(this.transform.rotation.z);

        return `// Model alignment configuration for AR runtime
// Paste this into model-renderer.js constructor's this.alignment
// Coordinate system: Target-centered, Y-up (Three.js)
this.alignment = {
    position: { x: ${this.transform.position.x.toFixed(4)}, y: ${this.transform.position.y.toFixed(4)}, z: ${this.transform.position.z.toFixed(4)} },
    rotation: { x: ${rotXRad.toFixed(6)}, y: ${rotYRad.toFixed(6)}, z: ${rotZRad.toFixed(6)} },  // ${this.transform.rotation.x.toFixed(1)}°, ${this.transform.rotation.y.toFixed(1)}°, ${this.transform.rotation.z.toFixed(1)}°
    scale: ${scaleStr}
};`;
    }

    formatThreeJS(useNonUniform) {
        const scaleCode = useNonUniform
            ? `model.scale.set(${this.transform.scale.x.toFixed(4)}, ${this.transform.scale.y.toFixed(4)}, ${this.transform.scale.z.toFixed(4)});`
            : `model.scale.setScalar(${this.transform.uniformScale.toFixed(4)});`;

        return `// Apply alignment to Three.js model
// Position (meters from target center)
model.position.set(
    ${this.transform.position.x.toFixed(4)},
    ${this.transform.position.y.toFixed(4)},
    ${this.transform.position.z.toFixed(4)}
);

// Rotation (Euler XYZ, radians)
model.rotation.set(
    ${THREE.MathUtils.degToRad(this.transform.rotation.x).toFixed(6)},  // ${this.transform.rotation.x}°
    ${THREE.MathUtils.degToRad(this.transform.rotation.y).toFixed(6)},  // ${this.transform.rotation.y}°
    ${THREE.MathUtils.degToRad(this.transform.rotation.z).toFixed(6)},  // ${this.transform.rotation.z}°
    'XYZ'
);

// Scale
${scaleCode}`;
    }

    async copyToClipboard() {
        const outputEl = document.getElementById('outputCode');
        const copyBtn = document.getElementById('copyBtn');
        const copyText = document.getElementById('copyText');

        try {
            await navigator.clipboard.writeText(outputEl.textContent);

            // Visual feedback
            copyBtn.classList.add('copied');
            copyText.textContent = 'Copied!';

            setTimeout(() => {
                copyBtn.classList.remove('copied');
                copyText.textContent = 'Copy to Clipboard';
            }, 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
            copyText.textContent = 'Copy failed';
            setTimeout(() => {
                copyText.textContent = 'Copy to Clipboard';
            }, 2000);
        }
    }

    onResize() {
        const container = this.renderer.domElement.parentElement;
        const width = container.clientWidth;
        const height = container.clientHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.alignmentTool = new AlignmentTool();
});
