import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PoseWatcher } from "./pose-detector.js";

/* ------------------------------------------------------------------ */
/*  PostureLab · Simulador con escaneo real de postura (cámara)        */
/*  Maniquí real "male_primitive_realistic" extraído del bundle de     */
/*  Blender (assets/posturelab_mannequin.glb, ~0.42MB, sin materiales  */
/*  -> los pintamos nosotros por zona). El escaneo usa MediaPipe       */
/*  PoseLandmarker sobre la cámara del usuario durante 5s, y funciona  */
/*  sin importar el ángulo (de frente o de lado) porque medimos        */
/*  ángulos relativos entre segmentos del cuerpo en 3D, no contra la   */
/*  pantalla — ver static/js/pose-detector.js.                         */
/* ------------------------------------------------------------------ */

const SCAN_MS = 5000; // duración del escaneo
const HOLD_MS = 10000; // cuánto tiempo se muestra el resultado antes de volver a "listo"

const NEUTRAL = "#334155";
const IDLE_ZONE = "#475569"; // gris: aún no evaluado
const GOOD = "#10B981";
const BAD = "#EF4444";
const REF = "#475569";

// GLTFLoader sanea node.name quitando los puntos (los usa como separador de
// rutas de animación), así que "shoulder.L" termina en el árbol como
// "shoulderL". El nombre ORIGINAL del glTF queda igual en userData.name,
// así que buscamos por ahí en vez de por node.name / getObjectByName.
function findByOriginalName(root, name) {
  let found = null;
  root.traverse((child) => {
    if (!found && child.userData && child.userData.name === name) found = child;
  });
  return found;
}

// nombre(s) exacto(s) de nodo en el .glb -> zona postural que representa.
// Algunas zonas pintan más de un nodo: el hombro real ("shoulder") es una
// tapa pequeña casi tapada por el brazo, así que coloreamos también el
// brazo superior para que el cambio de color se note al mirar el modelo.
const ZONE_NODE_NAMES = {
  head: ["GEO-head_male_primitive_realistic"],
  neck: ["GEO-neck_male_primitive_realistic"],
  shoulderL: [
    "GEO-shoulder_male_primitive_realistic.L",
    "GEO-arm_upper_male_primitive_realistic.L",
    "GEO-arm_lower_male_primitive_realistic.L",
  ],
  shoulderR: [
    "GEO-shoulder_male_primitive_realistic.R",
    "GEO-arm_upper_male_primitive_realistic.R",
    "GEO-arm_lower_male_primitive_realistic.R",
  ],
  upperSpine: ["GEO-chest_male_primitive_realistic"],
  lowerSpine: ["GEO-belly_male_primitive_realistic"],
};
const ZONE_KEYS = Object.keys(ZONE_NODE_NAMES);

// texto breve para el panel que aparece al hacer click en una zona
const ZONE_INFO = {
  head: { label: "Cabeza", risk: "Llevar la cabeza muy adelantada cansa el cuello y puede darte dolores de cabeza seguidos." },
  neck: { label: "Cuello", risk: "Encorvar el cuello hacia adelante por mucho rato puede darte dolor de cuello y dolores de cabeza." },
  shoulderL: { label: "Hombro izquierdo", risk: "Cargar más un hombro que el otro puede generar dolor que se corre hasta el brazo." },
  shoulderR: { label: "Hombro derecho", risk: "Cargar más un hombro que el otro puede generar dolor que se corre hasta el brazo." },
  upperSpine: { label: "Espalda alta", risk: "Encorvar la espalda alta puede generar dolor de espalda y hacer que te canses más rápido." },
  lowerSpine: { label: "Espalda baja", risk: "Estar mal sentado presiona la espalda baja y con el tiempo puede darte dolor lumbar." },
};

// estado "listo, sin escanear todavía" — gris, sin veredicto
const IDLE_DIAGNOSIS = {
  label: "Sin escanear todavía",
  desc: "Presiona “Iniciar escaneo” y quédate cómodo frente a la cámara por 5 segundos.",
  zones: [],
  idle: true,
  pose: { neck: 0, torso: 0, shoulderTilt: 0 },
};

/* ---------------------------- estado UI ---------------------------- */

let mode = "idle"; // idle | loading | scanning | hold
let scanElapsed = 0;
let holdElapsed = 0;
let lastDiagnosis = IDLE_DIAGNOSIS;

let paused = false; // se pausa la rotación mientras el usuario inspecciona una zona
const zoneTargets = {};
const poseTarget = { neck: 0, torso: 0, shoulderTilt: 0 };
const poseCurrent = { neck: 0, torso: 0, shoulderTilt: 0 };
const zoneObjects = {}; // zona -> array de meshes
const meshToZone = new Map(); // mesh -> zona (para el raycaster de click)
let poseNodes = {};
let rimLight = null;
let rimTarget = new THREE.Color(IDLE_ZONE);
let rimCurrent = new THREE.Color(IDLE_ZONE);
let history = [];
let activeZone = null;
let lastPopupX = 0;
let lastPopupY = 0;

const poseWatcher = new PoseWatcher();

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
  metric3Name: document.getElementById("metric3-name"),
  metric3Value: document.getElementById("metric3-value"),
  metric3Bar: document.getElementById("metric3-bar"),
  progressBar: document.getElementById("progress-bar"),
  historyList: document.getElementById("history-list"),
  modelError: document.getElementById("model-error"),
  zonePopup: document.getElementById("zone-popup"),
  zonePopupTitle: document.getElementById("zone-popup-title"),
  zonePopupStatus: document.getElementById("zone-popup-status"),
  zonePopupRisk: document.getElementById("zone-popup-risk"),
  scanBtn: document.getElementById("scan-btn"),
  scanBadge: document.getElementById("scan-badge"),
  scanBadgeText: document.getElementById("scan-badge-text"),
  cameraPreview: document.getElementById("camera-preview"),
  cameraVideo: document.getElementById("camera-video"),
  cameraError: document.getElementById("camera-error"),
};

const ICON_OK = `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`;
const ICON_BAD = `<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`;
const ICON_IDLE = `<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/>`;

function renderMetric(prefix, m) {
  if (!m) {
    el[`${prefix}Name`].textContent = "—";
    el[`${prefix}Value`].innerHTML = "—";
    el[`${prefix}Value`].classList.remove("bad");
    el[`${prefix}Bar`].style.width = "0%";
    el[`${prefix}Bar`].style.background = IDLE_ZONE;
    return;
  }
  el[`${prefix}Name`].textContent = m.name;
  el[`${prefix}Value`].innerHTML = `${m.value} <span>/ ${m.limit}</span>`;
  el[`${prefix}Value`].classList.toggle("bad", !m.within);
  el[`${prefix}Bar`].style.width = m.within ? "40%" : "88%";
  el[`${prefix}Bar`].style.background = m.within ? GOOD : BAD;
}

// aplica un diagnóstico (real, salido del escaneo, o IDLE_DIAGNOSIS) tanto
// al maniquí (color de zonas + pose) como a la tarjeta de estado del HUD.
function applyDiagnosis(diag, opts = {}) {
  lastDiagnosis = diag;
  const zoneSet = new Set(diag.zones || []);
  ZONE_KEYS.forEach((z) => {
    zoneTargets[z] = diag.idle ? IDLE_ZONE : zoneSet.has(z) ? BAD : GOOD;
  });
  Object.assign(poseTarget, diag.pose || { neck: 0, torso: 0, shoulderTilt: 0 });
  rimTarget = new THREE.Color(diag.idle ? IDLE_ZONE : diag.ok ? GOOD : BAD);

  el.statusCard.classList.toggle("bad", !diag.idle && !diag.ok);
  el.statusTag.classList.toggle("bad", !diag.idle && !diag.ok);
  el.statusTag.textContent = diag.idle ? "Listo para escanear" : diag.ok ? "Postura correcta" : "Zona afectada detectada";
  el.statusIcon.innerHTML = diag.idle ? ICON_IDLE : diag.ok ? ICON_OK : ICON_BAD;
  el.statusIcon.setAttribute("stroke", diag.idle ? "#94a3b8" : diag.ok ? GOOD : BAD);
  el.statusLabel.textContent = diag.label;
  el.statusDesc.textContent = diag.desc;
  renderMetric("metric1", diag.metric || null);
  renderMetric("metric2", diag.metric2 || null);
  renderMetric("metric3", diag.metric3 || null);

  if (!diag.idle && opts.addHistory !== false) {
    history = [{ label: diag.label, ok: diag.ok, t: Date.now() }, ...history].slice(0, 4);
    el.historyList.innerHTML = history
      .map((h) => `<div class="pl-history-row"><i class="dot" style="background:${h.ok ? GOOD : BAD}"></i>${h.label}</div>`)
      .join("");
  }

  if (activeZone) openZonePopup(activeZone, lastPopupX, lastPopupY);
}

applyDiagnosis(IDLE_DIAGNOSIS, { addHistory: false });

/* ------------------------- flujo de escaneo ------------------------- */

function setScanBtnLabel(text, disabled) {
  el.scanBtn.textContent = text;
  el.scanBtn.disabled = disabled;
}

async function startScan() {
  if (mode !== "idle") return;
  el.cameraError.hidden = true;
  mode = "loading";
  setScanBtnLabel("Preparando cámara…", true);

  try {
    await poseWatcher.start(el.cameraVideo);
  } catch (err) {
    console.error("[PostureLab] no se pudo iniciar la cámara / el modelo:", err);
    el.cameraError.textContent =
      "No se pudo acceder a la cámara. Revisa los permisos del navegador y vuelve a intentarlo.";
    el.cameraError.hidden = false;
    mode = "idle";
    setScanBtnLabel("Iniciar escaneo", false);
    return;
  }

  mode = "scanning";
  scanElapsed = 0;
  el.scanBadge.hidden = false;
  el.cameraPreview.hidden = false;
  scanRingGroup.visible = true;
  setScanBtnLabel("Escaneando…", true);

  el.statusCard.classList.remove("bad");
  el.statusTag.classList.remove("bad");
  el.statusTag.textContent = "Escaneando…";
  el.statusIcon.innerHTML = ICON_IDLE;
  el.statusIcon.setAttribute("stroke", "#22d3ee");
  el.statusLabel.textContent = "Analizando tu postura";
  el.statusDesc.textContent = "Quédate en una posición natural — de frente o de lado da lo mismo.";
  el.progressBar.style.width = "0%";
}

function finishScan() {
  poseWatcher.stop();
  el.scanBadge.hidden = true;
  el.cameraPreview.hidden = true;
  scanRingGroup.visible = false;

  const diag = poseWatcher.buildDiagnosis();
  if (diag.insufficient) {
    el.cameraError.textContent = diag.message;
    el.cameraError.hidden = false;
    applyDiagnosis(IDLE_DIAGNOSIS, { addHistory: false });
    mode = "idle";
    setScanBtnLabel("Iniciar escaneo", false);
    el.progressBar.style.width = "0%";
    return;
  }

  applyDiagnosis(diag);
  mode = "hold";
  holdElapsed = 0;
  el.progressBar.style.width = "100%";
  el.progressBar.style.background = diag.ok ? GOOD : BAD;
  setScanBtnLabel("Nuevo escaneo en 10s…", true);
}

function goIdleAfterHold() {
  applyDiagnosis(IDLE_DIAGNOSIS, { addHistory: false });
  mode = "idle";
  el.progressBar.style.background = "";
  el.progressBar.style.width = "0%";
  setScanBtnLabel("Iniciar escaneo", false);
}

el.scanBtn.addEventListener("click", startScan);

/* --------------------- click en una zona -> popup --------------------- */

function openZonePopup(zoneKey, x, y) {
  activeZone = zoneKey;
  lastPopupX = x;
  lastPopupY = y;
  paused = true;

  const info = ZONE_INFO[zoneKey];
  const isBad = zoneTargets[zoneKey] === BAD;

  el.zonePopupTitle.textContent = info.label;
  el.zonePopupStatus.textContent = isBad ? "Zona con riesgo detectado ahora" : "Dentro de rango saludable ahora";
  el.zonePopupStatus.style.color = isBad ? BAD : GOOD;
  el.zonePopupRisk.textContent = info.risk;
  el.zonePopup.classList.toggle("bad", isBad);
  el.zonePopup.hidden = false;

  const wrap = document.querySelector(".pl-canvas-wrap");
  const rect = wrap.getBoundingClientRect();
  const popupWidth = 240;
  let left = x - rect.left + 16;
  let top = y - rect.top - 10;
  if (left + popupWidth > rect.width) left = x - rect.left - popupWidth - 16;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  if (top > rect.height - 140) top = rect.height - 140;
  el.zonePopup.style.left = `${left}px`;
  el.zonePopup.style.top = `${top}px`;
}

function closeZonePopup() {
  activeZone = null;
  paused = false;
  el.zonePopup.hidden = true;
}

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

function zoneAtEvent(e) {
  const rect = canvas.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
    return null;
  }
  pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObjects(root.children, true);
  for (const hit of hits) {
    const zone = meshToZone.get(hit.object);
    if (zone) return zone;
  }
  return null;
}

document.addEventListener("click", (e) => {
  if (el.zonePopup.contains(e.target)) return; // click dentro del popup: no hacer nada
  if (el.scanBtn.contains(e.target)) return; // no confundir el click del botón con un click en el maniquí
  const zone = zoneAtEvent(e);
  if (zone) {
    openZonePopup(zone, e.clientX, e.clientY);
  } else {
    closeZonePopup();
  }
});

/* ------------------------------ escena ------------------------------ */
/*  Todo este bloque (carga del .glb, zonas, pose, animate) es el mismo */
/*  que ya funcionaba con el maniquí — no se toca.                      */

const canvas = document.getElementById("scene");
const wrap = document.querySelector(".pl-canvas-wrap");

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b1119, 4, 12);

const camera = new THREE.PerspectiveCamera(38, wrap.clientWidth / wrap.clientHeight, 0.1, 100);
camera.position.set(0, 1.25, 3.9);
camera.lookAt(0, 1.0, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(wrap.clientWidth, wrap.clientHeight);
renderer.setClearColor(0x000000, 0);

const ambient = new THREE.AmbientLight(0x3b5c8f, 0.7);
scene.add(ambient);
const key = new THREE.DirectionalLight(0xf8fafc, 0.9);
key.position.set(2.2, 3.5, 3);
scene.add(key);
const fill = new THREE.DirectionalLight(0x22d3ee, 0.3);
fill.position.set(-3, 1.5, -2);
scene.add(fill);
rimLight = new THREE.DirectionalLight(IDLE_ZONE, 0.9);
rimLight.position.set(-1.5, 2, -3.5);
scene.add(rimLight);

const grid = new THREE.GridHelper(9, 18, 0x3b82f6, 0x151c2c);
grid.position.y = -0.02;
scene.add(grid);

const root = new THREE.Group();
scene.add(root);

// --- aro de escaneo: sube y baja atravesando el cuerpo mientras dura el
// escaneo (5s), igual que en la referencia. Son dos toros concéntricos
// (uno fino y brillante, otro más grueso y tenue detrás) para dar sensación
// de glow sin depender de post-procesado.
const SCAN_RING_COLOR = 0x2dd8a6;
const scanRingGroup = new THREE.Group();
scanRingGroup.rotation.x = Math.PI / 2; // lo acuesta en el plano XZ (horizontal)
scanRingGroup.visible = false;
const scanRingCore = new THREE.Mesh(
  new THREE.TorusGeometry(0.5, 0.006, 8, 72),
  new THREE.MeshBasicMaterial({ color: SCAN_RING_COLOR, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending })
);
const scanRingGlow = new THREE.Mesh(
  new THREE.TorusGeometry(0.5, 0.05, 8, 72),
  new THREE.MeshBasicMaterial({ color: SCAN_RING_COLOR, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false })
);
scanRingGroup.add(scanRingGlow, scanRingCore);
scene.add(scanRingGroup);

const SCAN_RING_MIN_Y = 0.06;
const SCAN_RING_MAX_Y = 1.62;
const SCAN_RING_PERIOD_MS = 1400; // tiempo de un viaje completo subiendo o bajando

function updateScanRing() {
  // sube y baja en diente de sierra suavizado (ease in/out) durante todo el escaneo
  const t = (scanElapsed % (SCAN_RING_PERIOD_MS * 2)) / (SCAN_RING_PERIOD_MS * 2); // 0..1
  const goingUp = t < 0.5;
  const local = goingUp ? t * 2 : (1 - t) * 2; // 0..1 dentro de cada tramo
  const eased = 0.5 - 0.5 * Math.cos(local * Math.PI); // ease in/out
  scanRingGroup.position.y = SCAN_RING_MIN_Y + eased * (SCAN_RING_MAX_Y - SCAN_RING_MIN_Y);
  const pulse = 1 + Math.sin(scanElapsed * 0.02) * 0.015;
  scanRingGroup.scale.setScalar(pulse);
}

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
      const found = [];
      ZONE_NODE_NAMES[z].forEach((name) => {
        const obj = findByOriginalName(model, name);
        if (obj) {
          found.push(obj);
          meshToZone.set(obj, z);
        } else {
          console.warn(`[PostureLab] no se encontró el nodo "${name}" (zona "${z}")`);
        }
      });
      zoneObjects[z] = found;
    });

    const pelvis = findByOriginalName(model, "GEO-pelvis_male_primitive_realistic");
    if (pelvis && pelvis.material) pelvis.material.color.set(REF);

    const neckNode = findByOriginalName(model, "GEO-neck_male_primitive_realistic");
    const chestNode = findByOriginalName(model, "GEO-chest_male_primitive_realistic");
    const shoulderLNode = findByOriginalName(model, "GEO-shoulder_male_primitive_realistic.L");
    const shoulderRNode = findByOriginalName(model, "GEO-shoulder_male_primitive_realistic.R");
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
    const pelvisWorld = new THREE.Vector3();
    if (pelvis) pelvis.getWorldPosition(pelvisWorld);
    model.position.x -= pelvisWorld.x;
    model.position.z -= pelvisWorld.z;
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

function tickScanBadge() {
  const pct = Math.min(100, Math.round((scanElapsed / SCAN_MS) * 100));
  el.scanBadgeText.textContent = `Escaneo en progreso · ${pct}%`;
  el.progressBar.style.width = `${pct}%`;
  updateScanRing();
}

function tickHold(dtMs) {
  holdElapsed += dtMs;
  const remaining = Math.max(0, 100 - (holdElapsed / HOLD_MS) * 100);
  el.progressBar.style.width = `${remaining}%`;
  if (holdElapsed >= HOLD_MS) goIdleAfterHold();
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const dtMs = dt * 1000;
  const LERP = 1 - Math.pow(0.001, dt);

  if (mode === "scanning") {
    scanElapsed += dtMs;
    tickScanBadge();
    if (scanElapsed >= SCAN_MS) finishScan();
  } else if (mode === "hold") {
    tickHold(dtMs);
  }

  if (!paused) root.rotation.y += dt * (mode === "scanning" ? 0.12 : 0.35);

  poseCurrent.neck += (poseTarget.neck - poseCurrent.neck) * LERP;
  poseCurrent.torso += (poseTarget.torso - poseCurrent.torso) * LERP;
  poseCurrent.shoulderTilt += (poseTarget.shoulderTilt - poseCurrent.shoulderTilt) * LERP;

  if (poseNodes.neck) poseNodes.neck.node.rotation.x = poseNodes.neck.rest.x + poseCurrent.neck;
  if (poseNodes.chest) poseNodes.chest.node.rotation.x = poseNodes.chest.rest.x + poseCurrent.torso;
  if (poseNodes.shoulderL) poseNodes.shoulderL.node.rotation.z = poseNodes.shoulderL.rest.z + poseCurrent.shoulderTilt;
  if (poseNodes.shoulderR) poseNodes.shoulderR.node.rotation.z = poseNodes.shoulderR.rest.z + poseCurrent.shoulderTilt;

  ZONE_KEYS.forEach((z) => {
    const targetHex = zoneTargets[z] || IDLE_ZONE;
    const targetColor = new THREE.Color(targetHex);
    currentColors[z].lerp(targetColor, LERP);
    const isBad = targetHex === BAD;
    const emissiveTarget = isBad ? new THREE.Color(BAD) : new THREE.Color(0x000000);
    (zoneObjects[z] || []).forEach((obj) => {
      if (!obj.material) return;
      obj.material.color.copy(currentColors[z]);
      obj.material.emissive.lerp(emissiveTarget, LERP);
      obj.material.emissiveIntensity = 0.5;
    });
  });

  rimCurrent.lerp(rimTarget, LERP);
  if (rimLight) rimLight.color.copy(rimCurrent);

  renderer.render(scene, camera);
}
