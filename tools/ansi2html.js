#!/usr/bin/env node
"use strict";

// ansi2html.js <frame.ans> [title]  ->  HTML of a terminal window around the
// frame, for README screenshots. Understands the truecolor SGR codes the
// dashboard emits.

const fs = require("node:fs");

const [file, title = "herdr — PR//OPS"] = process.argv.slice(2);
const src = fs.readFileSync(file, "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let fg = null;
let bg = null;
let bold = false;
let dim = false;
let italic = false;
let html = "";
for (const tok of src.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
  const m = tok.match(/^\x1b\[([0-9;?]*)([A-Za-z])$/);
  if (m) {
    if (m[2] !== "m") continue;
    const p = m[1].split(";").map((x) => Number(x || 0));
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) [fg, bg, bold, dim, italic] = [null, null, false, false, false];
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 3) italic = true;
      else if ((c === 38 || c === 48) && p[i + 1] === 2) {
        const col = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
        if (c === 38) fg = col;
        else bg = col;
        i += 4;
      }
    }
    continue;
  }
  if (!tok) continue;
  const st = [];
  if (fg) st.push(`color:${fg}`);
  if (bg) st.push(`background:${bg}`);
  if (bold) st.push("font-weight:bold");
  if (dim) st.push("opacity:.6");
  if (italic) st.push("font-style:italic");
  html += `<span style="${st.join(";")}">${esc(tok)}</span>`;
}

process.stdout.write(`<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: #05070d; }
  .stage { box-sizing: border-box; min-height: 100%; display: flex; align-items: center; justify-content: center;
           padding: 32px 40px; background: radial-gradient(ellipse at 30% 0%, #1b1440 0%, #0a0d1a 55%, #05070d 100%); }
  .win { border-radius: 12px; overflow: hidden; background: #070b14; width: max-content;
         box-shadow: 0 0 0 1px #24304d, 0 30px 80px rgba(0,0,0,.65), 0 0 120px rgba(0,229,255,.10); }
  .bar { height: 30px; background: linear-gradient(#141b2d, #0e1424); display: flex; align-items: center;
         padding: 0 12px; gap: 8px; border-bottom: 1px solid #1a2440; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .t { flex: 1; text-align: center; color: #7385ab; font: 12px -apple-system, "Helvetica Neue", sans-serif; margin-right: 56px; }
  pre { margin: 0; padding: 10px 12px 12px; font-family: "MesloLGM Nerd Herdr", "MesloLGM Nerd Font", Menlo, monospace;
        font-size: 13px; line-height: normal; color: #c6d3ef; }
</style></head><body><div class="stage"><div class="win">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">${esc(title)}</span></div>
  <pre>${html}</pre>
</div></div></body></html>`);
