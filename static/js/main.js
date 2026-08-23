import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { startCamera, stopCamera, runScan } from "./posture-scan.js";

/* ------------------------------------------------------------------ */
/*  PostureLab · Escaneo real de postura con cámara                    */
/*  Maniquí real "male_primitive_realistic" extraído del bundle de     */
/*  Blender (assets/posturelab_mannequin.glb, ~0.42MB, sin materiales  */
/*  -> los pintamos nosotros por zona).                                */
/* ------------------------------------------------------------------ */

const SCAN_MS = 5000;
const HOLD_MS = 5000;
const NEUTRAL = "#334155";
const GOOD = "#10B981";
const BAD = "#EF4444";
const REF = "#475569";
// acentos de severidad general (no se usan en el cuerpo, solo en el panel):
// 1 zona afectada = amarillo, 2 = rojo, 3+ o un caso severo = morado.
const WARN = "#F59E0B";
const SEVERE = "#8B5CF6";

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function severityColor(issueCount, hasSevereIssue) {
  if (issueCount === 0) return GOOD;
  if (hasSevereIssue || issueCount >= 3) return SEVERE;
  if (issueCount === 2) return BAD;
  return WARN;
}

const THRESHOLDS = { cervical: 20, torso: 15, shoulder: 6 };

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
  shoulderL: ["GEO-shoulder_male_primitive_realistic.L"],
  shoulderR: ["GEO-shoulder_male_primitive_realistic.R"],
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

/* ---------------------------- estado UI ---------------------------- */

let uiState = "idle"; // idle | scanning | result
let holdElapsed = 0;
let paused = false; // se pausa el hold de resultados mientras se inspecciona una zona
const zoneTargets = {};
const poseTarget = { neck: 0, torso: 0, shoulderTilt: 0 };
const poseCurrent = { neck: 0, torso: 0, shoulderTilt: 0 };
const zoneObjects = {}; // zona -> array de meshes
const meshToZone = new Map(); // mesh -> zona (para el raycaster de click)
let poseNodes = {};
let rimLight = null;
let rimTarget = new THREE.Color(GOOD);
let rimCurrent = new THREE.Color(GOOD);
let history = [];
let activeZone = null;
let lastPopupX = 0;
let lastPopupY = 0;
let lastResult = null;

ZONE_KEYS.forEach((z) => (zoneTargets[z] = GOOD));

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
  scanButton: document.getElementById("scan-button"),
  scanBadge: document.getElementById("scan-badge"),
  scanPercent: document.getElementById("scan-percent"),
  cameraPreview: document.getElementById("camera-preview"),
  cameraError: document.getElementById("camera-error"),
  gaugeNeedle: document.getElementById("gauge-needle"),
  gaugeNumber: document.getElementById("gauge-number"),
  gaugeSeverity: document.getElementById("gauge-severity"),
  zonesList: document.getElementById("zones-list"),
};

const ICON_OK = `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`;
const ICON_BAD = `<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`;
const ICON_SCAN = `<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>`;

function renderMetric(prefix, m) {
  el[`${prefix}Name`].textContent = m.name;
  el[`${prefix}Value`].innerHTML = `${m.value} <span>/ ${m.limit}</span>`;
  el[`${prefix}Value`].classList.toggle("bad", !m.within);
  el[`${prefix}Bar`].style.width = m.within ? "40%" : "88%";
  el[`${prefix}Bar`].style.background = m.within ? GOOD : BAD;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Convierte un ángulo medido (grados) en radianes de "flexión" para animar
// el maniquí: se le resta una línea base natural y se recorta a un máximo,
// para que el movimiento se vea proporcional pero no distorsione la malla.
function angleToPoseRad(deg, baselineDeg, maxDeg) {
  if (deg == null) return 0;
  const over = Math.max(0, Math.min(deg - baselineDeg, maxDeg));
  return THREE.MathUtils.degToRad(over);
}

function renderZonesList(scanned) {
  el.zonesList.innerHTML = ZONE_KEYS.map((z) => {
    const info = ZONE_INFO[z];
    if (!scanned) {
      return `<div class="pl-zone-row"><i class="dot" style="background:${REF}"></i><span class="pl-zone-name">${info.label}</span><span class="pl-zone-status" style="color:${REF}">—</span></div>`;
    }
    const color = zoneTargets[z] || GOOD;
    const statusText = color === GOOD ? "Correcto" : "Afectado";
    return `<div class="pl-zone-row"><i class="dot" style="background:${color}"></i><span class="pl-zone-name">${info.label}</span><span class="pl-zone-status" style="color:${color}">${statusText}</span></div>`;
  }).join("");
}

function updateGauge(cervicalAngle, cervicalBad, cervicalSevere) {
  if (cervicalAngle == null) {
    el.gaugeNumber.textContent = "—";
    el.gaugeSeverity.textContent = "Sin datos";
    el.gaugeSeverity.style.color = "";
    el.gaugeSeverity.style.background = "";
    el.gaugeNeedle.setAttribute("transform", "rotate(180 100 95)");
    return;
  }
  const clamped = Math.max(0, Math.min(cervicalAngle, 60));
  const rotateDeg = (clamped / 60) * 180 - 180;
  el.gaugeNeedle.setAttribute("transform", `rotate(${rotateDeg} 100 95)`);
  el.gaugeNumber.textContent = round1(cervicalAngle);

  const label = cervicalSevere ? "Severo" : cervicalBad ? "Afectado" : "Correcto";
  const color = cervicalSevere ? SEVERE : cervicalBad ? BAD : GOOD;
  el.gaugeSeverity.textContent = label;
  el.gaugeSeverity.style.color = color;
  el.gaugeSeverity.style.background = hexToRgba(color, 0.14);
}

function setIdleCard() {
  el.statusCard.classList.remove("bad");
  el.statusTag.classList.remove("bad");
  el.statusTag.textContent = lastResult ? "Listo para volver a escanear" : "En espera";
  el.statusIcon.innerHTML = ICON_SCAN;
  el.statusIcon.setAttribute("stroke", "#94a3b8");
  el.statusLabel.textContent = "Postura normal";
  el.statusDesc.textContent = lastResult
    ? "Volvimos al estado neutral. Presioná Iniciar escaneo cuando quieras medir de nuevo."
    : "Activamos tu cámara 5 segundos para medir tu postura. Podés estar de frente, de lado, como te resulte más cómodo.";
  el.progressBar.style.width = "0%";
}

// vuelve todo (zonas, pose del maniquí, gauge, lista de zonas) al estado
// neutral/verde, listo para el próximo escaneo — se usa cuando termina el
// hold de 5s del resultado.
function resetToNeutral() {
  ZONE_KEYS.forEach((z) => (zoneTargets[z] = GOOD));
  poseTarget.neck = 0;
  poseTarget.torso = 0;
  poseTarget.shoulderTilt = 0;
  rimTarget = new THREE.Color(GOOD);
  updateGauge(null);
  renderZonesList(false);
  setIdleCard();
}

function setScanningCard() {
  el.statusCard.classList.remove("bad");
  el.statusTag.classList.remove("bad");
  el.statusTag.textContent = "Escaneando";
  el.statusIcon.innerHTML = ICON_SCAN;
  el.statusIcon.setAttribute("stroke", "#22d3ee");
  el.statusLabel.textContent = "Analizando tu postura…";
  el.statusDesc.textContent = "Quedate en una posición natural durante unos segundos.";
}

// arma el "mini diagnóstico": junta las zonas afectadas (sin repetir el
// mismo consejo de riesgo dos veces) en un párrafo breve.
function buildDiagnosis(zones) {
  const seenRisk = new Set();
  const risks = [];
  zones.forEach((z) => {
    const info = ZONE_INFO[z];
    if (!seenRisk.has(info.risk)) {
      seenRisk.add(info.risk);
      risks.push(info.risk);
    }
  });
  return risks.join(" ");
}

function buildLabel(zones) {
  if (zones.length === 0) return "¡Postura correcta!";
  const labels = zones.map((z) => ZONE_INFO[z].label);
  if (labels.length === 1) return `${labels[0]} afectado`;
  return `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]} afectados`;
}

function applyScanResult(result) {
  lastResult = result;

  if (!result.success) {
    const lowConfidence = result.reason === "low-confidence";
    el.statusCard.classList.add("bad");
    el.statusTag.classList.add("bad");
    el.statusTag.textContent = lowConfidence ? "No pudimos medir con confianza" : "No se detectó una persona";
    el.statusIcon.innerHTML = ICON_BAD;
    el.statusIcon.setAttribute("stroke", BAD);
    el.statusLabel.textContent = "No pudimos verte bien";
    el.statusDesc.textContent = lowConfidence
      ? "Te detectamos, pero no con suficiente confianza. Probá con ropa más ajustada (sin polerón/capucha suelta), buena luz de frente, y que se vea tu torso completo."
      : "No detectamos a nadie frente a la cámara. Ubicate en el encuadre, con buena luz, y probá de nuevo.";
    ZONE_KEYS.forEach((z) => (zoneTargets[z] = GOOD));
    rimTarget = new THREE.Color(GOOD);
    updateGauge(null);
    renderZonesList(false);
    return;
  }

  const cervicalBad = result.cervicalAngle != null && result.cervicalAngle > THRESHOLDS.cervical;
  const cervicalSevere = result.cervicalAngle != null && result.cervicalAngle > THRESHOLDS.cervical + 10;
  const torsoBad = result.torsoAngle != null && result.torsoAngle > THRESHOLDS.torso;
  const shoulderBad = result.shoulderTiltAngle != null && result.shoulderTiltAngle > THRESHOLDS.shoulder;

  const zones = [];
  if (cervicalBad) zones.push("neck");
  if (cervicalSevere) zones.push("head");
  if (torsoBad) zones.push("upperSpine", "lowerSpine");
  if (shoulderBad) zones.push(result.lowerShoulder);

  const zoneSet = new Set(zones);
  ZONE_KEYS.forEach((z) => {
    zoneTargets[z] = zoneSet.has(z) ? BAD : GOOD;
  });

  const ok = zones.length === 0;
  const issueCount = [cervicalBad, torsoBad, shoulderBad].filter(Boolean).length;
  const severity = severityColor(issueCount, cervicalSevere);
  rimTarget = new THREE.Color(severity);

  poseTarget.neck = angleToPoseRad(result.cervicalAngle, 6, 45);
  poseTarget.torso = angleToPoseRad(result.torsoAngle, 4, 35);
  const shoulderRad = angleToPoseRad(result.shoulderTiltAngle, 2, 20);
  poseTarget.shoulderTilt = result.lowerShoulder === "shoulderR" ? -shoulderRad : shoulderRad;

  el.statusCard.classList.toggle("bad", !ok);
  el.statusCard.style.borderColor = ok ? "" : hexToRgba(severity, 0.4);
  el.statusCard.classList.remove("pl-pulse-once");
  void el.statusCard.offsetWidth; // reinicia la animación aunque sea la misma severidad
  el.statusCard.classList.add("pl-pulse-once");
  el.statusTag.classList.toggle("bad", !ok);
  el.statusTag.style.color = ok ? "" : severity;
  el.statusTag.style.background = ok ? "" : hexToRgba(severity, 0.14);
  el.statusTag.textContent = ok ? "Postura correcta" : "Zona(s) afectada(s) detectada(s)";
  el.statusIcon.innerHTML = ok ? ICON_OK : ICON_BAD;
  el.statusIcon.setAttribute("stroke", ok ? GOOD : severity);
  el.statusLabel.textContent = buildLabel(zones);
  el.statusDesc.textContent = ok
    ? "Tu alineación cervical, de tronco y de hombros están dentro de rangos saludables."
    : buildDiagnosis(zones);

  renderMetric("metric1", {
    name: "Ángulo cervical",
    value: result.cervicalAngle != null ? `${round1(result.cervicalAngle)}°` : "—",
    limit: `${THRESHOLDS.cervical}°`,
    within: !cervicalBad,
  });
  renderMetric("metric2", {
    name: "Inclinación de torso",
    value: result.torsoAngle != null ? `${round1(result.torsoAngle)}°` : "—",
    limit: `${THRESHOLDS.torso}°`,
    within: !torsoBad,
  });
  renderMetric("metric3", {
    name: "Desnivel de hombros",
    value: result.shoulderTiltAngle != null ? `${round1(result.shoulderTiltAngle)}°` : "—",
    limit: `${THRESHOLDS.shoulder}°`,
    within: !shoulderBad,
  });

  updateGauge(result.cervicalAngle, cervicalBad, cervicalSevere);
  renderZonesList(true);

  history = [{ label: buildLabel(zones), color: ok ? GOOD : severity, t: Date.now() }, ...history].slice(0, 4);
  el.historyList.innerHTML = history
    .map(
      (h) =>
        `<div class="pl-history-row"><i class="dot" style="background:${h.color}"></i>${h.label}</div>`
    )
    .join("");

  if (activeZone) openZonePopup(activeZone, lastPopupX, lastPopupY);
}

setIdleCard();
renderZonesList(false);

/* -------------------- orquestación del escaneo -------------------- */

async function startScan() {
  if (uiState === "scanning") return;
  uiState = "scanning";
  paused = false;
  el.scanButton.disabled = true;
  el.scanButton.textContent = "Escaneando…";
  el.cameraError.hidden = true;
  setScanningCard();
  el.scanBadge.hidden = false;
  el.scanPercent.textContent = "0%";

  function recoverToIdle(message) {
    el.cameraError.textContent = message;
    el.cameraError.hidden = false;
    el.scanBadge.hidden = true;
    el.cameraPreview.hidden = true;
    stopCamera(el.cameraPreview);
    uiState = "idle";
    el.scanButton.disabled = false;
    el.scanButton.textContent = "Iniciar escaneo";
    setIdleCard();
  }

  try {
    await startCamera(el.cameraPreview);
  } catch (err) {
    console.error("No se pudo acceder a la cámara:", err);
    recoverToIdle("No pudimos acceder a tu cámara. Revisá los permisos del navegador e intentá de nuevo.");
    return;
  }

  el.cameraPreview.hidden = false;

  let result;
  try {
    result = await runScan(el.cameraPreview, SCAN_MS, (progress) => {
      el.scanPercent.textContent = `${Math.round(progress * 100)}%`;
      el.progressBar.style.width = `${progress * 100}%`;
    });
  } catch (err) {
    console.error("Error durante el escaneo:", err);
    recoverToIdle(
      "No pudimos completar el escaneo (falló la carga del modelo de detección). Revisá tu conexión e intentá de nuevo."
    );
    return;
  }

  stopCamera(el.cameraPreview);
  el.cameraPreview.hidden = true;
  el.scanBadge.hidden = true;

  applyScanResult(result);

  uiState = "result";
  holdElapsed = 0;
  el.scanButton.disabled = false;
  el.scanButton.textContent = "Volver a escanear";
}

el.scanButton.addEventListener("click", startScan);

function tickHold(dtMs) {
  if (uiState !== "result" || paused) return;
  holdElapsed += dtMs;
  el.progressBar.style.width = `${Math.max(0, 100 - (holdElapsed / HOLD_MS) * 100)}%`;
  if (holdElapsed >= HOLD_MS) {
    uiState = "idle";
    resetToNeutral();
  }
}

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
  const zone = zoneAtEvent(e);
  if (zone) {
    openZonePopup(zone, e.clientX, e.clientY);
  } else {
    closeZonePopup();
  }
});

/* ------------------------------ escena ------------------------------ */

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
rimLight = new THREE.DirectionalLight(GOOD, 0.9);
rimLight.position.set(-1.5, 2, -3.5);
scene.add(rimLight);

const grid = new THREE.GridHelper(9, 18, 0x3b82f6, 0x151c2c);
grid.position.y = -0.02;
scene.add(grid);

const root = new THREE.Group();
scene.add(root);

/* ------------------------ aro de escaneo (3D) ------------------------ */
// aro real que rodea el cuerpo y sube/baja durante el escaneo — en vez de
// una barra plana en CSS, esto vive en la escena 3D así que la perspectiva
// y la profundidad (queda "detrás" del brazo cuando corresponde) son reales.
const scanRingGeo = new THREE.TorusGeometry(0.3, 0.006, 8, 64);
const scanRingMat = new THREE.MeshBasicMaterial({
  color: 0x22d3ee,
  transparent: true,
  opacity: 0.9,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const scanRing = new THREE.Mesh(scanRingGeo, scanRingMat);
scanRing.rotation.x = Math.PI / 2;
scanRing.visible = false;
root.add(scanRing);

const scanGlowGeo = new THREE.CircleGeometry(0.34, 48);
const scanGlowMat = new THREE.MeshBasicMaterial({
  color: 0x22d3ee,
  transparent: true,
  opacity: 0.1,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const scanGlow = new THREE.Mesh(scanGlowGeo, scanGlowMat);
scanGlow.rotation.x = Math.PI / 2;
scanGlow.visible = false;
root.add(scanGlow);

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

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const LERP = 1 - Math.pow(0.001, dt);

  tickHold(dt * 1000);

  if (!paused) root.rotation.y += dt * 0.5;

  poseCurrent.neck += (poseTarget.neck - poseCurrent.neck) * LERP;
  poseCurrent.torso += (poseTarget.torso - poseCurrent.torso) * LERP;
  poseCurrent.shoulderTilt += (poseTarget.shoulderTilt - poseCurrent.shoulderTilt) * LERP;

  // balanceo sutil (tipo "respiración") mientras se escanea, para que el
  // avatar no se sienta estático durante los 5s — puramente cosmético, no
  // depende de la cámara ni toca el timing de detección.
  const scanSway = uiState === "scanning" ? Math.sin(clock.elapsedTime * 1.8) * 0.025 : 0;
  const scanSwayNeck = uiState === "scanning" ? Math.sin(clock.elapsedTime * 1.8 + 0.4) * 0.015 : 0;

  if (poseNodes.neck) poseNodes.neck.node.rotation.x = poseNodes.neck.rest.x + poseCurrent.neck + scanSwayNeck;
  if (poseNodes.chest) poseNodes.chest.node.rotation.x = poseNodes.chest.rest.x + poseCurrent.torso + scanSway;
  if (poseNodes.shoulderL) poseNodes.shoulderL.node.rotation.z = poseNodes.shoulderL.rest.z + poseCurrent.shoulderTilt;
  if (poseNodes.shoulderR) poseNodes.shoulderR.node.rotation.z = poseNodes.shoulderR.rest.z + poseCurrent.shoulderTilt;

  // aro de escaneo 3D: sube y baja de los pies a la cabeza mientras dura el escaneo
  if (uiState === "scanning") {
    scanRing.visible = true;
    scanGlow.visible = true;
    const sweepT = (Math.sin(clock.elapsedTime * 1.3) + 1) / 2; // 0..1 vaivén
    const y = THREE.MathUtils.lerp(0.05, 1.6, sweepT);
    scanRing.position.y = y;
    scanGlow.position.y = y;
    scanRingMat.opacity = 0.75 + Math.sin(clock.elapsedTime * 6) * 0.15;
  } else {
    scanRing.visible = false;
    scanGlow.visible = false;
  }

  ZONE_KEYS.forEach((z) => {
    const targetHex = zoneTargets[z] || GOOD;
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