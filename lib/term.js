"use strict";

// Minimal truecolor + width helpers. Every styled run starts from a reset and
// re-applies the current background, so lines can be cut and padded without
// leaking colors.

const ESC = "\x1b[";

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toHex = ([r, g, b]) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function mix(a, b, t) {
  const A = hex(a);
  const B = hex(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}

const fgc = (h) => {
  const [r, g, b] = hex(h);
  return `${ESC}38;2;${r};${g};${b}m`;
};
const bgc = (h) => {
  const [r, g, b] = hex(h);
  return `${ESC}48;2;${r};${g};${b}m`;
};

// Style a run of text: S("text", { fg, bg, bold, dim, italic, underline }).
function S(text, o = {}) {
  let s = `${ESC}0m`;
  if (o.bg) s += bgc(o.bg);
  if (o.fg) s += fgc(o.fg);
  if (o.bold) s += `${ESC}1m`;
  if (o.dim) s += `${ESC}2m`;
  if (o.italic) s += `${ESC}3m`;
  if (o.underline) s += `${ESC}4m`;
  return s + text;
}

function gradient(text, from, to, o = {}) {
  const chars = [...text];
  const n = Math.max(1, chars.length - 1);
  return chars.map((c, i) => S(c, { ...o, fg: mix(from, to, i / n) })).join("");
}

function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/y;

function width(str) {
  let w = 0;
  for (let i = 0; i < str.length; ) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(str);
    if (m) {
      i += m[0].length;
      continue;
    }
    const cp = str.codePointAt(i);
    w += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return w;
}

// Cut or pad a styled string to exactly `w` columns. Padding uses `padStyle`.
function fit(str, w, padStyle = "", ellipsis = false) {
  let out = "";
  let used = 0;
  const limit = ellipsis && width(str) > w ? w - 1 : w;
  for (let i = 0; i < str.length; ) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(str);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = str.codePointAt(i);
    const cw = charWidth(cp);
    if (used + cw > limit) {
      if (ellipsis) {
        out += "…";
        used += 1;
      }
      break;
    }
    out += String.fromCodePoint(cp);
    used += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  if (used < w) out += padStyle + " ".repeat(w - used);
  return out;
}

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

module.exports = { S, gradient, mix, width, fit, plain, fgc, bgc, ESC };
