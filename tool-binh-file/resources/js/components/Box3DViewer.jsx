import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const PAPER_MATERIALS = {
  ivory: { name: 'Ivory Trắng', outer: 0xf8fafc, inner: 0xe2e8f0, roughness: 0.55 },
  kraft: { name: 'Kraft Nâu', outer: 0xc29b6e, inner: 0xa67c52, roughness: 0.85 },
  duplex: { name: 'Duplex Trắng/Xám', outer: 0xf8fafc, inner: 0x94a3b8, roughness: 0.65 },
  matteBlack: { name: 'Đen Nhám Cao Cấp', outer: 0x1e293b, inner: 0x0f172a, roughness: 0.75 },
};

/**
 * Create a planar Three.js Mesh for a 2D panel polygon with exact UV mapping to the flat dieline sheet.
 * Outer face (-Y when flat) gets the artwork texture; inner face (+Y when flat) gets raw cardboard.
 */
function buildPanelMesh(polygon, bounds, outerMat, innerMat, thicknessMm) {
  const group = new THREE.Group();
  const shape = new THREE.Shape();

  // Polygon points (x, y) in mm -> XZ plane (X = x, Z = y)
  // Shape uses (x, -y) so when rotated -PI/2 around X, (x, -y, 0) -> (x, 0, y)
  polygon.forEach(([px, py], idx) => {
    if (idx === 0) shape.moveTo(px, -py);
    else shape.lineTo(px, -py);
  });
  shape.closePath();

  const makeGeo = (flipNormal) => {
    const geo = new THREE.ShapeGeometry(shape);
    // Assign exact planar UVs normalized to full flat sheet [0..bounds.width] x [0..bounds.height]
    const pos = geo.attributes.position;
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = -pos.getY(i); // original 2D y (0 at top -> height at bottom)
      uvs[i * 2] = x / Math.max(1, bounds.width);
      uvs[i * 2 + 1] = 1 - y / Math.max(1, bounds.height);
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.rotateX(-Math.PI / 2); // now lies in XZ plane with normal +Y

    if (flipNormal) {
      // Flip triangle winding so normal faces -Y (OUTSIDE once folded upward!)
      const index = geo.index;
      if (index) {
        const arr = index.array;
        for (let i = 0; i < arr.length; i += 3) {
          const tmp = arr[i + 1];
          arr[i + 1] = arr[i + 2];
          arr[i + 2] = tmp;
        }
        index.needsUpdate = true;
      }
      geo.computeVertexNormals();
    }
    return geo;
  };

  const halfT = Math.max(0.15, thicknessMm / 2);

  // Inner cardboard face (+Y)
  const innerMesh = new THREE.Mesh(makeGeo(false), innerMat);
  innerMesh.position.y = halfT;
  innerMesh.castShadow = true;
  innerMesh.receiveShadow = true;
  group.add(innerMesh);

  // Outer printed artwork face (-Y)
  const outerMesh = new THREE.Mesh(makeGeo(true), outerMat);
  outerMesh.position.y = -halfT;
  outerMesh.castShadow = true;
  outerMesh.receiveShadow = true;
  group.add(outerMesh);

  // Subtle edge outline
  const edgePoints = polygon.map(([px, py]) => new THREE.Vector3(px, 0, py));
  edgePoints.push(edgePoints[0].clone());
  const lineGeo = new THREE.BufferGeometry().setFromPoints(edgePoints);
  const lineMat = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.4 });
  group.add(new THREE.Line(lineGeo, lineMat));

  return group;
}

/**
 * Recursively build hierarchical hinge-pivot Scene Graph so every child rotates around its exact crease edge.
 */
function buildFoldHierarchy(node, bounds, outerMat, innerMat, thicknessMm, animNodes, parentOrigin = [0, 0]) {
  const pivot = new THREE.Group();

  if (node.hinge) {
    const [x1, y1] = node.hinge.p1;
    const [x2, y2] = node.hinge.p2;
    pivot.position.set(x1 - parentOrigin[0], 0, y1 - parentOrigin[1]);

    // Unit hinge axis in XZ plane
    const axis = new THREE.Vector3(x2 - x1, 0, y2 - y1).normalize();

    // Auto-sign fold direction using centroid so the panel ALWAYS folds UPWARD (+Y)
    let cx = 0, cy = 0;
    for (const [px, py] of node.polygon) {
      cx += px;
      cy += py;
    }
    cx /= node.polygon.length;
    cy /= node.polygon.length;

    const vx = cx - x1;
    const vz = cy - y1;
    // (axis × v).y = axis.z * vx - axis.x * vz
    const crossY = axis.z * vx - axis.x * vz;
    const sign = crossY >= 0 ? 1 : -1;

    animNodes.push({
      pivot,
      axis,
      targetRad: sign * ((node.foldAngleDeg * Math.PI) / 180),
      window: node.foldWindow || [0, 1],
    });

    // Shift polygon & children into local coordinates relative to hinge p1
    const localPoly = node.polygon.map(([px, py]) => [px - x1, py - y1]);
    pivot.add(buildPanelMesh(localPoly, bounds, outerMat, innerMat, thicknessMm));

    for (const child of node.children || []) {
      pivot.add(buildFoldHierarchy(child, bounds, outerMat, innerMat, thicknessMm, animNodes, [x1, y1]));
    }
  } else {
    // Root panel centered around its own polygon center
    let cx = 0, cy = 0;
    for (const [px, py] of node.polygon) {
      cx += px;
      cy += py;
    }
    cx /= node.polygon.length;
    cy /= node.polygon.length;

    const localPoly = node.polygon.map(([px, py]) => [px - cx, py - cy]);
    pivot.add(buildPanelMesh(localPoly, bounds, outerMat, innerMat, thicknessMm));

    for (const child of node.children || []) {
      pivot.add(buildFoldHierarchy(child, bounds, outerMat, innerMat, thicknessMm, animNodes, [cx, cy]));
    }
  }

  return pivot;
}

export default function Box3DViewer({
  dieline,
  foldProgress = 1, // 0..1
  materialKey = 'ivory',
  artworkDataUrl = null,
  cameraPreset = 'iso',
}) {
  const mountRef = useRef(null);
  const stateRef = useRef({ animNodes: [], rootWrapper: null, camera: null, controls: null, renderer: null, scene: null });

  // 1. Initialize Three.js Scene once
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 720;
    const height = container.clientHeight || 520;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d12);

    const camera = new THREE.PerspectiveCamera(40, width / height, 1, 4000);
    camera.position.set(220, 190, 260);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 60;
    controls.maxDistance = 1200;

    // Studio Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.72);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(250, 380, 220);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.45);
    fillLight.position.set(-220, 150, -180);
    scene.add(fillLight);

    // Subtle studio floor grid
    const grid = new THREE.GridHelper(600, 24, 0x334155, 0x1e293b);
    grid.position.y = -85;
    scene.add(grid);

    stateRef.current.scene = scene;
    stateRef.current.camera = camera;
    stateRef.current.controls = controls;
    stateRef.current.renderer = renderer;

    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 720;
      const h = container.clientHeight || 520;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      controls.dispose();
      renderer.dispose();
    };
  }, []);

  // 2. Rebuild 3D Box Geometry when dieline / material / artwork changes
  useEffect(() => {
    const { scene, rootWrapper } = stateRef.current;
    if (!scene || !dieline) return;

    if (rootWrapper) {
      scene.remove(rootWrapper);
    }

    const preset = PAPER_MATERIALS[materialKey] || PAPER_MATERIALS.ivory;
    const innerMat = new THREE.MeshStandardMaterial({
      color: preset.inner,
      roughness: preset.roughness,
      metalness: 0.02,
    });

    const outerMat = new THREE.MeshStandardMaterial({
      color: artworkDataUrl ? 0xffffff : preset.outer,
      roughness: preset.roughness * 0.9,
      metalness: 0.04,
    });

    if (artworkDataUrl) {
      const loader = new THREE.TextureLoader();
      loader.load(artworkDataUrl, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        outerMat.map = tex;
        outerMat.needsUpdate = true;
      });
    }

    const animNodes = [];
    const wrapper = new THREE.Group();
    const boxHierarchy = buildFoldHierarchy(
      dieline.rootPanel,
      dieline.bounds,
      outerMat,
      innerMat,
      dieline.params.thickness || 0.4,
      animNodes
    );

    wrapper.add(boxHierarchy);
    // Stand RTE/STE upright when folded, or keep flat when unfolded
    wrapper.rotation.x = (dieline.uprightRotateX || 0) * foldProgress;
    scene.add(wrapper);

    stateRef.current.rootWrapper = wrapper;
    stateRef.current.animNodes = animNodes;

    // Immediately apply current fold progress
    applyFoldToNodes(animNodes, wrapper, dieline.uprightRotateX || 0, foldProgress);
  }, [dieline, materialKey, artworkDataUrl]);

  // 3. Smoothly update fold angles without rebuilding geometry
  useEffect(() => {
    const { animNodes, rootWrapper } = stateRef.current;
    if (!rootWrapper || !dieline) return;
    applyFoldToNodes(animNodes, rootWrapper, dieline.uprightRotateX || 0, foldProgress);
  }, [foldProgress, dieline]);

  // 4. Camera Presets
  useEffect(() => {
    const { camera, controls } = stateRef.current;
    if (!camera || !controls) return;
    const scale = Math.max(dieline?.params?.L || 80, dieline?.params?.H || 120, dieline?.params?.W || 50) * 2.4;
    if (cameraPreset === 'front') {
      camera.position.set(0, 20, scale);
    } else if (cameraPreset === 'top') {
      camera.position.set(0, scale * 1.15, 10);
    } else {
      camera.position.set(scale * 0.78, scale * 0.65, scale * 0.85);
    }
    controls.target.set(0, 0, 0);
    controls.update();
  }, [cameraPreset]);

  return (
    <div
      ref={mountRef}
      className="w-full h-[520px] rounded-2xl overflow-hidden border border-slate-800 bg-[#0b0d12] shadow-2xl cursor-grab active:cursor-grabbing"
    />
  );
}

function applyFoldToNodes(animNodes, wrapper, uprightRotateX, foldProgress) {
  const t = Math.max(0, Math.min(1, foldProgress));
  for (const item of animNodes) {
    const [start, end] = item.window;
    const localT = Math.max(0, Math.min(1, (t - start) / Math.max(0.001, end - start)));
    // Smoothstep easing for realistic folding
    const eased = localT * localT * (3 - 2 * localT);
    item.pivot.quaternion.setFromAxisAngle(item.axis, item.targetRad * eased);
  }
  wrapper.rotation.x = uprightRotateX * Math.min(1, t * 1.15);
}
