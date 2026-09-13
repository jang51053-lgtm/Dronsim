import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Joystick } from './joystick.js';

// ---- 드론 스탯 (균형형 기본기, PRD 3.1) ----
const DRONE_STATS = {
  maxSpeed: 9,        // m/s
  accel: 14,          // m/s^2
  damping: 4,         // 관성 감쇠
  yawSpeed: 2.2,       // rad/s
  vertSpeed: 5,        // m/s
  batteryDrainPerSec: 100 / 90, // 90초에 완전 방전
};

const MAP_SCALE = 12;    // 맵 에셋이 정규화 좌표라 스케일 업
const DRONE_TARGET_SIZE = 1.4; // 드론 모델의 최대 치수를 이 값(미터)에 맞춰 정규화

// GitHub Pages 같은 서브경로 배포에서도 에셋을 찾도록 base 경로를 붙인다.
const ASSET_BASE = import.meta.env.BASE_URL;
const assetUrl = (path) => `${ASSET_BASE}${path}`;

const state = {
  velocity: new THREE.Vector3(),
  yaw: 0,
  battery: 100,
  crashed: false,
  keys: {},
};

const leftStick = new Joystick(document.getElementById('joystickLeft'));
const rightStick = new Joystick(document.getElementById('joystickRight'));

window.addEventListener('keydown', (e) => { state.keys[e.code] = true; });
window.addEventListener('keyup', (e) => { state.keys[e.code] = false; });

// ---- 렌더러 / 씬 / 카메라 ----
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fd0ff);
scene.fog = new THREE.Fog(0x8fd0ff, 60, 220);

const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
pmremGenerator.dispose();

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 3, 8);

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

// 임시 바닥 (맵 로드 실패 대비 + 그림자 수신)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x4a7c3a })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
ground.receiveShadow = true;
scene.add(ground);

// ---- 드론 로드 ----
let drone = new THREE.Group();
scene.add(drone);
drone.position.set(0, 16, 22);

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
    console.log('드론 GLB 로드 완료, 로터', rotors.length, '개');
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

// ---- 맵 로드 ----
new MTLLoader().load(
  assetUrl('assets/map.mtl'),
  (materials) => {
    materials.preload();
    new OBJLoader()
      .setMaterials(materials)
      .load(
        assetUrl('assets/map.obj'),
        (obj) => {
          obj.scale.setScalar(MAP_SCALE);
          obj.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(obj);
          obj.position.x -= (box.min.x + box.max.x) / 2;
          obj.position.z -= (box.min.z + box.max.z) / 2;
          obj.position.y -= box.min.y;
          obj.traverse((c) => {
            if (c.isMesh) {
              c.castShadow = true;
              c.receiveShadow = true;
            }
          });
          scene.add(obj);
          ground.visible = false;
          console.log('맵 로드 완료 (높이 범위 0 ~', (box.max.y - box.min.y).toFixed(1), ')');
        },
        undefined,
        (err) => console.error('맵 로드 실패', err)
      );
  },
  undefined,
  (err) => console.error('맵 머티리얼 로드 실패', err)
);

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
const altitudeFill = document.getElementById('altitudeFill');
const speedReadout = document.getElementById('speedReadout');

const desiredCamPos = new THREE.Vector3();
const camLookTarget = new THREE.Vector3();

function updateDrone(dt) {
  if (state.crashed) return;

  const { throttle, yawInput, pitchInput, rollInput } = readInput();
  const isMoving = throttle !== 0 || yawInput !== 0 || pitchInput !== 0 || rollInput !== 0;

  state.yaw -= yawInput * DRONE_STATS.yawSpeed * dt;

  const forward = new THREE.Vector3(Math.sin(state.yaw), 0, Math.cos(state.yaw));
  const right = new THREE.Vector3(Math.cos(state.yaw), 0, -Math.sin(state.yaw));

  const desired = new THREE.Vector3();
  desired.addScaledVector(forward, pitchInput * DRONE_STATS.maxSpeed);
  desired.addScaledVector(right, rollInput * DRONE_STATS.maxSpeed);
  desired.y = throttle * DRONE_STATS.vertSpeed;

  state.velocity.lerp(desired, Math.min(1, DRONE_STATS.accel * dt));
  if (!isMoving) {
    state.velocity.multiplyScalar(Math.max(0, 1 - DRONE_STATS.damping * dt));
  }

  drone.position.addScaledVector(state.velocity, dt);
  if (drone.position.y < 0.3) {
    drone.position.y = 0.3;
    state.velocity.y = Math.max(0, state.velocity.y);
  }

  drone.rotation.y = state.yaw;
  const tiltTarget = new THREE.Vector3(-rollInput * 0.35, 0, pitchInput * 0.35);
  drone.rotation.z = THREE.MathUtils.lerp(drone.rotation.z, tiltTarget.x, 0.1);
  drone.rotation.x = THREE.MathUtils.lerp(drone.rotation.x, tiltTarget.z, 0.1);

  for (const r of rotors) {
    r.rotation.y += dt * (isMoving ? 40 : 18);
  }

  if (isMoving && state.battery > 0) {
    state.battery = Math.max(0, state.battery - DRONE_STATS.batteryDrainPerSec * dt);
  }
  if (state.battery <= 0) {
    state.crashed = true;
  }

  const speedKmh = state.velocity.length() * 3.6;
  batteryFill.style.width = `${state.battery}%`;
  altitudeFill.style.width = `${Math.min(100, (drone.position.y / 20) * 100)}%`;
  speedReadout.textContent = `${speedKmh.toFixed(0)} km/h`;
}

function updateCamera(dt) {
  const camOffset = new THREE.Vector3(0, 2.2, 6).applyAxisAngle(new THREE.Vector3(0, 1, 0), state.yaw);
  desiredCamPos.copy(drone.position).add(camOffset);
  camera.position.lerp(desiredCamPos, Math.min(1, 5 * dt));
  camLookTarget.copy(drone.position).add(new THREE.Vector3(0, 0.6, 0));
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
