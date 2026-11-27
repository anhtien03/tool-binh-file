import React, { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react';
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

function createLabelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.strokeStyle = 'rgba(8, 127, 91, 0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(6, 8, 244, 48, 20);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#17212F';
  ctx.font = 'bold 22px Inter, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(28, 7, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function buildSolidPanelMesh(
  nodeId,
  panelLabel,
  panelDims,
  localPoly,
  rawWorldPoly,
  bounds,
  outerMat,
  innerMat,
  edgeMat,
  thicknessMm,
  showEdges,
  showLabels3D,
  panelMeshMap,
  localHinge = null
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
  // Panels don't receive shadows: self-shadowing on 0.4mm-thick extrusions caused striped "shadow acne"
  mesh.receiveShadow = false;
  mesh.userData = { panelId: nodeId, panelLabel, panelDims };
  group.add(mesh);

  if (nodeId) {
    panelMeshMap.set(nodeId, { mats: [pInner, pOuter, pEdge], label: panelLabel, dims: panelDims });
  }

  if (showLabels3D && panelLabel && panelDims && panelDims.w >= 20 && panelDims.h >= 16) {
    let lcx = 0, lcy = 0;
    for (const [px, py] of localPoly) {
      lcx += px;
      lcy += py;
    }
    lcx /= localPoly.length;
    lcy /= localPoly.length;
    const sprite = createLabelSprite(panelLabel);
    sprite.position.set(lcx, -t / 2 - 4, lcy);
    group.add(sprite);
  }

  if (showEdges) {
    // Draw dieline cut/panel outline on BOTH inner (+Y) and outer (-Y) surfaces
    const innerEdgePts = localPoly.map(([px, py]) => new THREE.Vector3(px, t / 2 + 0.08, py));
    innerEdgePts.push(innerEdgePts[0].clone());
    const outerEdgePts = localPoly.map(([px, py]) => new THREE.Vector3(px, -t / 2 - 0.08, py));
    outerEdgePts.push(outerEdgePts[0].clone());

    const edgeLineMat = new THREE.LineBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.75 });
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(innerEdgePts), edgeLineMat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(outerEdgePts), edgeLineMat));

    // Draw crease/fold hinge line in red on BOTH surfaces so fold lines match the 2D dieline
    if (localHinge && localHinge.length === 2) {
      const [[hx1, hy1], [hx2, hy2]] = localHinge;
      const creaseMat = new THREE.LineBasicMaterial({ color: 0xdc2626, transparent: true, opacity: 0.9 });
      const innerCrease = [new THREE.Vector3(hx1, t / 2 + 0.12, hy1), new THREE.Vector3(hx2, t / 2 + 0.12, hy2)];
      const outerCrease = [new THREE.Vector3(hx1, -t / 2 - 0.12, hy1), new THREE.Vector3(hx2, -t / 2 - 0.12, hy2)];
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(innerCrease), creaseMat));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(outerCrease), creaseMat));
    }
  }

  return group;
}

function getFriendlyPanelLabel(node) {
  if (node.label) return node.label;
  if (node.name) return node.name;
  const id = String(node.id || '').toLowerCase();
  const map = {
    back: 'Mặt sau',
    front: 'Mặt trước',
    left: 'Mặt trái',
    right: 'Mặt phải',
    glue: 'Tai dán',
    top_tuck: 'Lưỡi gài trên',
    top: 'Nắp trên',
    bot_tuck: 'Lưỡi gài đáy',
    bottom: 'Nắp đáy',
    dust: 'Tai bụi',
    base: 'Đáy hộp',
    wall_top: 'Vách trên',
    wall_bot: 'Vách dưới',
    wall_left: 'Vách trái',
    wall_right: 'Vách phải',
  };
  for (const [k, v] of Object.entries(map)) {
    if (id === k || id.includes(k)) return v;
  }
  return id || 'Mặt hộp';
}

function getPolyDims(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly || []) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    w: Math.round((maxX - minX) * 10) / 10,
    h: Math.round((maxY - minY) * 10) / 10,
  };
}

function buildFoldHierarchy(
  node,
  bounds,
  outerMat,
  innerMat,
  edgeMat,
  thicknessMm,
  showEdges,
  showLabels3D,
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
    const localHinge = [
      [0, 0],
      [x2 - x1, y2 - y1],
    ];
    pivot.add(
      buildSolidPanelMesh(
        node.id,
        getFriendlyPanelLabel(node),
        getPolyDims(node.polygon),
        localPoly,
        node.polygon,
        bounds,
        outerMat,
        innerMat,
        edgeMat,
        thicknessMm,
        showEdges,
        showLabels3D,
        panelMeshMap,
        localHinge
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
          showLabels3D,
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
        getFriendlyPanelLabel(node),
        getPolyDims(node.polygon),
        localPoly,
        node.polygon,
        bounds,
        outerMat,
        innerMat,
        edgeMat,
        thicknessMm,
        showEdges,
        showLabels3D,
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
          showLabels3D,
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
    showLabels3D = true,
    hoveredPanelId = null,
    onHoverPanel = null,
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
    // Apply fold progress directly to the 3D scene (no React re-render) — used by the fold animation loop
    setFold: (p) => {
      const { animNodes, rootWrapper } = stateRef.current;
      if (!rootWrapper || !dieline) return;
      applyFoldToNodes(animNodes, rootWrapper, dieline.uprightRotateX || 0, p);
      stateRef.current.invalidate?.();
    },
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

    // Detect CPU-only WebGL (SwiftShader / Microsoft Basic Render / llvmpipe) so we can drop costly effects.
    const isSoftwareGL = (() => {
      try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2') || probe.getContext('webgl');
        if (!gl) return true;
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return /swiftshader|basic render|llvmpipe|software|microsoft basic/i.test(name);
      } catch {
        return false;
      }
    })();
    stateRef.current.isSoftwareGL = isSoftwareGL;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGL,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGL ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.shadowMap.enabled = !isSoftwareGL;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 60;
    controls.maxDistance = 1400;

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(260, 420, 240);
    keyLight.castShadow = !isSoftwareGL;
    keyLight.shadow.mapSize.set(1024, 1024);
    // Bias values remove "shadow acne" (the striped moiré bands on panels)
    keyLight.shadow.bias = -0.0008;
    keyLight.shadow.normalBias = 0.6;
    const sc = keyLight.shadow.camera;
    sc.left = -320;
    sc.right = 320;
    sc.top = 320;
    sc.bottom = -320;
    sc.near = 50;
    sc.far = 1400;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xf0fdf4, 0.45);
    fillLight.position.set(-220, 150, -180);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(600, 24, 0xcbd5e1, 0xe2e8f0);
    grid.position.y = -95;
    scene.add(grid);

    // Dedicated ground plane receives the box's soft shadow (panels themselves don't self-shadow)
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1200),
      new THREE.ShadowMaterial({ opacity: 0.16 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -94.9;
    ground.receiveShadow = true;
    ground.visible = !isSoftwareGL;
    scene.add(ground);

    stateRef.current.scene = scene;
    stateRef.current.camera = camera;
    stateRef.current.controls = controls;
    stateRef.current.renderer = renderer;
    stateRef.current.grid = grid;

    // On-demand rendering: only draw a frame when something actually changed
    // (camera move, damping settle, auto-rotate, fold change, texture load, hover highlight).
    let needsRender = true;
    const invalidate = () => {
      needsRender = true;
    };
    stateRef.current.invalidate = invalidate;
    controls.addEventListener('change', invalidate);

    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      if (document.hidden) return;
      const moved = controls.update();
      if (moved || needsRender || controls.autoRotate) {
        needsRender = false;
        renderer.render(scene, camera);
      }
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 720;
      const h = container.clientHeight || 560;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      invalidate();
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null;
    if (ro) ro.observe(container);
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(rafId);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', handleResize);
      controls.removeEventListener('change', invalidate);
      controls.dispose();
      disposeObject3D(stateRef.current.rootWrapper);
      ground.geometry.dispose();
      ground.material.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
    };
  }, []);

  useEffect(() => {
    const { controls } = stateRef.current;
    if (controls) {
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 1.8;
    }
    stateRef.current.invalidate?.();
  }, [autoRotate]);

  useEffect(() => {
    const { scene, rootWrapper } = stateRef.current;
    if (!scene || !dieline) return;

    if (rootWrapper) {
      scene.remove(rootWrapper);
      // Free GPU memory from the previous model (geometries, cloned materials, textures, label canvases)
      disposeObject3D(rootWrapper);
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
      showLabels3D,
      animNodes,
      panelMeshMap
    );

    const applyTexToAll = (url, matIndex) => {
      if (!url) return;
      const loader = new THREE.TextureLoader();
      loader.load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = stateRef.current.isSoftwareGL ? 1 : 4;
        for (const entry of panelMeshMap.values()) {
          entry.mats[matIndex].map = tex;
          entry.mats[matIndex].needsUpdate = true;
        }
        stateRef.current.invalidate?.();
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
    stateRef.current.invalidate?.();
  }, [dieline, materialKey, finishMode, artworkDataUrl, innerArtworkDataUrl, showEdges, showLabels3D]);

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
    stateRef.current.invalidate?.();
  }, [hoveredPanelId]);

  useEffect(() => {
    const { animNodes, rootWrapper } = stateRef.current;
    if (!rootWrapper || !dieline) return;
    applyFoldToNodes(animNodes, rootWrapper, dieline.uprightRotateX || 0, foldProgress);
    stateRef.current.invalidate?.();
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
    stateRef.current.invalidate?.();
  }, [cameraPreset]);

  // Hover raycast: throttled to 1 per frame, skipped while dragging (orbiting), and only
  // notifies the parent when the hovered panel actually changes (avoids re-rendering the whole studio).
  const hoverRef = useRef({ raf: 0, lastId: null, x: 0, y: 0, raycaster: new THREE.Raycaster(), mouse: new THREE.Vector2() });
  const handlePointerMove3D = (e) => {
    if (!onHoverPanel || e.buttons !== 0) return;
    const h = hoverRef.current;
    h.x = e.clientX;
    h.y = e.clientY;
    if (h.raf) return;
    h.raf = requestAnimationFrame(() => {
      h.raf = 0;
      const { camera, rootWrapper, renderer } = stateRef.current;
      if (!camera || !rootWrapper || !renderer) return;
      const rect = renderer.domElement.getBoundingClientRect();
      h.mouse.set(
        ((h.x - rect.left) / Math.max(1, rect.width)) * 2 - 1,
        -((h.y - rect.top) / Math.max(1, rect.height)) * 2 + 1
      );
      h.raycaster.setFromCamera(h.mouse, camera);
      const hits = h.raycaster.intersectObjects(rootWrapper.children, true);
      const hitMesh = hits.find((hit) => hit.object?.userData?.panelId);
      const id = hitMesh ? hitMesh.object.userData.panelId : null;
      if (id !== h.lastId) {
        h.lastId = id;
        onHoverPanel(id);
      }
    });
  };

  return (
    <div
      ref={mountRef}
      onPointerMove={handlePointerMove3D}
      onPointerLeave={() => {
        if (hoverRef.current.lastId !== null) {
          hoverRef.current.lastId = null;
          onHoverPanel?.(null);
        }
      }}
      className="w-full h-full min-h-[480px] cursor-grab active:cursor-grabbing"
    />
  );
});

export default memo(Box3DViewer);

function disposeObject3D(root) {
  if (!root) return;
  const textures = new Set();
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) {
      if (m.map) textures.add(m.map);
      m.dispose();
    }
  });
  for (const t of textures) t.dispose();
}

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
