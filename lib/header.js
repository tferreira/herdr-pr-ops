"use strict";

// The animated header band: a block-letter logo over a twinkling starfield.
//   intro    letters decode from noise left to right, stars fade in
//   ambient  stars twinkle; a light band sweeps the logo every 6-9 s; a
//            shooting star crosses the band every 15-25 s, behind any text.
// Built as a cell grid (stars, then shooting star, then text on top) and
// serialized into styled runs.

const { S, mix } = require("./term");

const LOGO = [
  "█▀█ █▀█  ╱╱ █▀█ █▀█ █▀▀",
  "█▀▀ █▀▄ ╱╱  █▄█ █▀▀ ▄▄█",
];
const LOGO_W = [...LOGO[0]].length;
const ROWS = 4; // star row, two logo rows, star row
const LOGO_X = 2;
const LOGO_Y = 1;
const INTRO_MS = 650;
const NOISE = "▓▒░█▚▞";
const STAR_TINTS = ["#ffffff", "#bff6ff", "#d9c8ff", "#ffd1f4"];
const LOGO_CYCLE = ["#00e5ff", "#8b5cff", "#ff2ed1", "#00e5ff"];

const rand = (a, b) => a + Math.random() * (b - a);

function cycleColor(t) {
  const u = ((t % 1) + 1) % 1;
  const seg = u * (LOGO_CYCLE.length - 1);
  const i = Math.floor(seg);
  return mix(LOGO_CYCLE[i], LOGO_CYCLE[i + 1], seg - i);
}

class Header {
  constructor(boot, bg) {
    this.boot = boot;
    this.bg = bg;
    this.width = 0;
    this.stars = [];
    this.shoot = null;
    this.nextShoot = boot + rand(4000, 8000); // the first one comes early
    this.shimmerAt = boot + INTRO_MS + 400;
    this.nextShimmer = this.shimmerAt;
  }

  seed(W) {
    this.width = W;
    this.stars = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < W; x++) {
        if (Math.random() < 0.055) {
          this.stars.push({
            x,
            y,
            phase: rand(0, Math.PI * 2),
            speed: rand(0.5, 1.8),
            max: rand(0.35, 1),
            tint: STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)],
          });
        }
      }
    }
  }

  // text: [{ row, x, runs: [[text, style]] }] drawn on top; x < 0 aligns the
  // end of the runs to W + x.
  render(W, now, text) {
    if (W !== this.width) this.seed(W);
    const bg = this.bg;
    const grid = Array.from({ length: ROWS }, () => Array.from({ length: W }, () => ({ ch: " ", fg: null })));
    const occupied = Array.from({ length: ROWS }, () => new Uint8Array(W));
    const put = (y, x, ch, st) => {
      if (y >= 0 && y < ROWS && x >= 0 && x < W) grid[y][x] = { ch, ...st };
    };

    // Text and logo claim their cells (plus a margin) before the sky is drawn.
    const placed = text.map((t) => {
      const len = t.runs.reduce((n, [s]) => n + [...s].length, 0);
      const x = t.x < 0 ? W + t.x - len : t.x;
      for (let i = x - 1; i <= x + len; i++) if (i >= 0 && i < W) occupied[t.row][i] = 1;
      return { ...t, x };
    });
    for (let y = LOGO_Y; y < LOGO_Y + LOGO.length; y++) {
      for (let x = LOGO_X - 1; x <= LOGO_X + LOGO_W; x++) if (x >= 0 && x < W) occupied[y][x] = 1;
    }

    // Stars.
    const fadeIn = Math.min(1, (now - this.boot) / 900);
    const t = now / 1000;
    for (const s of this.stars) {
      if (occupied[s.y][s.x]) continue;
      const wave = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
      const b = s.max * wave * wave * fadeIn;
      if (b < 0.06) continue;
      const ch = b > 0.8 ? "✦" : b > 0.45 ? "⋆" : "·";
      put(s.y, s.x, ch, { fg: mix(bg, s.tint, 0.2 + 0.8 * b), bold: b > 0.8 });
    }

    // Shooting star: enters top-left, drifts down across the band.
    const shimmering = now >= this.shimmerAt && now < this.shimmerAt + 900;
    if (!this.shoot && now >= this.nextShoot && now - this.boot > INTRO_MS) {
      if (shimmering) this.nextShoot = this.shimmerAt + 1200;
      else this.shoot = { start: now, speed: rand(70, 110), y0: rand(-0.3, 0.6), drop: rand(1.8, 2.8) };
    }
    if (this.shoot) {
      const sh = this.shoot;
      const hx = ((now - sh.start) / 1000) * sh.speed - 2;
      const slope = sh.drop / W;
      if (hx - 16 > W) {
        this.shoot = null;
        this.nextShoot = now + rand(15000, 25000);
      } else {
        for (let i = 16; i >= 0; i--) {
          const x = Math.round(hx - i);
          const y = Math.round(sh.y0 + (hx - i) * slope);
          if (y < 0 || y >= ROWS || x < 0 || x >= W || occupied[y][x]) continue;
          if (i === 0) put(y, x, "✦", { fg: "#ffffff", bold: true });
          else {
            const ch = i < 4 ? "━" : i < 9 ? "─" : i < 13 ? "╌" : "·";
            put(y, x, ch, { fg: mix(i < 5 ? "#ffffff" : "#7af3ff", bg, Math.min(0.92, i / 17)) });
          }
        }
      }
    }

    // Logo: decode intro, then a drifting gradient with a periodic shimmer.
    const sinceBoot = now - this.boot;
    if (!this.shoot && now >= this.nextShimmer) {
      this.shimmerAt = now;
      this.nextShimmer = now + rand(6000, 9000);
    }
    const sp = (now - this.shimmerAt) / 900;
    const band = sp >= 0 && sp <= 1 ? -4 + (LOGO_W + 8) * sp : null;
    LOGO.forEach((row, ry) => {
      [...row].forEach((ch, lx) => {
        if (ch === " ") return;
        const x = LOGO_X + lx;
        const y = LOGO_Y + ry;
        if (sinceBoot < INTRO_MS && lx > (sinceBoot / INTRO_MS) * LOGO_W) {
          put(y, x, NOISE[Math.floor(Math.random() * NOISE.length)], { fg: mix("#00e5ff", bg, 0.55) });
          return;
        }
        let fg = cycleColor(lx / LOGO_W / 1.6 + now / 14000);
        if (band !== null) {
          const d = Math.abs(lx - band + ry * 0.8); // a slight slant
          if (d < 3.5) fg = mix(fg, "#ffffff", (1 - d / 3.5) * 0.9);
        }
        put(y, x, ch, { fg, bold: true });
      });
    });

    // Text pieces.
    for (const p of placed) {
      let x = p.x;
      for (const [s, st] of p.runs) {
        for (const ch of s) put(p.row, x++, ch, st);
      }
    }

    // Serialize into runs.
    return grid.map((cells) => {
      let out = "";
      let key = null;
      let buf = "";
      for (const c of cells) {
        const k = `${c.fg}|${c.bold ? 1 : 0}|${c.italic ? 1 : 0}`;
        if (k !== key) {
          if (buf) out += buf;
          buf = S("", { fg: c.fg || bg, bg, bold: c.bold, italic: c.italic });
          key = k;
        }
        buf += c.ch;
      }
      return out + buf;
    });
  }
}

Header.ROWS = ROWS;
Header.LOGO_END = LOGO_X + LOGO_W;
module.exports = { Header };
