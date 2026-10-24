// live2d.ts — the ONLY file coupled to Live2D. Spec: docs/dev.md §2.3.1.
//
// The Cubism Core runtime is proprietary and can only be loaded as a global
// <script>, so PIXI and pixi-live2d-display are loaded the same way from
// `public/live2d/vendor/` instead of npm: no dependency, nothing in the first-load
// bundle, and with `"model": null` (the committed default) nothing but the
// manifest itself is fetched. Every failure resolves to `null` → Avatar stays on
// its Canvas-2D face. `parseManifest` is PURE (tested in src/selfcheck.ts).

export interface Live2DManifest {
  model: string;
  modelPath: string;
  runtime: string[];
  scale: number;
  anchor: [number, number];
  params: { mouthOpen: string; angleX: string };
  motionGroups: { idle: string; tap: string };
}

export const MANIFEST_URL = "/live2d/model.manifest.json";
export const MOUNT_TIMEOUT_MS = 3000;

const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Returns null for "no model" — including a missing/garbled manifest. */
export function parseManifest(raw: unknown): Live2DManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.model !== "string" || !m.model) return null;
  if (typeof m.modelPath !== "string" || !m.modelPath.endsWith(".model3.json")) return null;
  if (!Array.isArray(m.runtime) || !m.runtime.length || !m.runtime.every((s) => typeof s === "string")) return null;
  const p = (m.params ?? {}) as Record<string, unknown>;
  const g = (m.motionGroups ?? {}) as Record<string, unknown>;
  const a = Array.isArray(m.anchor) ? m.anchor : [];
  return {
    model: m.model,
    modelPath: m.modelPath,
    runtime: m.runtime as string[],
    scale: num(m.scale, 1),
    anchor: [num(a[0], 0.5), num(a[1], 0.5)],
    params: { mouthOpen: str(p.mouthOpen, "ParamMouthOpenY"), angleX: str(p.angleX, "ParamAngleX") },
    motionGroups: { idle: str(g.idle, "Idle"), tap: str(g.tap, "TapBody") },
  };
}

export interface Live2DHandle {
  setLevel(v: number): void;
  setListening(on: boolean): void;
  tap(): void;
  destroy(): void;
}

// Minimal structural types for the parts of PIXI / pixi-live2d-display we touch.
interface L2DModel {
  width: number;
  height: number;
  scale: { set(v: number): void };
  anchor: { set(x: number, y: number): void };
  position: { set(x: number, y: number): void };
  motion(group: string): Promise<boolean>;
  focus(x: number, y: number): void;
  internalModel: {
    on(ev: "beforeModelUpdate", cb: () => void): void;
    coreModel: { setParameterValueById?(id: string, v: number): void };
  };
}
interface PixiApp {
  view: HTMLCanvasElement;
  stage: { addChild(m: L2DModel): void };
  destroy(removeView: boolean): void;
}
interface PixiGlobal {
  Application: new (o: Record<string, unknown>) => PixiApp;
  live2d?: { Live2DModel: { from(url: string, o?: Record<string, unknown>): Promise<L2DModel> } };
}

function loadScript(src: string): Promise<void> {
  if (document.querySelector(`script[data-live2d="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false; // runtime order matters: core → pixi → plugin
    s.dataset.live2d = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`live2d runtime failed: ${src}`));
    document.head.appendChild(s);
  });
}

async function mount(host: HTMLElement, size: number, signal: AbortSignal): Promise<Live2DHandle | null> {
  const res = await fetch(MANIFEST_URL, { signal, cache: "no-cache" }).catch(() => null);
  if (!res?.ok) return null;
  const manifest = parseManifest(await res.json().catch(() => null));
  if (!manifest) return null;

  for (const src of manifest.runtime) await loadScript(src);
  const PIXI = (window as unknown as { PIXI?: PixiGlobal }).PIXI;
  if (!PIXI?.live2d) return null;

  const app = new PIXI.Application({
    width: size,
    height: size,
    backgroundAlpha: 0,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  try {
    const model = await PIXI.live2d.Live2DModel.from(manifest.modelPath, { autoInteract: false });
    if (signal.aborted) throw new Error("timeout");
    model.scale.set(Math.min(size / model.width, size / model.height) * manifest.scale);
    model.anchor.set(manifest.anchor[0], manifest.anchor[1]);
    model.position.set(size / 2, size / 2);
    app.stage.addChild(model);
    let level = 0;
    model.internalModel.on("beforeModelUpdate", () =>
      model.internalModel.coreModel.setParameterValueById?.(manifest.params.mouthOpen, level)
    );
    void model.motion(manifest.motionGroups.idle).catch(() => false);
    host.appendChild(app.view);
    return {
      setLevel: (v) => {
        level = Math.max(0, Math.min(1, v));
      },
      setListening: (on) => {
        if (on) model.focus(size / 2, size * 0.45);
      },
      tap: () => void model.motion(manifest.motionGroups.tap).catch(() => false),
      destroy: () => app.destroy(true),
    };
  } catch (e) {
    app.destroy(true);
    throw e;
  }
}

/** L1 of the three-level fallback. Resolves null on ANY failure or after 3s. */
export function mountLive2D(host: HTMLElement, size: number): Promise<Live2DHandle | null> {
  const ctrl = new AbortController();
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, MOUNT_TIMEOUT_MS)
  );
  const loaded = mount(host, size, ctrl.signal).catch(() => null);
  // A model that finishes after the timeout must not stay mounted behind L2.
  void loaded.then((h) => {
    if (h && ctrl.signal.aborted) h.destroy();
  });
  return Promise.race([loaded, timeout]);
}
