"use client";

import { useEffect, useRef, useState } from "react";
import { mountLive2D, type Live2DHandle } from "@/lib/live2d";
import type { AssistantState } from "@/lib/types";

// The digital human, with three fallback levels (docs/dev.md §2.3.1 ⑤):
//   L1 Live2D  — only when public/live2d/model.manifest.json names a model AND it
//                loads within 3s (lib/live2d.ts, the only Live2D-coupled file);
//   L2 Canvas  — the default: blink, breath, mouth height = `level`;
//   L3 static  — when even a 2D canvas context is unavailable.
// All three live inside ONE <button>, so tap (= say it again) and long-press
// (= listen) work at every level, for touch, keyboard and screen readers alike.

export type AvatarMode = "live2d" | "canvas" | "static";

interface AvatarProps {
  state: AssistantState;
  level?: number; // 0..1 lip-sync amplitude
  size?: number; // css px, square
  /** Spoken by screen readers: current state + what tapping does. */
  label: string;
  onTap?: () => void;
  onLongPress?: () => void;
  /** Reports the level actually rendered (for `track("avatar_*")`). */
  onMode?: (mode: AvatarMode) => void;
}

const LONG_PRESS_MS = 1000;

export function Avatar({ state, level = 0, size = 320, label, onTap, onLongPress, onMode }: AvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const live2dRef = useRef<Live2DHandle | null>(null);
  const [mode, setMode] = useState<AvatarMode>("canvas");
  const stateRef = useRef(state);
  const levelRef = useRef(level);
  stateRef.current = state;
  levelRef.current = level;
  const onModeRef = useRef(onMode);
  onModeRef.current = onMode;

  // L1 attempt. With the committed `"model": null` this is one tiny fetch.
  useEffect(() => {
    let alive = true;
    const host = hostRef.current;
    if (!host) return;
    void mountLive2D(host, size).then((h) => {
      if (!alive) return h?.destroy();
      if (!h) return;
      live2dRef.current = h;
      setMode("live2d");
      onModeRef.current?.("live2d");
    });
    return () => {
      alive = false;
      live2dRef.current?.destroy();
      live2dRef.current = null;
    };
  }, [size]);

  useEffect(() => {
    live2dRef.current?.setLevel(state === "speaking" ? level : 0);
    live2dRef.current?.setListening(state === "listening");
  }, [state, level]);

  // L2 render loop; stops as soon as L1 takes over (the canvas unmounts).
  useEffect(() => {
    if (mode !== "canvas") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setMode("static");
      onModeRef.current?.("static");
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      draw(ctx, size, (now - t0) / 1000, stateRef.current, levelRef.current, reduced);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [size, mode]);

  // Tap vs long-press on one element. Keyboard Enter/Space arrives as a click
  // without pointer events, so it always counts as a tap.
  const pressTimer = useRef<number | null>(null);
  const longFired = useRef(false);
  const clearPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const face = (
    <>
      <span ref={hostRef} aria-hidden="true" className={mode === "live2d" ? "absolute inset-0" : "hidden"} />
      {mode === "canvas" ? <canvas ref={canvasRef} aria-hidden="true" style={{ width: size, height: size }} /> : null}
      {mode === "static" ? (
        <span aria-hidden="true" className="flex h-full w-full items-center justify-center rounded-full bg-[#F6D5B0] text-[8rem]">
          😊
        </span>
      ) : null}
    </>
  );
  const box = { width: size, height: size };

  // Decorative use (e.g. inside the SOS screen): not a focus stop.
  if (!onTap && !onLongPress) {
    return (
      <span role="img" aria-label={label} style={box} className="relative block">
        {face}
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={() => {
        longFired.current = false;
        clearPress();
        pressTimer.current = window.setTimeout(() => {
          longFired.current = true;
          pressTimer.current = null;
          onLongPress?.();
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clearPress}
      onPointerLeave={clearPress}
      onPointerCancel={clearPress}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (longFired.current) {
          longFired.current = false;
          return;
        }
        live2dRef.current?.tap();
        onTap?.();
      }}
      style={{ ...box, WebkitTouchCallout: "none" }}
      className="relative select-none rounded-full"
    >
      {face}
    </button>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  size: number,
  t: number,
  state: AssistantState,
  level: number,
  reduced: boolean
) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.33;
  // Displacement (breath, lean, idle tilt) is motion; reduced-motion turns it off.
  // Blinking and the mouth are communication, so they stay on in every mode.
  const breath = reduced ? 1 : 1 + Math.sin(t * 1.2) * 0.012;
  const lean = !reduced && state === "listening" ? 1.03 : 1;
  const phase = t % 10; // one gentle head tilt every ~10s while idle
  const tilt = !reduced && state === "idle" && phase < 1 ? Math.sin(phase * Math.PI) * 0.04 : 0;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);
  ctx.scale(breath * lean, breath * lean);
  ctx.translate(-cx, -cy);

  // face
  ctx.fillStyle = "#F6D5B0";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // warm cheeks
  ctx.fillStyle = "rgba(242,161,123,0.55)";
  for (const dx of [-r * 0.55, r * 0.55]) {
    ctx.beginPath();
    ctx.ellipse(cx + dx, cy + r * 0.28, r * 0.18, r * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // eyes (blink every ~4s)
  const blink = t % 4 < 0.15 ? 0.12 : 1;
  const eyeDx = r * 0.42;
  const eyeCy = cy - r * 0.18;
  for (const dx of [-eyeDx, eyeDx]) {
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.ellipse(cx + dx, eyeCy, r * 0.17, r * 0.2 * blink, 0, 0, Math.PI * 2);
    ctx.fill();
    // pupils look toward the screen centre (the senior) while listening
    const look = state === "listening" ? -Math.sign(dx) * r * 0.03 : 0;
    ctx.fillStyle = "#4A2C1A";
    ctx.beginPath();
    ctx.ellipse(cx + dx + look, eyeCy + r * 0.02 * blink, r * 0.08, r * 0.1 * blink, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // glasses
  ctx.strokeStyle = "#7A4A2B";
  ctx.lineWidth = Math.max(2, r * 0.05);
  for (const dx of [-eyeDx, eyeDx]) {
    ctx.beginPath();
    ctx.arc(cx + dx, eyeCy, r * 0.24, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - eyeDx + r * 0.24, eyeCy);
  ctx.lineTo(cx + eyeDx - r * 0.24, eyeCy);
  ctx.stroke();

  // mouth: lip-sync when speaking, gentle smile otherwise
  const mouthCy = cy + r * 0.42;
  if (state === "speaking") {
    const h = r * (0.05 + Math.min(1, level) * 0.32);
    ctx.fillStyle = "#8C4A2F";
    ctx.beginPath();
    ctx.ellipse(cx, mouthCy, r * 0.22, h, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = "#8C4A2F";
    ctx.lineWidth = Math.max(2, r * 0.05);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, mouthCy - r * 0.15, r * 0.3, 0.25 * Math.PI, 0.75 * Math.PI);
    ctx.stroke();
  }
  ctx.restore();
}
