/**
 * Browser-side face detection + recognition using face-api.js.
 * Models are served from /models (see public/models/).
 *
 * Returns 128-d face descriptors that downstream server-side clustering
 * matches via euclidean distance (typical same-person threshold ≤ 0.55).
 */
import * as faceapi from "face-api.js";

const MODELS_URL = "/models";
const FACE_SIZE = 48;

let modelsPromise: Promise<void> | null = null;

export async function loadFaceModels(): Promise<void> {
  if (!modelsPromise) {
    modelsPromise = Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL),
    ]).then(() => undefined);
  }
  await modelsPromise;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

function extractAlignedFace(
  sourceImg: HTMLImageElement,
  detection: { landmarks: faceapi.FaceLandmarks68; detection: faceapi.FaceDetection },
): string {
  const { landmarks, detection: det } = detection;
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();

  const leftCenter = leftEye.reduce(
    (a, p) => ({ x: a.x + p.x / leftEye.length, y: a.y + p.y / leftEye.length }),
    { x: 0, y: 0 },
  );
  const rightCenter = rightEye.reduce(
    (a, p) => ({ x: a.x + p.x / rightEye.length, y: a.y + p.y / rightEye.length }),
    { x: 0, y: 0 },
  );

  const angle = Math.atan2(rightCenter.y - leftCenter.y, rightCenter.x - leftCenter.x);

  const box = det.box;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const faceSize = Math.max(box.width, box.height) * 1.3;

  const canvas = document.createElement("canvas");
  canvas.width = FACE_SIZE;
  canvas.height = FACE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  ctx.save();
  ctx.translate(FACE_SIZE / 2, FACE_SIZE / 2);
  ctx.rotate(-angle);
  ctx.drawImage(
    sourceImg,
    cx - faceSize / 2,
    cy - faceSize / 2,
    faceSize,
    faceSize,
    -FACE_SIZE / 2,
    -FACE_SIZE / 2,
    FACE_SIZE,
    FACE_SIZE,
  );
  ctx.restore();
  return canvas.toDataURL("image/png");
}

export interface DetectedFace {
  dataUrl: string;
  descriptor: number[];
  score: number;
  box: { x: number; y: number; width: number; height: number };
}

export interface DetectionResult {
  imageWidth: number;
  imageHeight: number;
  faces: DetectedFace[];
}

/**
 * Detect all faces in an image URL.
 */
export async function detectFaces(imageUrl: string): Promise<DetectionResult> {
  await loadFaceModels();
  const img = await loadImage(imageUrl);

  const detections = await faceapi
    .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  const faces: DetectedFace[] = detections.map((det) => ({
    dataUrl: extractAlignedFace(img, det),
    descriptor: Array.from(det.descriptor),
    score: det.detection.score,
    box: {
      x: det.detection.box.x,
      y: det.detection.box.y,
      width: det.detection.box.width,
      height: det.detection.box.height,
    },
  }));

  return { imageWidth: img.naturalWidth, imageHeight: img.naturalHeight, faces };
}

/** Similarity score in [0, 1]; ≥ 0.6 typically means same person. */
export function compareFaces(d1: number[], d2: number[]): number {
  let sum = 0;
  const n = Math.min(d1.length, d2.length);
  for (let i = 0; i < n; i++) {
    const d = d1[i] - d2[i];
    sum += d * d;
  }
  return Math.max(0, 1 - Math.sqrt(sum));
}