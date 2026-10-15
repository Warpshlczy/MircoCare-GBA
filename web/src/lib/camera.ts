// camera.ts — rear camera via getUserMedia. No dependency, no native plugin.
// ponytail: browser-only path. A native shell can swap in a better camera plugin
// behind the same two functions; the web path is the fallback. Callers MUST handle
// rejection (permission denied / no camera) — that is part of correctness.

export interface CameraHandle {
  stop: () => void;
}

/** Opens the rear camera into `video`. Throws if unavailable/denied. */
export async function openCamera(video: HTMLVideoElement): Promise<CameraHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return {
    stop: () => {
      stream.getTracks().forEach((tr) => tr.stop());
      video.srcObject = null;
    },
  };
}

/** Grabs the current frame as a downscaled JPEG data URL (kept small for the card). */
export function captureFrame(video: HTMLVideoElement, maxW = 720): string {
  const w = video.videoWidth || maxW;
  const h = video.videoHeight || maxW;
  const scale = Math.min(1, maxW / w);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}