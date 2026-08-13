/* ------------------------------------------------------------------ */
/*  PostureLab · Escaneo real de postura con cámara (MediaPipe Pose)   */
/*                                                                      */
/*  Estrategia de ángulos: en vez de medir ángulos absolutos respecto   */
/*  a la pantalla (que cambiarían según el ángulo de la cámara), medimos*/
/*  ángulos RELATIVOS entre segmentos del propio cuerpo (cuello vs.     */
/*  columna, columna vs. su propia vertical adaptativa, hombro vs.      */
/*  hombro). Así el resultado es el mismo si la persona está de frente, */
/*  de lado, o del otro lado.                                           */
/* ------------------------------------------------------------------ */

import { FilesetResolver, PoseLandmarker } from "./vendor/mediapipe/vision_bundle.mjs";

const WASM_BASE = "/static/js/vendor/mediapipe/wasm";
// "full" en vez de "lite": bastante más preciso detectando la pose bajo ropa
// suelta (polerones, chaquetas), a cambio de un poco más de peso/carga inicial.
// Como el escaneo no necesita tiempo real (solo 5s, unos pocos frames por
// segundo alcanzan), vale la pena el trade-off de precisión.
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

// índices de MediaPipe Pose (33 puntos)
const IDX = {
  nose: 0,
  earL: 7,
  earR: 8,
  shoulderL: 11,
  shoulderR: 12,
  hipL: 23,
  hipR: 24,
};

let landmarkerPromise = null;

function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = Promise.race([
      FilesetResolver.forVisionTasks(WASM_BASE).then((fileset) =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.3,
          minPosePresenceConfidence: 0.3,
          minTrackingConfidence: 0.3,
        })
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout-model-load")), 20000)),
    ]).catch((err) => {
      landmarkerPromise = null; // permite reintentar en el próximo escaneo
      throw err;
    });
  }
  return landmarkerPromise;
}

/* ------------------------------- cámara ------------------------------- */

let currentStream = null;

export async function startCamera(videoEl) {
  currentStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  videoEl.srcObject = currentStream;
  await videoEl.play();
  // esperar a que el video tenga dimensiones reales antes de detectar,
  // con un tope de 8s por si el navegador tarda en entregar el primer frame
  if (!videoEl.videoWidth) {
    await Promise.race([
      new Promise((resolve) => videoEl.addEventListener("loadedmetadata", resolve, { once: true })),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout-video-metadata")), 8000)),
    ]);
  }
}

export function stopCamera(videoEl) {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
  if (videoEl) videoEl.srcObject = null;
}

/* --------------------------- matemática de ángulos --------------------------- */

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}
function len(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function angleBetween(a, b) {
  const l = len(a) * len(b);
  if (l < 1e-6) return null;
  const c = Math.max(-1, Math.min(1, dot(a, b) / l));
  return (Math.acos(c) * 180) / Math.PI;
}

// analiza un solo frame de landmarks 3D (world landmarks). Devuelve null si
// no hay suficiente confianza para medir ese frame.
function analyzeFrame(lm) {
  const sL = lm[IDX.shoulderL];
  const sR = lm[IDX.shoulderR];
  const hL = lm[IDX.hipL];
  const hR = lm[IDX.hipR];
  if (!sL || !sR || !hL || !hR) return null;
  const minVis = Math.min(sL.visibility, sR.visibility, hL.visibility, hR.visibility);
  if (minVis < 0.35) return null;

  const midShoulder = mid(sL, sR);
  const midHip = mid(hL, hR);
  const spineVec = sub(midShoulder, midHip);
  if (len(spineVec) < 1e-6) return null;

  // vertical adaptativa: no asumimos convención de ejes de MediaPipe, solo
  // que la columna apunta aproximadamente "hacia arriba" en su propio marco.
  const verticalRef = { x: 0, y: spineVec.y >= 0 ? 1 : -1, z: 0 };

  const torsoAngle = angleBetween(spineVec, verticalRef);

  // cabeza: de frente suele verse mejor la nariz; de lado, una sola oreja
  // (la más cercana a cámara) es más estable que promediar las dos, porque
  // de perfil la oreja lejana casi no tiene visibilidad y antes eso hacía
  // fallar la medición del cuello justo en el ángulo más diagnóstico.
  const nose = lm[IDX.nose];
  const earL = lm[IDX.earL];
  const earR = lm[IDX.earR];
  const headCandidates = [nose, earL, earR].filter((p) => p && p.visibility > 0.35);
  const head = headCandidates.length
    ? headCandidates.reduce((best, p) => (p.visibility > best.visibility ? p : best))
    : null;

  let cervicalAngle = null;
  if (head) {
    const neckVec = sub(head, midShoulder);
    cervicalAngle = angleBetween(neckVec, spineVec);
  }

  const shoulderVec = sub(sR, sL);
  let shoulderTiltAngle = null;
  let lowerShoulder = null;
  const sLen = len(shoulderVec);
  if (sLen > 1e-6) {
    const vComp = dot(shoulderVec, verticalRef);
    const ratio = Math.max(-1, Math.min(1, Math.abs(vComp) / sLen));
    shoulderTiltAngle = (Math.asin(ratio) * 180) / Math.PI;
    // vComp > 0 => hombro derecho más "arriba" según verticalRef => el izquierdo es el más bajo
    lowerShoulder = vComp > 0 ? "shoulderL" : "shoulderR";
  }

  return { torsoAngle, cervicalAngle, shoulderTiltAngle, lowerShoulder };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid_ = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid_] : (s[mid_ - 1] + s[mid_]) / 2;
}

function stddev(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
  return Math.sqrt(v);
}

// Mediana "confiable": si hubo pocas muestras válidas, o si el valor saltó
// demasiado de un frame a otro (poca consistencia temporal), NO devolvemos
// un número — es preferible decir "no medido" a marcar una zona como
// afectada con un dato ruidoso. Esto es lo que más pasa con el hombro visto
// de perfil (la profundidad se estima peor de lado que de frente).
function reliableMedian(arr, minSamples, maxStd) {
  if (arr.length < minSamples) return null;
  if (stddev(arr) > maxStd) return null;
  return median(arr);
}

/* --------------------------------- escaneo --------------------------------- */

// corre el escaneo por `durationMs`, llama onProgress(0..1) seguido,
// y devuelve las métricas finales (medianas) + de qué lado quedó el hombro bajo
export async function runScan(videoEl, durationMs, onProgress) {
  const landmarker = await getLandmarker();
  const samples = { torso: [], cervical: [], shoulderTilt: [] };
  const shoulderVotes = { shoulderL: 0, shoulderR: 0 };
  let framesSeen = 0;

  const start = performance.now();

  await new Promise((resolve) => {
    function step() {
      const now = performance.now();
      const elapsed = now - start;
      if (onProgress) onProgress(Math.min(1, elapsed / durationMs));

      if (videoEl.readyState >= 2) {
        const result = landmarker.detectForVideo(videoEl, now);
        const lm = result && result.worldLandmarks && result.worldLandmarks[0];
        if (lm) {
          framesSeen++;
          const a = analyzeFrame(lm);
          if (a) {
            // descartamos glitches de un frame: ningún humano dobla el
            // cuello/torso más de ~85° sentado frente a una cámara
            if (a.torsoAngle != null && a.torsoAngle < 85) samples.torso.push(a.torsoAngle);
            if (a.cervicalAngle != null && a.cervicalAngle < 85) samples.cervical.push(a.cervicalAngle);
            if (a.shoulderTiltAngle != null && a.shoulderTiltAngle < 60) {
              samples.shoulderTilt.push(a.shoulderTiltAngle);
              shoulderVotes[a.lowerShoulder]++;
            }
          }
        }
      }

      if (elapsed < durationMs) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(step);
  });

  const torsoAngle = reliableMedian(samples.torso, 15, 10);
  const cervicalAngle = reliableMedian(samples.cervical, 15, 10);
  const shoulderTiltAngle = reliableMedian(samples.shoulderTilt, 15, 8);

  if (framesSeen === 0) {
    return { success: false, reason: "no-person" };
  }
  if (torsoAngle == null && cervicalAngle == null) {
    return { success: false, reason: "low-confidence" };
  }

  const lowerShoulder =
    shoulderVotes.shoulderL >= shoulderVotes.shoulderR ? "shoulderL" : "shoulderR";

  return {
    success: true,
    torsoAngle,
    cervicalAngle,
    shoulderTiltAngle,
    lowerShoulder,
    framesSeen,
  };
}