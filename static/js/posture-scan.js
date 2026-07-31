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
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

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
    landmarkerPromise = FilesetResolver.forVisionTasks(WASM_BASE).then((fileset) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numPoses: 1,
      })
    );
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
  // esperar a que el video tenga dimensiones reales antes de detectar
  if (!videoEl.videoWidth) {
    await new Promise((resolve) => {
      videoEl.addEventListener("loadedmetadata", resolve, { once: true });
    });
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

  // cabeza: preferimos la nariz; si no es confiable, promedio de orejas
  let head = null;
  const nose = lm[IDX.nose];
  const earL = lm[IDX.earL];
  const earR = lm[IDX.earR];
  if (nose && nose.visibility > 0.4) head = nose;
  else if (earL && earR && earL.visibility > 0.35 && earR.visibility > 0.35) head = mid(earL, earR);

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
            if (a.torsoAngle != null) samples.torso.push(a.torsoAngle);
            if (a.cervicalAngle != null) samples.cervical.push(a.cervicalAngle);
            if (a.shoulderTiltAngle != null) {
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

  const validFrames = samples.torso.length + samples.cervical.length;
  if (framesSeen < 5 || validFrames === 0) {
    return { success: false, reason: "no-person" };
  }

  const lowerShoulder =
    shoulderVotes.shoulderL >= shoulderVotes.shoulderR ? "shoulderL" : "shoulderR";

  return {
    success: true,
    torsoAngle: median(samples.torso),
    cervicalAngle: median(samples.cervical),
    shoulderTiltAngle: median(samples.shoulderTilt),
    lowerShoulder,
    framesSeen,
  };
}