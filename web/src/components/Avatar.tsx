"use client";

import { useEffect, useRef } from "react";
import type { AssistantState } from "@/lib/types";

// ponytail: Canvas-2D stand-in for Live2D. The ONLY contract a real model needs is
// these two props — `state` (what the assistant is doing) and `level` (0..1 mouth
// openness / lip-sync amplitude). Swap-in point: replace the draw() body with
// `pixi-live2d-display` (PIXI.Application + model.motion/expression + a ParamMouthOpenY
// driven by `level`). Everything upstream (audio, VAD, hooks) stays unchanged.

interface AvatarProps {
  state: AssistantState;
  level?: number; // 0..1 lip-sync amplitude
  size?: number; // css px, square
  className?: string;
}

const LABELS: Record<AssistantState, string> = {
  idle: "灵犀助手（空闲）",
  listening: "灵犀正在聆听",
  thinking: "灵犀正在思考",
  speaking: "灵犀正在说话",
  confirming: "灵犀正在确认",
};

export function Avatar({ state, level = 0, size = 320, className }: AvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  const levelRef = useRef(level);
  stateRef.current = state;
  levelRef.current = level;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      const t = reduced ? 0 : (now - t0) / 1000;
      draw(ctx, size, t, stateRef.current, levelRef.current, reduced);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={LABELS[state]}
      style={{ width: size, height: size }}
      className={className}
    />
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
  const breath = 1 + Math.sin(t * 1.2) * 0.012;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(breath, breath);
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
    ctx.fillStyle = "#4A2C1A";
    ctx.beginPath();
    ctx.ellipse(cx + dx, eyeCy + r * 0.02 * blink, r * 0.08, r * 0.1 * blink, 0, 0, Math.PI * 2);
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
  void reduced;
}