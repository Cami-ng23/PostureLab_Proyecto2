/* ------------------------------------------------------------------ */
/*  PostureLab · Detección de postura en vivo con MediaPipe Tasks      */
/*  Vision (PoseLandmarker). Se apoya en los "world landmarks" (3D,    */
/*  en metros, relativos al centro de las caderas) en vez de en        */
/*  coordenadas de pantalla, así que no importa si la persona está     */
/*  de frente, de lado o en ángulo: medimos ángulos entre segmentos    */
/*  del propio cuerpo, no contra ejes de la imagen.                    */
/* ------------------------------------------------------------------ */

import {
  FilesetResolver,
  PoseLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// índices de landmarks que usamos (de los 33 que entrega el modelo)
const IDX = {
  NOSE: 0,
  L_EAR: 7,
  R_EAR: 8,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_HIP: 23,
  R_HIP: 24,
};

const VISIBILITY_MIN = 0.5;

// ángulo (en grados) entre la vertical real y el segmento lower->upper,
// usando la magnitud del desplazamiento horizontal en el plano XZ
// completo. Así, si la persona está de lado, el "hacia adelante" cae en Z
// en vez de en X, pero el ángulo resultante es el mismo — no dependemos
// de saber hacia dónde mira la cámara.
function angleFromVertical(lower, upper) {
  const dx = upper.x - lower.x;
  const dz = upper.z - lower.z;
  const dy = lower.y - upper.y; // "arriba" = y más chico (misma convención que landmarks normalizados)
  const horiz = Math.hypot(dx, dz);
  const vert = Math.max(dy, 0.0001);
  return (Math.atan2(horiz, vert) * 180) / Math.PI;
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A partir de un frame (landmarks normalizados + world landmarks) calcula
// la muestra de ángulos, o null si la persona no está suficientemente
// visible en ese frame (frame descartado, no rompe el escaneo).
function sampleFromFrame(landmarks, world) {
  const sh = landmarks[IDX.L_SHOULDER];
  const shR = landmarks[IDX.R_SHOULDER];
  const hip = landmarks[IDX.L_HIP];
  const hipR = landmarks[IDX.R_HIP];
  const visOk = (lm) => lm && (lm.visibility ?? 1) >= VISIBILITY_MIN;
  if (!visOk(sh) || !visOk(shR) || !visOk(hip) || !visOk(hipR)) return null;

  const lEarVisible = visOk(landmarks[IDX.L_EAR]);
  const rEarVisible = visOk(landmarks[IDX.R_EAR]);
  let headPoint;
  if (lEarVisible && rEarVisible) headPoint = midpoint(world[IDX.L_EAR], world[IDX.R_EAR]);
  else if (lEarVisible) headPoint = world[IDX.L_EAR];
  else if (rEarVisible) headPoint = world[IDX.R_EAR];
  else if (visOk(landmarks[IDX.NOSE])) headPoint = world[IDX.NOSE];
  else return null;

  const shoulderMid = midpoint(world[IDX.L_SHOULDER], world[IDX.R_SHOULDER]);
  const hipMid = midpoint(world[IDX.L_HIP], world[IDX.R_HIP]);

  const neckAngle = angleFromVertical(shoulderMid, headPoint);
  const torsoAngle = angleFromVertical(hipMid, shoulderMid);
  const shoulderDiffCm = Math.abs(world[IDX.L_SHOULDER].y - world[IDX.R_SHOULDER].y) * 100;
  // lado "más bajo" (afectado) entre los dos hombros
  const lowSide = world[IDX.L_SHOULDER].y > world[IDX.R_SHOULDER].y ? "L" : "R";

  return { neckAngle, torsoAngle, shoulderDiffCm, lowSide };
}

const NECK_LIMIT = 20; // °
const NECK_SEVERE = 30; // ° — a partir de acá también se marca "head"
const TORSO_LIMIT = 15; // °
const SHOULDER_LIMIT_CM = 1.5; // cm

function buildDiagnosisFromSamples(samples) {
  if (samples.length < 6) {
    return {
      insufficient: true,
      message:
        "No logramos verte con claridad durante el escaneo. Asegúrate de estar dentro del encuadre, con buena luz, e inténtalo de nuevo.",
    };
  }

  const neck = median(samples.map((s) => s.neckAngle));
  const torso = median(samples.map((s) => s.torsoAngle));
  const shoulderCm = median(samples.map((s) => s.shoulderDiffCm));
  const lowSideCount = { L: 0, R: 0 };
  samples.forEach((s) => lowSideCount[s.lowSide]++);
  const lowSide = lowSideCount.R >= lowSideCount.L ? "R" : "L";

  const neckBad = neck > NECK_LIMIT;
  const neckSevere = neck > NECK_SEVERE;
  const torsoBad = torso > TORSO_LIMIT;
  const shoulderBad = shoulderCm > SHOULDER_LIMIT_CM;

  const zones = [];
  if (neckBad) zones.push("neck");
  if (neckSevere) zones.push("head");
  if (torsoBad) zones.push("upperSpine", "lowerSpine");
  if (shoulderBad) zones.push(lowSide === "R" ? "shoulderR" : "shoulderL");

  const ok = zones.length === 0;

  const issues = [];
  if (neckBad) issues.push(`el cuello se proyecta ${neckSevere ? "muy " : ""}hacia adelante (${neck.toFixed(0)}°, límite ${NECK_LIMIT}°)`);
  if (torsoBad) issues.push(`el torso se inclina de más (${torso.toFixed(0)}°, límite ${TORSO_LIMIT}°)`);
  if (shoulderBad) issues.push(`hay un desnivel entre los hombros (${shoulderCm.toFixed(1)} cm, límite ${SHOULDER_LIMIT_CM} cm)`);

  const label = ok
    ? "Postura correcta"
    : zones.length > 1
    ? "Postura con varias zonas afectadas"
    : neckBad
    ? "Cuello proyectado hacia adelante"
    : torsoBad
    ? "Inclinación excesiva del torso"
    : "Hombro descompensado";

  const desc = ok
    ? "Tu alineación cervical, de torso y de hombros está dentro de rangos saludables."
    : `Mini diagnóstico: ${issues.join("; ")}.`;

  const poseNeck = neckBad ? Math.min(0.7, neck / 55) : Math.min(0.12, neck / 200);
  const poseTorso = torsoBad ? Math.min(0.4, torso / 55) : Math.min(0.08, torso / 200);
  const shoulderSign = lowSide === "R" ? -1 : 1;
  const poseShoulderTilt = shoulderBad ? shoulderSign * Math.min(0.32, shoulderCm / 10) : 0;

  return {
    insufficient: false,
    ok,
    zones,
    label,
    desc,
    metric: { name: "Ángulo cervical", value: `${neck.toFixed(0)}°`, limit: `${NECK_LIMIT}°`, within: !neckBad },
    metric2: { name: "Inclinación de torso", value: `${torso.toFixed(0)}°`, limit: `${TORSO_LIMIT}°`, within: !torsoBad },
    metric3: { name: "Desnivel de hombros", value: `${shoulderCm.toFixed(1)} cm`, limit: `${SHOULDER_LIMIT_CM} cm`, within: !shoulderBad },
    pose: { neck: poseNeck, torso: poseTorso, shoulderTilt: poseShoulderTilt },
  };
}

export class PoseWatcher {
  constructor() {
    this.landmarker = null;
    this.stream = null;
    this.video = null;
    this.rafId = null;
    this.samples = [];
    this.running = false;
  }

  async _ensureLandmarker() {
    if (this.landmarker) return;
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    this.landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    }).catch(async () => {
      // fallback a CPU si no hay soporte de GPU en el navegador
      return PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    });
  }

  // pide cámara, carga el modelo (si hace falta) y arranca el loop de
  // detección. Lanza si el usuario niega el permiso o no hay cámara.
  async start(videoEl) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    videoEl.srcObject = this.stream;
    await videoEl.play();
    this.video = videoEl;

    await this._ensureLandmarker();

    this.samples = [];
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      if (this.video.readyState >= 2) {
        const result = this.landmarker.detectForVideo(this.video, performance.now());
        if (result.landmarks && result.landmarks[0] && result.worldLandmarks && result.worldLandmarks[0]) {
          const sample = sampleFromFrame(result.landmarks[0], result.worldLandmarks[0]);
          if (sample) this.samples.push(sample);
        }
      }
      this.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  buildDiagnosis() {
    return buildDiagnosisFromSamples(this.samples);
  }
}
