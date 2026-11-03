import type { CSSProperties } from "react";

export interface AnsiSegment { text: string; style?: CSSProperties }

// Tuned for the dark log panel: the standard colors are too dim on it.
const PALETTE = ["#5c6370", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#e879f9", "#22d3ee", "#d4d4d8", "#7f8796", "#fca5a5", "#86efac", "#fde047", "#93c5fd", "#f0abfc", "#67e8f9", "#fafafa"];
const SGR = /\u001b\[([0-9;]*)m/g;

function cube(index: number): string {
  if (index < 16) return PALETTE[index]!;
  if (index >= 232) { const level = 8 + (index - 232) * 10; return `rgb(${level},${level},${level})`; }
  const value = index - 16, step = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return `rgb(${step(Math.floor(value / 36))},${step(Math.floor(value / 6) % 6)},${step(value % 6)})`;
}

/** Applies one SGR sequence, including the 256-color and truecolor forms. */
function apply(style: CSSProperties, codes: number[]): CSSProperties {
  let next = { ...style };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]!;
    if (code === 0) next = {};
    else if (code === 1) next.fontWeight = 600;
    else if (code === 2) next.opacity = 0.7;
    else if (code === 3) next.fontStyle = "italic";
    else if (code === 4) next.textDecoration = "underline";
    else if (code === 22) { delete next.fontWeight; delete next.opacity; }
    else if (code === 23) delete next.fontStyle;
    else if (code === 24) delete next.textDecoration;
    else if (code >= 30 && code <= 37) next.color = PALETTE[code - 30];
    else if (code >= 90 && code <= 97) next.color = PALETTE[code - 82];
    else if (code === 39) delete next.color;
    else if (code >= 40 && code <= 47) next.backgroundColor = PALETTE[code - 40];
    else if (code >= 100 && code <= 107) next.backgroundColor = PALETTE[code - 92];
    else if (code === 49) delete next.backgroundColor;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? "color" : "backgroundColor";
      if (codes[index + 1] === 5) { next[key] = cube(codes[index + 2] ?? 0); index += 2; }
      else if (codes[index + 1] === 2) { next[key] = `rgb(${codes[index + 2] ?? 0},${codes[index + 3] ?? 0},${codes[index + 4] ?? 0})`; index += 4; }
    }
  }
  return next;
}

export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let style: CSSProperties = {}, last = 0;
  for (const match of text.matchAll(SGR)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), style });
    style = apply(style, (match[1] || "0").split(";").map(Number));
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), style });
  return segments;
}
