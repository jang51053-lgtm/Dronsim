import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Joystick } from './joystick.js';

// ---- 드론 스탯 (균형형 기본기, PRD 3.1) ----
const DRONE_STATS = {
  maxSpeed: 32,       // m/s
  accel: 50,          // m/s^2
  damping: 4,         // 관성 감쇠
  yawSpeed: 2.6,       // rad/s
  vertSpeed: 18,       // m/s
  batteryDrainPerSec: 100 / 90, // 90초에 완전 방전
};

const DRONE_TARGET_SIZE = 3;   // 드론 모델의 최대 치수를 이 값(미터)에 맞춰 정규화
const DRONE_RADIUS = 1.1;      // 충돌 판정용 드론 반경

// GitHub Pages 같은 서브경로 배포에서도 에셋을 찾도록 base 경로를 붙인다.
const ASSET_BASE = import.meta.env.BASE_URL;
const assetUrl = (path) => `${ASSET_BASE}${path}`;

const state = {
  velocity: new THREE.Vector3(),
  yaw: 0,
  pitchTilt: 0,
  rollTilt: 0,
  battery: 100,
  crashed: false,
  keys: {},
};

const leftStick = new Joystick(document.getElementById('joystickLeft'));
const rightStick = new Joystick(document.getElementById('joystickRight'));

window.addEventListener('keydown', (e) => { state.keys[e.code] = true; });
window.addEventListener('keyup', (e) => { state.keys[e.code] = false; });

// ---- 시작 화면 ----
document.getElementById('btnModeTraining').addEventListener('click', () => startGame('training'));
document.getElementById('btnModeCity').addEventListener('click', () => startGame('city'));
document.getElementById('btnMenu').addEventListener('click', () => location.reload());

function startGame(mode) {
  document.getElementById('startScreen').remove();
  document.getElementById('btnMenu').hidden = false;

  // ---- 렌더러 / 씬 / 카메라 ----
  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fd0ff);
  scene.fog = new THREE.Fog(0x8fd0ff, 160, 620);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  pmremGenerator.dispose();

  const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 6, -16);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x445566, 0.9);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
  sunLight.position.set(30, 50, 20);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -60;
  sunLight.shadow.camera.right = 60;
  sunLight.shadow.camera.top = 60;
  sunLight.shadow.camera.bottom = -60;
  sunLight.shadow.camera.far = 150;
  scene.add(sunLight);

  // ---- 드론 ----
  const drone = new THREE.Group();
  scene.add(drone);

  const rotors = [];

  // 로터 메시의 원점이 기체 중심 등 엉뚱한 곳에 있으면 rotation.y가 블레이드를
  // 큰 원으로 휘두르게 만든다 — 각 로터를 자신의 바운딩박스 중심에 놓인
  // 피벗 그룹으로 감싸서 그 자리에서 자전하도록 고정한다.
  function pivotInPlace(mesh) {
    const box = new THREE.Box3().setFromObject(mesh);
    const centerWorld = box.getCenter(new THREE.Vector3());
    const parent = mesh.parent;
    const pivot = new THREE.Group();
    parent.add(pivot);
    pivot.position.copy(parent.worldToLocal(centerWorld));
    pivot.attach(mesh);
    return pivot;
  }

  function collectRotors(root) {
    const meshes = [];
    root.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        const name = obj.name.toLowerCase();
        if (name.includes('rotor') || name.includes('propeller') || name.includes('blade')) {
          meshes.push(obj);
        }
      }
    });
    root.updateWorldMatrix(true, true);
    for (const mesh of meshes) {
      rotors.push(pivotInPlace(mesh));
    }
  }

  new GLTFLoader().load(
    assetUrl('assets/drone.glb'),
    (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      model.scale.setScalar(DRONE_TARGET_SIZE / maxDim);
      drone.add(model);
      collectRotors(model);
    },
    undefined,
    (err) => {
      console.warn('드론 GLB 로드 실패, OBJ로 대체 시도', err);
      loadDroneObjFallback();
    }
  );

  function loadDroneObjFallback() {
    new MTLLoader().load(
      assetUrl('assets/drone_fallback.mtl'),
      (materials) => {
        materials.preload();
        new OBJLoader()
          .setMaterials(materials)
          .load(
            assetUrl('assets/drone.obj'),
            (obj) => {
              drone.add(obj);
              collectRotors(obj);
            },
            undefined,
            (e) => console.error('드론 OBJ 로드도 실패', e)
          );
      },
      undefined,
      (e) => console.error('드론 MTL 로드 실패', e)
    );
  }

  // ---- 충돌 판정 (건물/지형/바닥 박스) ----
  const collisionBoxes = [];

  function resolveCollisions(position, velocity, radius) {
    for (const box of collisionBoxes) {
      const closestX = THREE.MathUtils.clamp(position.x, box.min.x, box.max.x);
      const closestY = THREE.MathUtils.clamp(position.y, box.min.y, box.max.y);
      const closestZ = THREE.MathUtils.clamp(position.z, box.min.z, box.max.z);
      const dx = position.x - closestX;
      const dy = position.y - closestY;
      const dz = position.z - closestZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq >= radius * radius || distSq < 1e-8) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      const penetration = radius - dist;
      position.x += nx * penetration;
      position.y += ny * penetration;
      position.z += nz * penetration;

      const vDotN = velocity.x * nx + velocity.y * ny + velocity.z * nz;
      if (vDotN < 0) {
        velocity.x -= vDotN * nx;
        velocity.y -= vDotN * ny;
        velocity.z -= vDotN * nz;
      }
    }
  }

  // ---- 미션 (훈련장 모드 전용) ----
  const missionPanel = document.getElementById('missionPanel');
  const missionTitleEl = document.getElementById('missionTitle');
  const missionDescEl = document.getElementById('missionDesc');
  let updateMissions = () => {};

  function setMissionText(title, desc) {
    missionTitleEl.textContent = title;
    missionDescEl.textContent = desc;
  }

  function buildTrainingField() {
    // 평평한 초록 훈련장 (실제 드론 교본처럼 착륙 상태에서 이륙 -> 링 통과 -> 지정 착륙)
    const groundSize = 400;
    const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize, 40, 40);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x4caf50 });
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);

    // 바닥을 하나의 충돌 박스로 등록 (드론 반경만큼 위에서 멈춤)
    collisionBoxes.push(new THREE.Box3(
      new THREE.Vector3(-groundSize, -20, -groundSize),
      new THREE.Vector3(groundSize, 0, groundSize)
    ));

    drone.position.set(0, DRONE_RADIUS, 0);
    camera.position.set(0, DRONE_RADIUS + 4, -16);

    // ---- 링 코스 (좌우/고도 변화를 크게 줘서 진짜로 방향을 틀어야 통과 가능) ----
    const ringPositions = [
      new THREE.Vector3(0, 8, 22),
      new THREE.Vector3(14, 12, 42),
      new THREE.Vector3(-16, 18, 60),
      new THREE.Vector3(12, 24, 82),
      new THREE.Vector3(-10, 14, 104),
      new THREE.Vector3(8, 20, 124),
      new THREE.Vector3(0, 10, 146),
    ];
    const ringRadius = 2.4; // 좁게 만들어서 정밀 조작이 필요하도록

    const ringMaterials = {
      pending: new THREE.MeshStandardMaterial({ color: 0x89c4f4, transparent: true, opacity: 0.45 }),
      active: new THREE.MeshStandardMaterial({ color: 0xffa726, emissive: 0xff8f00, emissiveIntensity: 0.6 }),
      cleared: new THREE.MeshStandardMaterial({ color: 0x4caf50, emissive: 0x2e7d32, emissiveIntensity: 0.3 }),
    };

    const zAxis = new THREE.Vector3(0, 0, 1);
    let prevPos = new THREE.Vector3(0, ringPositions[0].y, 0);
    const rings = ringPositions.map((pos) => {
      const normal = pos.clone().sub(prevPos).normalize();
      prevPos = pos;

      const geo = new THREE.TorusGeometry(ringRadius, 0.3, 12, 32);
      const mesh = new THREE.Mesh(geo, ringMaterials.pending);
      mesh.position.copy(pos);
      mesh.quaternion.setFromUnitVectors(zAxis, normal);
      mesh.castShadow = true;
      scene.add(mesh);
      return { mesh, center: pos.clone(), normal, radius: ringRadius, cleared: false };
    });

    // ---- 착륙장 ----
    const padCenter = new THREE.Vector3(0, 0, 175);
    const padRadius = 4.5;

    const padCanvas = document.createElement('canvas');
    padCanvas.width = 256;
    padCanvas.height = 256;
    const ctx = padCanvas.getContext('2d');
    ctx.fillStyle = '#e0e0e0';
    ctx.beginPath();
    ctx.arc(128, 128, 120, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ff9800';
    ctx.lineWidth = 12;
    ctx.stroke();
    ctx.fillStyle = '#ff9800';
    ctx.font = 'bold 140px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', 128, 138);
    const padTexture = new THREE.CanvasTexture(padCanvas);

    const padMesh = new THREE.Mesh(
      new THREE.CircleGeometry(padRadius, 32),
      new THREE.MeshStandardMaterial({ map: padTexture })
    );
    padMesh.rotation.x = -Math.PI / 2;
    padMesh.position.copy(padCenter).setY(0.03);
    scene.add(padMesh);

    // ---- 미션 상태 머신 ----
    const mission = { stage: 'rings', ringIndex: 0 };
    const prevDronePos = drone.position.clone();

    setMissionText(
      '미션 1/2 · 링 통과',
      `스페이스로 이륙해서 공중 링을 순서대로 통과하세요 (0/${rings.length})`
    );
    if (rings.length > 0) rings[0].mesh.material = ringMaterials.active;
    missionPanel.hidden = false;

    updateMissions = () => {
      if (mission.stage === 'rings') {
        const ring = rings[mission.ringIndex];
        if (ring) {
          const prevDepth = prevDronePos.clone().sub(ring.center).dot(ring.normal);
          const curDepth = drone.position.clone().sub(ring.center).dot(ring.normal);
          if (prevDepth < 0 && curDepth >= 0) {
            const radial = drone.position.clone().sub(ring.center).addScaledVector(ring.normal, -curDepth);
            if (radial.length() <= ring.radius) {
              ring.cleared = true;
              ring.mesh.material = ringMaterials.cleared;
              mission.ringIndex += 1;
              if (mission.ringIndex < rings.length) {
                rings[mission.ringIndex].mesh.material = ringMaterials.active;
                setMissionText(
                  '미션 1/2 · 링 통과',
                  `잘하고 있어요! 다음 링을 통과하세요 (${mission.ringIndex}/${rings.length})`
                );
              } else {
                mission.stage = 'landing';
                setMissionText('미션 2/2 · 착륙', '표시된 착륙장(H)에 착륙하세요');
              }
            }
          }
        }
      } else if (mission.stage === 'landing') {
        const dx = drone.position.x - padCenter.x;
        const dz = drone.position.z - padCenter.z;
        const horizDist = Math.hypot(dx, dz);
        if (horizDist <= padRadius && drone.position.y <= DRONE_RADIUS + 0.6) {
          mission.stage = 'done';
          setMissionText('미션 완료', '링 통과와 착륙 훈련을 모두 마쳤습니다');
        }
      }
      prevDronePos.copy(drone.position);
    };
  }

  // ---- 도심 맵 (모듈형 도시 키트로 직접 조립) ----

  // 오브젝트를 지정한 치수에 맞춰 균일 스케일하고, 밑면이 y=0 / 가로세로 중심이
  // (0,0)에 오도록 자식으로 감싼 래퍼 그룹을 반환한다. 이후 이 래퍼를 clone해서
  // wrapper.position.set(x, 지면높이, z)만 하면 정확히 바닥에 붙는다.
  // (재배치 오프셋을 원본 오브젝트의 position에 직접 넣으면, 나중에 배치할 때
  // 그 position을 다시 덮어써서 오프셋이 날아가 버리므로 래퍼로 분리해야 한다.)
  // 원본 에셋마다 피벗 위치/스케일이 제각각이라 (export 파이프라인이 달라 원점이
  // sheet 배치 좌표에 남아있기도 함) 매번 이렇게 정규화해야 안전하다.
  function wrapNormalized(obj, targetDim, axis) {
    const box0 = new THREE.Box3().setFromObject(obj);
    const size0 = box0.getSize(new THREE.Vector3());
    const raw = axis === 'y' ? size0.y : Math.max(size0.x, size0.z);
    const scale = raw > 1e-6 ? targetDim / raw : 1;
    return wrapRescaled(obj, scale);
  }

  function wrapRescaled(obj, scale) {
    obj.scale.multiplyScalar(scale);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    obj.position.x -= center.x;
    obj.position.z -= center.z;
    obj.position.y -= box.min.y;
    const wrapper = new THREE.Group();
    wrapper.add(obj);
    return wrapper;
  }

  function placeInstance(template, x, z, y = 0, rotY = 0) {
    const inst = template.clone(true);
    inst.position.set(x, y, z);
    inst.rotation.y = rotY;
    inst.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    scene.add(inst);
    return inst;
  }

  async function buildModularCity() {
    const cityUrl = (f) => assetUrl(`assets/city/${f}`);
    const loader = new GLTFLoader();
    const load = (file) => loader.loadAsync(cityUrl(file)).then((gltf) => gltf.scene);

    let [big, brown, green, redCorner, red, roadBits, tree, bench, trafficLight, mailbox, trashCan, fireHydrant, busStop, planter, car, van, bus] =
      await Promise.all([
        load('big-building.glb'), load('brown-building.glb'), load('building-green.glb'),
        load('building-red-corner.glb'), load('building-red.glb'), load('road-bits.glb'),
        load('tree.glb'), load('bench.glb'), load('traffic-light.glb'), load('mailbox.glb'),
        load('trash-can.glb'), load('fire-hydrant.glb'), load('bus-stop.glb'), load('planter.glb'),
        load('car.glb'), load('van.glb'), load('bus.glb'),
      ]).catch((err) => {
        console.error('도시 에셋 로드 실패', err);
        return [];
      });

    if (!big) return; // 로드 실패 시 빈 도시로 두지 않고 중단 (콘솔에 에러 출력됨)

    // ---- 건물 (스카이라인용으로 높이를 다양하게) ----
    const buildingDefs = [
      { obj: big, height: 34 },
      { obj: brown, height: 16 },
      { obj: green, height: 20 },
      { obj: redCorner, height: 18 },
      { obj: red, height: 14 },
    ];
    for (const def of buildingDefs) def.obj = wrapNormalized(def.obj, def.height, 'y');

    // ---- 도로 타일: road_straight 기준으로 스케일을 정하고 세트 전체에 동일 적용 ----
    const TILE_LENGTH = 14;
    const rawStraight = roadBits.getObjectByName('road_straight');
    const rawBox = new THREE.Box3().setFromObject(rawStraight);
    const rawSize = rawBox.getSize(new THREE.Vector3());
    const rawMax = Math.max(rawSize.x, rawSize.z);
    const roadScale = rawMax > 1e-6 ? TILE_LENGTH / rawMax : 1;

    const roadNames = ['road_straight', 'road_junction', 'road_corner', 'road_tsplit', 'road_straight_crossing', 'road_corner_curved'];
    const roadTemplates = {};
    for (const name of roadNames) {
      const src = roadBits.getObjectByName(name);
      if (!src) continue;
      roadTemplates[name] = wrapRescaled(src.clone(true), roadScale);
    }
    const straightSize = new THREE.Box3().setFromObject(roadTemplates.road_straight).getSize(new THREE.Vector3());
    const ROAD_WIDTH = Math.min(straightSize.x, straightSize.z);
    const straightAxisIsX = straightSize.x >= straightSize.z; // 기본 방향이 X축인지

    // ---- 소품/차량 정규화 (사람 눈에 자연스러운 높이로) ----
    tree = wrapNormalized(tree, 7, 'y');
    bench = wrapNormalized(bench, 1, 'y');
    trafficLight = wrapNormalized(trafficLight, 4.5, 'y');
    mailbox = wrapNormalized(mailbox, 1.2, 'y');
    trashCan = wrapNormalized(trashCan, 1, 'y');
    fireHydrant = wrapNormalized(fireHydrant, 0.8, 'y');
    busStop = wrapNormalized(busStop, 2.6, 'y');
    planter = wrapNormalized(planter, 0.9, 'y');
    car = wrapNormalized(car, 1.5, 'y');
    van = wrapNormalized(van, 2, 'y');
    bus = wrapNormalized(bus, 3, 'y');
    const propTemplates = [tree, bench, trafficLight, mailbox, trashCan, fireHydrant, busStop, planter];
    const vehicleTemplates = [car, van, bus];

    // ---- 지면 ----
    const CITY_EXTENT = 260;
    const groundMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CITY_EXTENT, CITY_EXTENT),
      new THREE.MeshStandardMaterial({ color: 0x6b6f76 })
    );
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);
    collisionBoxes.push(new THREE.Box3(
      new THREE.Vector3(-CITY_EXTENT, -20, -CITY_EXTENT),
      new THREE.Vector3(CITY_EXTENT, 0, CITY_EXTENT)
    ));

    // ---- 충전 스테이션 표시(바닥 패드) ----
    const chargeCanvas = document.createElement('canvas');
    chargeCanvas.width = 256;
    chargeCanvas.height = 256;
    const chargeCtx = chargeCanvas.getContext('2d');
    chargeCtx.fillStyle = '#e8e8e8';
    chargeCtx.beginPath();
    chargeCtx.arc(128, 128, 120, 0, Math.PI * 2);
    chargeCtx.fill();
    chargeCtx.strokeStyle = '#43a047';
    chargeCtx.lineWidth = 12;
    chargeCtx.stroke();
    chargeCtx.fillStyle = '#43a047';
    chargeCtx.beginPath();
    chargeCtx.moveTo(150, 30);
    chargeCtx.lineTo(95, 140);
    chargeCtx.lineTo(125, 140);
    chargeCtx.lineTo(105, 220);
    chargeCtx.lineTo(168, 108);
    chargeCtx.lineTo(136, 108);
    chargeCtx.closePath();
    chargeCtx.fill();
    const chargeTexture = new THREE.CanvasTexture(chargeCanvas);
    const CHARGE_PAD_RADIUS = 6;

    // ---- 도로/블록 격자 배치 ----
    const BLOCKS = 5;
    const CELL = 30;
    const SPACING = CELL + ROAD_WIDTH;
    const roadLineCount = BLOCKS + 1;
    const roadPositions = [];
    for (let i = 0; i < roadLineCount; i++) {
      roadPositions.push((i - BLOCKS / 2) * SPACING);
    }
    const cityMin = roadPositions[0] - ROAD_WIDTH / 2;
    const cityMax = roadPositions[roadPositions.length - 1] + ROAD_WIDTH / 2;

    function isCrossing(pos) {
      return roadPositions.some((p) => Math.abs(p - pos) < 0.01);
    }

    // 가로(고정 Z) 도로들
    for (const z of roadPositions) {
      for (let x = cityMin + TILE_LENGTH / 2; x < cityMax; x += TILE_LENGTH) {
        const rotY = straightAxisIsX ? 0 : Math.PI / 2;
        if (isCrossing(x)) {
          placeInstance(roadTemplates.road_junction, x, z, 0.02, 0);
        } else {
          placeInstance(roadTemplates.road_straight, x, z, 0.02, rotY);
        }
      }
    }
    // 세로(고정 X) 도로들 (교차점은 이미 위에서 깔림)
    for (const x of roadPositions) {
      for (let z = cityMin + TILE_LENGTH / 2; z < cityMax; z += TILE_LENGTH) {
        if (isCrossing(z)) continue;
        const rotY = straightAxisIsX ? Math.PI / 2 : 0;
        placeInstance(roadTemplates.road_straight, x, z, 0.02, rotY);
      }
    }

    // ---- 블록 채우기 (건물 + 소품), 광장/충전 스테이션 블록은 비워둠 ----
    let buildingCounter = 0;
    const plazaBlocks = [];
    let stationCenter = null;
    for (let bi = 0; bi < BLOCKS; bi++) {
      for (let bj = 0; bj < BLOCKS; bj++) {
        const cx = (roadPositions[bi] + roadPositions[bi + 1]) / 2;
        const cz = (roadPositions[bj] + roadPositions[bj + 1]) / 2;
        const isPlaza = (bi === 1 && bj === 1) || (bi === 3 && bj === 3);
        const isStation = bi === 2 && bj === 0;

        if (isStation) {
          stationCenter = { x: cx, z: cz };
          const chargeMesh = new THREE.Mesh(
            new THREE.CircleGeometry(CHARGE_PAD_RADIUS, 32),
            new THREE.MeshStandardMaterial({ map: chargeTexture })
          );
          chargeMesh.rotation.x = -Math.PI / 2;
          chargeMesh.position.set(cx, 0.03, cz);
          scene.add(chargeMesh);
          continue;
        }

        if (isPlaza) {
          plazaBlocks.push({ x: cx, z: cz });
          for (let k = 0; k < 4; k++) {
            const ang = (k / 4) * Math.PI * 2 + 0.3;
            const px = cx + Math.cos(ang) * (CELL * 0.32);
            const pz = cz + Math.sin(ang) * (CELL * 0.32);
            placeInstance(propTemplates[k % propTemplates.length], px, pz, 0, Math.random() * Math.PI * 2);
          }
          continue;
        }

        const def = buildingDefs[buildingCounter % buildingDefs.length];
        buildingCounter += 1;
        const rotY = Math.round(Math.random() * 3) * (Math.PI / 2);
        const offsetX = (Math.random() - 0.5) * CELL * 0.15;
        const offsetZ = (Math.random() - 0.5) * CELL * 0.15;
        const inst = placeInstance(def.obj, cx + offsetX, cz + offsetZ, 0, rotY);
        inst.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(inst);
        if (!b.isEmpty()) collisionBoxes.push(b);

        // 인도 쪽에 소품 한두 개
        if (Math.random() < 0.6) {
          const propTpl = propTemplates[Math.floor(Math.random() * propTemplates.length)];
          const edgeX = cx + (Math.random() - 0.5) * CELL * 0.9;
          const edgeZ = cz + (bj === 0 ? -1 : 1) * CELL * 0.46;
          placeInstance(propTpl, edgeX, edgeZ, 0, Math.random() * Math.PI * 2);
        }
      }
    }

    // 도로 옆 주차 차량 몇 대
    for (let n = 0; n < 10; n++) {
      const laneZ = roadPositions[1 + (n % (roadPositions.length - 2))];
      const x = cityMin + TILE_LENGTH + Math.random() * (cityMax - cityMin - TILE_LENGTH * 2);
      const offset = ROAD_WIDTH * 0.28;
      placeInstance(
        vehicleTemplates[n % vehicleTemplates.length],
        x, laneZ + (n % 2 === 0 ? offset : -offset), 0,
        straightAxisIsX ? 0 : Math.PI / 2
      );
    }

    // ---- 드론 스폰: 충전 스테이션(출발지)에 착륙한 상태로 시작 ----
    drone.position.set(stationCenter.x, DRONE_RADIUS, stationCenter.z);
    camera.position.set(stationCenter.x, DRONE_RADIUS + 4, stationCenter.z - 16);

    // ---- 배송 미션 ----
    const pickup = plazaBlocks[0] || { x: 0, z: 0 };
    const dropoff = plazaBlocks[1] || { x: CELL, z: CELL };
    const pickupBeacon = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.3, 0),
      new THREE.MeshStandardMaterial({ color: 0x2196f3, emissive: 0x1565c0, emissiveIntensity: 0.7 })
    );
    pickupBeacon.position.set(pickup.x, 8, pickup.z);
    scene.add(pickupBeacon);

    const dropoffBeacon = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.3, 0),
      new THREE.MeshStandardMaterial({ color: 0xff7043, emissive: 0xd84315, emissiveIntensity: 0.7 })
    );
    dropoffBeacon.position.set(dropoff.x, 8, dropoff.z);
    dropoffBeacon.visible = false;
    scene.add(dropoffBeacon);

    const packageMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.5, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xa1662f })
    );
    packageMesh.position.set(0, -1, 0);
    packageMesh.visible = false;
    drone.add(packageMesh);

    const delivery = { stage: 'pickup' };
    const CHARGE_RATE = 100 / 15; // 15초면 완전 충전
    setMissionText('배송 미션 · 픽업', '스페이스로 이륙해서 파란 구슬(픽업 지점)으로 이동하세요');
    missionPanel.hidden = false;

    updateMissions = (dt) => {
      pickupBeacon.rotation.y += dt;
      dropoffBeacon.rotation.y += dt;
      pickupBeacon.position.y = 8 + Math.sin(clock.elapsedTime * 2) * 0.4;
      dropoffBeacon.position.y = 8 + Math.sin(clock.elapsedTime * 2 + 1) * 0.4;

      const distToStation = Math.hypot(drone.position.x - stationCenter.x, drone.position.z - stationCenter.z);
      if (distToStation < CHARGE_PAD_RADIUS && drone.position.y < DRONE_RADIUS + 1.5 && state.battery < 100) {
        state.battery = Math.min(100, state.battery + CHARGE_RATE * dt);
      }

      if (delivery.stage === 'pickup') {
        const d = drone.position.distanceTo(pickupBeacon.position);
        if (d < 4) {
          delivery.stage = 'dropoff';
          pickupBeacon.visible = false;
          dropoffBeacon.visible = true;
          packageMesh.visible = true;
          setMissionText('배송 미션 · 배달', '주황 구슬(배달 지점)까지 옮겨주세요');
        }
      } else if (delivery.stage === 'dropoff') {
        const d = drone.position.distanceTo(dropoffBeacon.position);
        if (d < 4) {
          delivery.stage = 'done';
          dropoffBeacon.visible = false;
          packageMesh.visible = false;
          setMissionText('배송 완료', '물건을 목적지까지 무사히 옮겼습니다');
        }
      }
    };
  }

  if (mode === 'training') {
    buildTrainingField();
  } else {
    buildModularCity();
  }

  // ---- 입력 통합 (키보드 + 조이스틱) ----
  function readInput() {
    let throttle = 0;   // -1(하강) ~ 1(상승)
    let yawInput = 0;    // -1(좌회전) ~ 1(우회전)
    let pitchInput = 0;  // -1(후진) ~ 1(전진)
    let rollInput = 0;   // -1(좌측 이동) ~ 1(우측 이동)

    if (state.keys['KeyW']) pitchInput += 1;
    if (state.keys['KeyS']) pitchInput -= 1;
    if (state.keys['KeyA']) rollInput -= 1;
    if (state.keys['KeyD']) rollInput += 1;
    if (state.keys['KeyQ']) yawInput -= 1;
    if (state.keys['KeyE']) yawInput += 1;
    if (state.keys['Space']) throttle += 1;
    if (state.keys['ShiftLeft'] || state.keys['ShiftRight']) throttle -= 1;

    yawInput += leftStick.x;
    throttle += -leftStick.y;
    pitchInput += -rightStick.y;
    rollInput += rightStick.x;

    return {
      throttle: THREE.MathUtils.clamp(throttle, -1, 1),
      yawInput: THREE.MathUtils.clamp(yawInput, -1, 1),
      pitchInput: THREE.MathUtils.clamp(pitchInput, -1, 1),
      rollInput: THREE.MathUtils.clamp(rollInput, -1, 1),
    };
  }

  // ---- 게임 루프 ----
  const clock = new THREE.Clock();
  const batteryFill = document.getElementById('batteryFill');
  const batteryPercentEl = document.getElementById('batteryPercent');
  const altitudeFill = document.getElementById('altitudeFill');
  const speedReadout = document.getElementById('speedReadout');

  const desiredCamPos = new THREE.Vector3();
  const camLookTarget = new THREE.Vector3();
  const CAM_UP_AXIS = new THREE.Vector3(0, 1, 0);
  const TILT_ANGLE = 0.35;
  const yawQuat = new THREE.Quaternion();
  const tiltQuat = new THREE.Quaternion();
  const tiltEuler = new THREE.Euler();

  function updateDrone(dt) {
    if (state.crashed) return;

    const { throttle, yawInput, pitchInput, rollInput } = readInput();
    const isMoving = throttle !== 0 || yawInput !== 0 || pitchInput !== 0 || rollInput !== 0;

    state.yaw -= yawInput * DRONE_STATS.yawSpeed * dt;

    const forward = new THREE.Vector3(Math.sin(state.yaw), 0, Math.cos(state.yaw));
    // 카메라가 드론 "뒤"에서 forward 방향을 바라보므로, 화면상 오른쪽은
    // cross(forward, up) 방향이다.
    const right = new THREE.Vector3(-Math.cos(state.yaw), 0, Math.sin(state.yaw));

    const desired = new THREE.Vector3();
    desired.addScaledVector(forward, pitchInput * DRONE_STATS.maxSpeed);
    desired.addScaledVector(right, rollInput * DRONE_STATS.maxSpeed);
    desired.y = throttle * DRONE_STATS.vertSpeed;

    state.velocity.lerp(desired, Math.min(1, DRONE_STATS.accel * dt));
    if (!isMoving) {
      state.velocity.multiplyScalar(Math.max(0, 1 - DRONE_STATS.damping * dt));
    }

    drone.position.addScaledVector(state.velocity, dt);
    resolveCollisions(drone.position, state.velocity, DRONE_RADIUS);
    if (drone.position.y < -20) {
      drone.position.y = -20;
      state.velocity.y = Math.max(0, state.velocity.y);
    }

    // 기울임(뱅킹)은 드론 "자기 몸통 기준" 회전이라, yaw로 이미 돌아간 뒤에
    // 단순히 rotation.x/z를 직접 넣으면 요(yaw)가 0이 아닐 때 기울어지는
    // 축이 화면 기준과 어긋난다. yaw 쿼터니언 * 로컬 기울임 쿼터니언 순서로
    // 합성해야 어느 방향을 보고 있든 "왼쪽으로 이동 = 왼쪽으로 기욺"이 성립한다.
    state.pitchTilt = THREE.MathUtils.lerp(state.pitchTilt, pitchInput * TILT_ANGLE, 0.15);
    state.rollTilt = THREE.MathUtils.lerp(state.rollTilt, rollInput * TILT_ANGLE, 0.15);
    tiltEuler.set(state.pitchTilt, 0, state.rollTilt);
    tiltQuat.setFromEuler(tiltEuler);
    yawQuat.setFromAxisAngle(CAM_UP_AXIS, state.yaw);
    drone.quaternion.copy(yawQuat).multiply(tiltQuat);

    for (const r of rotors) {
      r.rotation.y += dt * (isMoving ? 40 : 18);
    }

    if (isMoving && state.battery > 0) {
      state.battery = Math.max(0, state.battery - DRONE_STATS.batteryDrainPerSec * dt);
    }
    if (state.battery <= 0) {
      state.crashed = true;
    }

    updateMissions(dt);

    const speedKmh = state.velocity.length() * 3.6;
    batteryFill.style.width = `${state.battery}%`;
    batteryPercentEl.textContent = `${Math.round(state.battery)}%`;
    altitudeFill.style.width = `${Math.min(100, Math.max(0, drone.position.y / 70) * 100)}%`;
    speedReadout.textContent = `${speedKmh.toFixed(0)} km/h`;
  }

  function updateCamera(dt) {
    // 드론이 바라보는 방향(forward)의 반대쪽, 즉 "뒤"에 카메라를 둬야 추격 시점이 된다.
    const camOffset = new THREE.Vector3(0, 6, -18).applyAxisAngle(CAM_UP_AXIS, state.yaw);
    desiredCamPos.copy(drone.position).add(camOffset);
    camera.position.lerp(desiredCamPos, Math.min(1, 6 * dt));
    camLookTarget.copy(drone.position).add(new THREE.Vector3(0, 1, 0));
    camera.lookAt(camLookTarget);
  }

  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta());
    updateDrone(dt);
    updateCamera(dt);
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
