import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

export const PAPER_MATERIALS = {
  ivory: { name: 'Ivory Trắng (300gsm)', outer: 0xf8fafc, inner: 0xe2e8f0, edge: 0xe2e8f0, roughness: 0.55 },
  bristol: { name: 'Bristol Mịn (350gsm)', outer: 0xffffff, inner: 0xf1f5f9, edge: 0xe2e8f0, roughness: 0.45 },
  duplex: { name: 'Duplex Trắng/Xám', outer: 0xf8fafc, inner: 0x94a3b8, edge: 0x94a3b8, roughness: 0.65 },
  kraft: { name: 'Kraft Nâu (320gsm)', outer: 0xc29b6e, inner: 0xa67c52, edge: 0x8b6239, roughness: 0.85 },
  matteBlack: { name: 'Đen Nhám Cao Cấp', outer: 0x1e293b, inner: 0x0f172a, edge: 0x1e293b, roughness: 0.75 },
};

export const FINISH_MODES = {
  standard: { name: 'Giấy tự nhiên', roughnessMul: 1.0, metalness: 0.02 },
  matte: { name: 'Cán mờ (Matte)', roughnessMul: 1.15, metalness: 0.01 },
  gloss: { name: 'Cán bóng (Gloss)', roughnessMul: 0.25, metalness: 0.1 },
  foilGold: { name: 'Ép kim Vàng (Foil)', roughnessMul: 0.22, metalness: 0.72, tint: 0xfbbf24 },
  foilSilver: { name: 'Ép kim Bạc (Foil)', roughnessMul: 0.2, metalness: 0.78, tint: 0xe2e8f0 },
};

function buildSolidPanelMesh(
  nodeId,
  localPoly,
  rawWorldPoly,
  bounds,
  outerMat,
  innerMat,
  edgeMat,
  thicknessMm,
  showEdges,
  panelMeshMap
) {
  const group = new THREE.Group();
  const shape = new THREE.Shape();

  localPoly.forEach(([px, py], idx) => {
    if (idx === 0) shape.moveTo(px, -py);
    else shape.lineTo(px, -py);
  });
  shape.closePath();

  const t = Math.max(0.28, thicknessMm || 0.4);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: t,
    bevelEnabled: false,
    curveSegments: 1,
  });

  // ExtrudeGeometry builds in XY plane with Z in [0, t].
  // After rotateX(-PI/2): local (x, y, z) -> (x, z, -y) so +Z extrusion becomes +Y thickness.
  // Compute planar UVs from rawWorldPoly bounding offset so artwork aligns 1:1 with 2D dieline.
  const dxWorld = rawWorldPoly[0][0] - localPoly[0][0];
  const dyWorld = rawWorldPoly[0][1] - localPoly[0][1];
  const pos = geo.attributes.position;
  const uvs = geo.attributes.uv;
  if (uvs) {
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + dxWorld;
      const wy = -pos.getY(i) + dyWorld;
      uvs.setXY(i, wx / Math.max(1, bounds.width), 1 - wy / Math.max(1, bounds.height));
    }
    uvs.needsUpdate = true;
  }

  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -t / 2, 0);

  // Clone material per panel so hover emissive highlighting can target one panel without affecting others
  const pOuter = outerMat.clone();
  const pInner = innerMat.clone();
  const pEdge = edgeMat.clone();
  // ExtrudeGeometry groups: group 0 = front/back caps, group 1 = side walls
  // Split cap triangles by normal.y so top (+Y = inner) and bottom (-Y = outer) get distinct materials
  const norm = geo.attributes.normal;
  if (geo.groups.length >= 2 && norm) {
    const idxAttr = geo.index;
    const capGroup = geo.groups[0];
    const sideGroup = geo.groups[1];
    const newGroups = [];
    // Group 0: inner (+Y), Group 1: outer (-Y), Group 2: side walls
    if (!idxAttr) {
      // Non-indexed ExtrudeGeometry: inspect each triangle (3 vertices)
      for (let triStart = capGroup.start; triStart < capGroup.start + capGroup.count; triStart += 3) {
        const ny = norm.getY(triStart);
        const matIdx = ny >= 0 ? 0 : 1;
        const last = newGroups[newGroups.length - 1];
        if (last && last.materialIndex === matIdx) {
          last.count += 3;
        } else {
          newGroups.push({ start: triStart, count: 3, materialIndex: matIdx });
        }
      }
      newGroups.push({ start: sideGroup.start, count: sideGroup.count, materialIndex: 2 });
      geo.groups = newGroups;
    }
  }

  const mesh = new THREE.Mesh(geo, [pInner, pOuter, pEdge]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  if (nodeId) {
    panelMeshMap.set(nodeId, { mats: [pInner, pOuter, pEdge] });
  }

  if (showEdges) {
    const edgePoints = localPoly.map(([px, py]) => new THREE.Vector3(px, t / 2 + 0.06, py));
    edgePoints.push(edgePoints[0].clone());
    const lineGeo = new THREE.BufferGeometry().setFromPoints(edgePoints);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x1d4ed8, transparent: true, opacity: 0.4 });
    group.add(new THREE.Line(lineGeo, lineMat));
  }

  return group;
}

function buildFoldHierarchy(
  node,
  bounds,
  outerMat,
  innerMat,
  edgeMat,
  thicknessMm,
  showEdges,
  animNodes,
  panelMeshMap,
  parentOrigin = [0, 0]
) {
  const pivot = new THREE.Group();

  if (node.hinge) {
    const [x1, y1] = node.hinge.p1;
    const [x2, y2] = node.hinge.p2;
    pivot.position.set(x1 - parentOrigin[0], 0, y1 - parentOrigin[1]);

    const axis = new THREE.Vector3(x2 - x1, 0, y2 - y1).normalize();

    let cx = 0,
      cy = 0;
    for (const [px, py] of node.polygon) {
      cx += px;
      cy += py;
    }
    cx /= node.polygon.length;
    cy /= node.polygon.length;

    const vx = cx - x1;
    const vz = cy - y1;
    const crossY = axis.z * vx - axis.x * vz;
    const sign = crossY >= 0 ? 1 : -1;

    animNodes.push({
      pivot,
      axis,
      targetRad: sign * ((node.foldAngleDeg * Math.PI) / 180),
      window: node.foldWindow || [0, 1],
    });

    const localPoly = node.polygon.map(([px, py]) => [px - x1, py - y1]);
    pivot.add(
      buildSolidPanelMesh(
        node.id,
        localPoly,
        node.polygon,
        bounds,
        outerMat,
        innerMat,
        edgeMat,
        thicknessMm,
        showEdges,
        panelMeshMap
      )
    );

    for (const child of node.children || []) {
      pivot.add(
        buildFoldHierarchy(
          child,
          bounds,
          outerMat,
          innerMat,
          edgeMat,
          thicknessMm,
          showEdges,
          animNodes,
          panelMeshMap,
          [x1, y1]
        )
      );
    }
  } else {
    let cx = 0,
      cy = 0;
    for (const [px, py] of node.polygon) {
      cx += px;
      cy += py;
    }
    cx /= node.polygon.length;
    cy /= node.polygon.length;

    const localPoly = node.polygon.map(([px, py]) => [px - cx, py - cy]);
    pivot.add(
      buildSolidPanelMesh(
        node.id,
        localPoly,
        node.polygon,
        bounds,
        outerMat,
        innerMat,
        edgeMat,
        thicknessMm,
        showEdges,
        panelMeshMap
      )
    );

    for (const child of node.children || []) {
      pivot.add(
        buildFoldHierarchy(
          child,
          bounds,
          outerMat,
          innerMat,
          edgeMat,
          thicknessMm,
          showEdges,
          animNodes,
          panelMeshMap,
          [cx, cy]
        )
      );
    }
  }

  return pivot;
}

const Box3DViewer = forwardRef(function Box3DViewer(
  {
    dieline,
    foldProgress = 1,
    materialKey = 'ivory',
    finishMode = 'standard',
    artworkDataUrl = null,
    innerArtworkDataUrl = null,
    cameraPreset = 'iso',
    autoRotate = false,
    showEdges = true,
    hoveredPanelId = null,
  },
  ref
) {
  const mountRef = useRef(null);
  const stateRef = useRef({
    animNodes: [],
    panelMeshMap: new Map(),
    rootWrapper: null,
    camera: null,
    controls: null,
    renderer: null,
    scene: null,
    grid: null,
  });

  useImperativeHandle(ref, () => ({
    capturePng: (transparent = true) => {
      const { renderer, scene, camera, grid } = stateRef.current;
      if (!renderer || !scene || !camera) return null;
      const prevBg = scene.background;
      const prevGridVis = grid ? grid.visible : true;
      if (transparent) {
        scene.background = null;
        if (grid) grid.visible = false;
      }
      renderer.render(scene, camera);
      const dataUrl = renderer.domElement.toDataURL('image/png');
      scene.background = prevBg;
      if (grid) grid.visible = prevGridVis;
      renderer.render(scene, camera);
      return dataUrl;
    },
    exportGlb: () =>
      new Promise((resolve, reject) => {
        const { rootWrapper } = stateRef.current;
        if (!rootWrapper) return reject(new Error('No 3D model loaded'));
        const exporter = new GLTFExporter();
        exporter.parse(
          rootWrapper,
          (result) => resolve(result),
          (err) => reject(err),
          { binary: true }
        );
      }),
  }));

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 720;
    const height = container.clientHeight || 560;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef2f0);

    const camera = new THREE.PerspectiveCamera(38, width / height, 1, 4000);
    camera.position.set(220, 190, 260);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 60;
    controls.maxDistance = 1400;

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(260, 420, 240);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xf0fdf4, 0.45);
    fillLight.position.set(-220, 150, -180);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(600, 24, 0xcbd5e1, 0xe2e8f0);
    grid.position.y = -95;
    scene.add(grid);

    stateRef.current.scene = scene;
    stateRef.current.camera = camera;
    stateRef.current.controls = controls;
    stateRef.current.renderer = renderer;
    stateRef.current.grid = grid;

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
      const h = container.clientHeight || 560;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null;
    if (ro) ro.observe(container);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(rafId);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', handleResize);
      controls.dispose();
      renderer.dispose();
    };
  }, []);

  useEffect(() => {
    const { controls } = stateRef.current;
    if (controls) {
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 1.8;
    }
  }, [autoRotate]);

  useEffect(() => {
    const { scene, rootWrapper } = stateRef.current;
    if (!scene || !dieline) return;

    if (rootWrapper) {
      scene.remove(rootWrapper);
    }

    const preset = PAPER_MATERIALS[materialKey] || PAPER_MATERIALS.ivory;
    const finish = FINISH_MODES[finishMode] || FINISH_MODES.standard;

    const innerMat = new THREE.MeshStandardMaterial({
      color: innerArtworkDataUrl ? 0xffffff : preset.inner,
      roughness: Math.min(1, preset.roughness * finish.roughnessMul),
      metalness: finish.metalness * 0.4,
    });

    const outerMat = new THREE.MeshStandardMaterial({
      color: artworkDataUrl ? 0xffffff : finish.tint || preset.outer,
      roughness: Math.min(1, Math.max(0.08, preset.roughness * finish.roughnessMul)),
      metalness: finish.metalness,
    });

    const edgeMat = new THREE.MeshStandardMaterial({
      color: preset.edge || preset.inner,
      roughness: 0.85,
      metalness: 0.02,
    });

    const animNodes = [];
    const panelMeshMap = new Map();
    const wrapper = new THREE.Group();
    const boxHierarchy = buildFoldHierarchy(
      dieline.rootPanel,
      dieline.bounds,
      outerMat,
      innerMat,
      edgeMat,
      dieline.params.thickness || 0.4,
      showEdges,
      animNodes,
      panelMeshMap
    );

    const applyTexToAll = (url, matIndex) => {
      if (!url) return;
      const loader = new THREE.TextureLoader();
      loader.load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        for (const entry of panelMeshMap.values()) {
          entry.mats[matIndex].map = tex;
          entry.mats[matIndex].needsUpdate = true;
        }
      });
    };

    applyTexToAll(innerArtworkDataUrl, 0);
    applyTexToAll(artworkDataUrl, 1);

    wrapper.add(boxHierarchy);
    wrapper.rotation.x = (dieline.uprightRotateX || 0) * foldProgress;
    scene.add(wrapper);

    stateRef.current.rootWrapper = wrapper;
    stateRef.current.animNodes = animNodes;
    stateRef.current.panelMeshMap = panelMeshMap;

    applyFoldToNodes(animNodes, wrapper, dieline.uprightRotateX || 0, foldProgress);
  }, [dieline, materialKey, finishMode, artworkDataUrl, innerArtworkDataUrl, showEdges]);

  // Sync 2D -> 3D hovered panel highlight
  useEffect(() => {
    const { panelMeshMap } = stateRef.current;
    for (const [id, entry] of panelMeshMap.entries()) {
      const isHit = hoveredPanelId && id === hoveredPanelId;
      for (const m of entry.mats) {
        m.emissive.setHex(isHit ? 0x087f5b : 0x000000);
        m.emissiveIntensity = isHit ? 0.35 : 0;
      }
    }
  }, [hoveredPanelId]);

  useEffect(() => {
    const { animNodes, rootWrapper } = stateRef.current;
    if (!rootWrapper || !dieline) return;
    applyFoldToNodes(animNodes, rootWrapper, dieline.uprightRotateX || 0, foldProgress);
  }, [foldProgress, dieline]);

  useEffect(() => {
    const { camera, controls } = stateRef.current;
    if (!camera || !controls) return;
    const d = Math.max(dieline?.params?.L || 80, dieline?.params?.H || 120, dieline?.params?.W || 50) * 2.4;
    if (cameraPreset === 'front') camera.position.set(0, 15, d);
    else if (cameraPreset === 'back') camera.position.set(0, 15, -d);
    else if (cameraPreset === 'left') camera.position.set(-d, 15, 0);
    else if (cameraPreset === 'right') camera.position.set(d, 15, 0);
    else if (cameraPreset === 'top') camera.position.set(0, d * 1.15, 8);
    else if (cameraPreset === 'bottom') camera.position.set(0, -d * 1.15, 8);
    else camera.position.set(d * 0.78, d * 0.65, d * 0.85);

    controls.target.set(0, 0, 0);
    controls.update();
  }, [cameraPreset]);

  return (
    <div
      ref={mountRef}
      className="w-full h-full min-h-[480px] cursor-grab active:cursor-grabbing"
    />
  );
});

export default Box3DViewer;

function applyFoldToNodes(animNodes, wrapper, uprightRotateX, foldProgress) {
  const t = Math.max(0, Math.min(1, foldProgress));
  for (const item of animNodes) {
    const [start, end] = item.window;
    const localT = Math.max(0, Math.min(1, (t - start) / Math.max(0.001, end - start)));
    const eased = localT * localT * (3 - 2 * localT);
    item.pivot.quaternion.setFromAxisAngle(item.axis, item.targetRad * eased);
  }
  wrapper.rotation.x = uprightRotateX * Math.min(1, t * 1.15);
}
