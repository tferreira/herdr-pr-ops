"use strict";

// The animated header band: a block-letter logo over a twinkling starfield.
//   intro    letters decode from noise left to right, stars fade in
//   ambient  stars twinkle; a light band sweeps the logo every 6-9 s; a
//            shooting star crosses the band every 15-25 s, behind any text.
//   launch   on a deploy only: a 🚀 sparkles in after the tagline, ignites,
//            and flies a wobbly path off the right edge in white smoke.
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
// Launch timing (seconds) and flight: speeds up over RAMP to CRUISE columns/s.
const IGNITION = 0.8;
const RAMP = 0.8;
const CRUISE = 34;
const FLAME = 0.12; // seconds a trail cell burns before it turns to smoke
const SMOKE = 1.3; // then seconds of smoke
const SPARKLE = 0.3; // the rocket sparkles in before ignition
const FIRE = ["#fff3a0", "#ffb020", "#ff4d2e"];
const RAMP_D = (CRUISE * RAMP) / 2; // columns flown by the end of the ramp
const flown = (s) => (s < RAMP ? (CRUISE / RAMP) * s * s * 0.5 : RAMP_D + CRUISE * (s - RAMP));
const passedAt = (dd) => (dd < RAMP_D ? Math.sqrt((2 * dd * RAMP) / CRUISE) : RAMP + (dd - RAMP_D) / CRUISE);

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
    this.launchAt = null;
  }

  // Start the rocket's launch; ignored while one is already playing.
  launch(now) {
    if (this.launchAt == null) {
      this.launchAt = now;
      this.wobble = rand(0, Math.PI * 2); // each flight takes its own path
    }
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
  // end of the runs to W + x. rocket: { x, row } is where a launch starts.
  render(W, now, text, rocket) {
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

    // The launch pad, while a launch plays; none when the right-hand text
    // reaches it.
    let pad = null;
    if (this.launchAt != null) {
      const fits = rocket && rocket.x + 1 < W && !occupied[rocket.row][rocket.x] && !occupied[rocket.row][rocket.x + 1];
      if (!fits || now - this.launchAt > 20000) this.launchAt = null;
      else if (now >= this.launchAt) pad = rocket;
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
    if (!this.shoot && this.launchAt == null && now >= this.nextShoot && now - this.boot > INTRO_MS) {
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

    if (pad) this.drawRocket(pad, W, now, put, occupied);

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

// A launch: the rocket sparkles in on the pad, ignition and pad smoke, then a
// wobbly flight whose trail cells age from the moment the rocket passed them
// (a flicker of flame, then white smoke that greys, thins and spreads).
Header.prototype.drawRocket = function (pad, W, now, put, occupied) {
  const bg = this.bg;
  const free = (y, x) => y >= 0 && y < ROWS && x >= 0 && x < W && !occupied[y][x];
  const rocketAt = (y, x) => {
    if (free(y, x) && free(y, x + 1)) {
      put(y, x, "🚀", {});
      put(y, x + 1, "", {});
    }
  };
  const tail = pad.row + 1;
  const L = (now - this.launchAt) / 1000 - SPARKLE;

  if (L < 0) {
    const b = -L / SPARKLE;
    if (free(pad.row, pad.x)) put(pad.row, pad.x, b > 0.5 ? "⋆" : "✦", { fg: mix(bg, "#ffffff", 1 - 0.6 * b), bold: true });
    return;
  }

  // Pad smoke: billows out through ignition and liftoff, then fades.
  const padAge = L / (IGNITION + 1.2);
  if (padAge < 1) {
    const r = 1 + Math.min(L, IGNITION + 0.6) * 2;
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      const x = pad.x + dx;
      const a = (1 - Math.abs(dx) / (r + 1)) * (1 - padAge) * (0.6 + 0.4 * Math.random());
      if (a > 0.15 && free(tail, x)) put(tail, x, a > 0.6 ? "▒" : "░", { fg: mix(bg, "#e8eef7", a) });
    }
  }

  if (L < IGNITION) {
    if (free(tail, pad.x - 1)) put(tail, pad.x - 1, "░▒▓"[Math.floor(Math.random() * 3)], { fg: FIRE[Math.floor(Math.random() * 3)] });
    return rocketAt(pad.row, pad.x);
  }

  // Flight path: two sines (one slow swoop, one quicker wiggle that grows in
  // after liftoff) rounded to rows, starting upward from the pad.
  const ph = this.wobble || 0;
  const rowAt = (dd) => {
    const y = pad.row - 0.8 * Math.sin(dd / 3.4) - 0.4 * Math.sin(dd / 1.5 + ph) * Math.min(1, dd / 5);
    return Math.max(0, Math.min(ROWS - 1, Math.round(y)));
  };
  const hash = (n) => (Math.imul(n + 1, 2654435761) ^ Math.floor(ph * 1e6)) >>> 0;
  const s = L - IGNITION;
  const d = flown(s);
  const span = W - pad.x;
  for (let dd = 0; dd < Math.min(d, span); dd++) {
    const age = s - passedAt(dd);
    if (age > FLAME + SMOKE) continue;
    const y = rowAt(dd);
    const x = pad.x + dd;
    if (age < FLAME) {
      if (free(y, x)) put(y, x, "▒░"[Math.floor(Math.random() * 2)], { fg: FIRE[Math.floor(Math.random() * 2)] });
      continue;
    }
    const k = (age - FLAME) / SMOKE;
    const col = mix(mix("#ffffff", "#9aa3b5", k), bg, k * 0.85);
    if (free(y, x)) put(y, x, k < 0.15 ? "▒" : k < 0.55 ? "░" : "·", { fg: col });
    // Older puffs spread into a neighbouring row.
    const h = hash(dd);
    if (k > 0.2 && k < 0.7 && h % 5 === 0) {
      const ny = y + (h & 4 ? 1 : -1);
      if (free(ny, x)) put(ny, x, k < 0.5 ? "░" : "·", { fg: mix(col, bg, 0.3) });
    }
  }
  if (d < span) return rocketAt(rowAt(d), pad.x + Math.floor(d));

  // Gone: done once the smoke has cleared.
  if (s >= passedAt(span) + FLAME + SMOKE) this.launchAt = null;
};

Header.ROWS = ROWS;
Header.LOGO_END = LOGO_X + LOGO_W;
module.exports = { Header };
