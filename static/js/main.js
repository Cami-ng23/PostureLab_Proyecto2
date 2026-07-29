import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/* ------------------------------------------------------------------ */
/*  PostureLab · Simulador de estados posturales (sin cámara)          */
/*  Maniquí real "male_primitive_realistic" extraído del bundle de     */
/*  Blender (assets/posturelab_mannequin.glb, ~0.42MB, sin materiales  */
/*  -> los pintamos nosotros por zona).                                */
/* ------------------------------------------------------------------ */

const CYCLE_MS = 3000;
const NEUTRAL = "#4C5A6E";
const GOOD = "#4ADE9C";
const BAD = "#FF5A5F";
const REF = "#39445A";

// nombre exacto del nodo en el .glb -> zona postural que representa
const ZONE_NODE_NAMES = {
  head: "GEO-head_male_primitive_realistic",
  neck: "GEO-neck_male_primitive_realistic",
  shoulderL: "GEO-shoulder_male_primitive_realistic.L",
  shoulderR: "GEO-shoulder_male_primitive_realistic.R",
  upperSpine: "GEO-chest_male_primitive_realistic",
  lowerSpine: "GEO-belly_male_primitive_realistic",
};
const ZONE_KEYS = Object.keys(ZONE_NODE_NAMES);

const STATES = [
  {
    id: "good",
    label: "Postura correcta",
    desc: "Alineación cervical y de tronco dentro de los rangos saludables.",
    ok: true,
    zones: [],
    metric: { name: "Ángulo cervical", value: "6°", limit: "20°", within: true },
    metric2: { name: "Inclinación de torso", value: "3°", limit: "15°", within: true },
    pose: { neck: 0, torso: 0, shoulderTilt: 0 },
  },
  {
    id: "neck",
    label: "Cuello proyectado hacia adelante",
    desc: "El ángulo cervical supera el umbral de 20° — la cabeza se adelanta respecto a los hombros.",
    ok: false,
    zones: ["neck", "head"],
    metric: { name: "Ángulo cervical", value: "27°", limit: "20°", within: false },
    metric2: { name: "Inclinación de torso", value: "4°", limit: "15°", within: true },
    pose: { neck: 0.45, torso: 0, shoulderTilt: 0 },
  },
  {
    id: "shoulders",
    label: "Hombro derecho descompensado",
    desc: "La línea de hombros pierde nivelación horizontal respecto al eje de referencia.",
    ok: false,
    zones: ["shoulderR"],
    metric: { name: "Desnivel de hombros", value: "3.2 cm", limit: "1.5 cm", within: false },
    metric2: { name: "Inclinación de torso", value: "5°", limit: "15°", within: true },
    pose: { neck: 0, torso: 0, shoulderTilt: -0.28 },
  },
  {
    id: "torso",
    label: "Inclinación excesiva del torso",
    desc: "El torso se inclina más de 15° respecto a la vertical de la cadera.",
    ok: false,
    zones: ["upperSpine", "lowerSpine"],
    metric: { name: "Ángulo cervical", value: "9°", limit: "20°", within: true },
    metric2: { name: "Inclinación de torso", value: "22°", limit: "15°", within: false },
    pose: { neck: 0.06, torso: 0.32, shoulderTilt: 0 },
  },
  {
    id: "combo",
    label: "Postura encorvada (patrón combinado)",
    desc: "Cuello y espalda superan sus umbrales a la vez — típico de fatiga prolongada frente al monitor.",
    ok: false,
    zones: ["neck", "head", "upperSpine"],
    metric: { name: "Ángulo cervical", value: "24°", limit: "20°", within: false },
    metric2: { name: "Inclinación de torso", value: "18°", limit: "15°", within: false },
    pose: { neck: 0.38, torso: 0.2, shoulderTilt: 0.06 },
  },
];

/* ---------------------------- estado UI ---------------------------- */

let stateIdx = 0;
let cycleStart = performance.now();
const zoneTargets = {};
const poseTarget = { neck: 0, torso: 0, shoulderTilt: 0 };
const poseCurrent = { neck: 0, torso: 0, shoulderTilt: 0 };
const zoneObjects = {};
let poseNodes = {};
let rimLight = null;
let rimTarget = new THREE.Color(GOOD);
let rimCurrent = new THREE.Color(GOOD);
let history = [];

const el = {
  statusCard: document.getElementById("status-card"),
  statusTag: document.getElementById("status-tag"),
  statusLabel: document.getElementById("status-label"),
  statusDesc: document.getElementById("status-desc"),
  statusIcon: document.getElementById("status-icon"),
  metric1Name: document.getElementById("metric1-name"),
  metric1Value: document.getElementById("metric1-value"),
  metric1Bar: document.getElementById("metric1-bar"),
  metric2Name: document.getElementById("metric2-name"),
  metric2Value: document.getElementById("metric2-value"),
  metric2Bar: document.getElementById("metric2-bar"),
  progressBar: document.getElementById("progress-bar"),
  historyList: document.getElementById("history-list"),
  modelError: document.getElementById("model-error"),
};

const ICON_OK = `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`;
const ICON_BAD = `<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`;

function renderMetric(prefix, m) {
  el[`${prefix}Name`].textContent = m.name;
  el[`${prefix}Value`].innerHTML = `${m.value} <span>/ ${m.limit}</span>`;
  el[`${prefix}Value`].classList.toggle("bad", !m.within);
  el[`${prefix}Bar`].style.width = m.within ? "40%" : "88%";
  el[`${prefix}Bar`].style.background = m.within ? GOOD : BAD;
}

function applyStateIndex(idx) {
  const s = STATES[idx];
  const zoneSet = new Set(s.zones);
  ZONE_KEYS.forEach((z) => {
    zoneTargets[z] = zoneSet.has(z) ? BAD : GOOD;
  });
  Object.assign(poseTarget, s.pose);
  rimTarget = new THREE.Color(s.ok ? GOOD : BAD);

  el.statusCard.classList.toggle("bad", !s.ok);
  el.statusTag.classList.toggle("bad", !s.ok);
  el.statusTag.textContent = s.ok ? "Estado correcto" : "Zona afectada detectada";
  el.statusIcon.innerHTML = s.ok ? ICON_OK : ICON_BAD;
  el.statusIcon.setAttribute("stroke", s.ok ? GOOD : BAD);
  el.statusLabel.textContent = s.label;
  el.statusDesc.textContent = s.desc;
  renderMetric("metric1", s.metric);
  renderMetric("metric2", s.metric2);

  history = [{ label: s.label, ok: s.ok, t: Date.now() }, ...history].slice(0, 4);
  el.historyList.innerHTML = history
    .map(
      (h) =>
        `<div class="pl-history-row"><i class="dot" style="background:${h.ok ? GOOD : BAD}"></i>${h.label}</div>`
    )
    .join("");
}

applyStateIndex(0);
setInterval(() => {
  stateIdx = (stateIdx + 1) % STATES.length;
  cycleStart = performance.now();
  applyStateIndex(stateIdx);
}, CYCLE_MS);

(function tickProgress() {
  const elapsed = performance.now() - cycleStart;
  el.progressBar.style.width = `${Math.min(100, (elapsed / CYCLE_MS) * 100)}%`;
  requestAnimationFrame(tickProgress);
})();

/* ------------------------------ escena ------------------------------ */

const canvas = document.getElementById("scene");
const wrap = document.querySelector(".pl-canvas-wrap");

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b1119, 4, 12);

const camera = new THREE.PerspectiveCamera(38, wrap.clientWidth / wrap.clientHeight, 0.1, 100);
camera.position.set(0, 1.35, 5.2);
camera.lookAt(0, 1.05, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(wrap.clientWidth, wrap.clientHeight);
renderer.setClearColor(0x000000, 0);

const ambient = new THREE.AmbientLight(0x8fa3c0, 0.7);
scene.add(ambient);
const key = new THREE.DirectionalLight(0xffffff, 0.9);
key.position.set(2.2, 3.5, 3);
scene.add(key);
const fill = new THREE.DirectionalLight(0x6f88b0, 0.35);
fill.position.set(-3, 1.5, -2);
scene.add(fill);
rimLight = new THREE.DirectionalLight(GOOD, 0.9);
rimLight.position.set(-1.5, 2, -3.5);
scene.add(rimLight);

const grid = new THREE.GridHelper(9, 18, 0x22334a, 0x17202e);
grid.position.y = -0.02;
scene.add(grid);

const root = new THREE.Group();
scene.add(root);

window.addEventListener("resize", () => {
  camera.aspect = wrap.clientWidth / wrap.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
});

const loader = new GLTFLoader();
loader.load(
  window.PL_GLB_URL || "/static/assets/posturelab_mannequin.glb",
  (gltf) => {
    const model = gltf.scene;

    model.traverse((child) => {
      if (child.isMesh) {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(NEUTRAL),
          roughness: 0.5,
          metalness: 0.06,
        });
      }
    });

    ZONE_KEYS.forEach((z) => {
      const obj = model.getObjectByName(ZONE_NODE_NAMES[z]);
      if (obj) zoneObjects[z] = obj;
    });

    const pelvis = model.getObjectByName("GEO-pelvis_male_primitive_realistic");
    if (pelvis && pelvis.material) pelvis.material.color.set(REF);

    const neckNode = model.getObjectByName("GEO-neck_male_primitive_realistic");
    const chestNode = model.getObjectByName("GEO-chest_male_primitive_realistic");
    const shoulderLNode = model.getObjectByName("GEO-shoulder_male_primitive_realistic.L");
    const shoulderRNode = model.getObjectByName("GEO-shoulder_male_primitive_realistic.R");
    poseNodes = {
      neck: neckNode ? { node: neckNode, rest: neckNode.rotation.clone() } : null,
      chest: chestNode ? { node: chestNode, rest: chestNode.rotation.clone() } : null,
      shoulderL: shoulderLNode ? { node: shoulderLNode, rest: shoulderLNode.rotation.clone() } : null,
      shoulderR: shoulderRNode ? { node: shoulderRNode, rest: shoulderRNode.rotation.clone() } : null,
    };

    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const targetHeight = 1.7;
    const scale = size.y > 0 ? targetHeight / size.y : 1;
    model.scale.setScalar(scale);

    const box2 = new THREE.Box3().setFromObject(model);
    const center2 = new THREE.Vector3();
    box2.getCenter(center2);
    model.position.x -= center2.x;
    model.position.z -= center2.z;
    model.position.y -= box2.min.y;

    root.add(model);
    animate();
  },
  undefined,
  (err) => {
    console.error("Error cargando el modelo:", err);
    el.modelError.hidden = false;
    animate();
  }
);

const clock = new THREE.Clock();
const currentColors = {};
ZONE_KEYS.forEach((z) => (currentColors[z] = new THREE.Color(NEUTRAL)));

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const LERP = 1 - Math.pow(0.001, dt);

  root.rotation.y += dt * 0.5;

  poseCurrent.neck += (poseTarget.neck - poseCurrent.neck) * LERP;
  poseCurrent.torso += (poseTarget.torso - poseCurrent.torso) * LERP;
  poseCurrent.shoulderTilt += (poseTarget.shoulderTilt - poseCurrent.shoulderTilt) * LERP;

  if (poseNodes.neck) poseNodes.neck.node.rotation.x = poseNodes.neck.rest.x + poseCurrent.neck;
  if (poseNodes.chest) poseNodes.chest.node.rotation.x = poseNodes.chest.rest.x + poseCurrent.torso;
  if (poseNodes.shoulderL) poseNodes.shoulderL.node.rotation.z = poseNodes.shoulderL.rest.z + poseCurrent.shoulderTilt;
  if (poseNodes.shoulderR) poseNodes.shoulderR.node.rotation.z = poseNodes.shoulderR.rest.z + poseCurrent.shoulderTilt;

  ZONE_KEYS.forEach((z) => {
    const obj = zoneObjects[z];
    if (!obj || !obj.material) return;
    const targetHex = zoneTargets[z] || GOOD;
    const targetColor = new THREE.Color(targetHex);
    currentColors[z].lerp(targetColor, LERP);
    obj.material.color.copy(currentColors[z]);
    const isBad = targetHex === BAD;
    const emissiveTarget = isBad ? new THREE.Color(BAD) : new THREE.Color(0x000000);
    obj.material.emissive.lerp(emissiveTarget, LERP);
    obj.material.emissiveIntensity = 0.5;
  });

  rimCurrent.lerp(rimTarget, LERP);
  if (rimLight) rimLight.color.copy(rimCurrent);

  renderer.render(scene, camera);
}
