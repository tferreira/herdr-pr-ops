"use strict";

// Agent marks, matching herdr-radar so the dashboard and the sidebar speak
// the same language: vendor logo + lifecycle mark, braille spinner while
// working, a `?` that pulses with the ring while blocked.
//
// "font" uses the Private Use Area icons from herdr-radar's icon font (merged
// into the terminal font); "text" falls back to plain Unicode for terminals
// without it. Set `glyphs` in config.json.

const fs = require("node:fs");
const path = require("node:path");
const { config, HOME } = require("./util");

// "auto": herdr-radar ships the icon font, so use it when radar is installed.
let radar = null;
function radarInstalled() {
  if (radar === null) {
    const base = path.join(HOME, ".config/herdr/plugins");
    try {
      radar =
        fs.existsSync(path.join(base, "config", "hhdebb.herdr-radar")) ||
        fs.readdirSync(path.join(base, "github")).some((d) => d.startsWith("hhdebb.herdr-radar"));
    } catch {
      radar = false;
    }
  }
  return radar;
}

const FONT = {
  logo: {
    claude: "",
    codex: "",
    opencode: "",
    cursor: "",
    copilot: "",
    gemini: "",
    qwen: "",
    amp: "",
  },
  done: "",
  blocked: "",
  ring: "",
  unknown: "",
};

const TEXT = { logo: {}, done: "✓", blocked: "?", ring: "○", unknown: "◌" };

const BRAND = { claude: "#d97757", gemini: "#4285f4", codex: "#10a37f", cursor: "#9aa4b8", copilot: "#8b949e" };

const FRAMES = ["⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽", "⣾"];
const PULSE_STEPS = 5;

// The board opened for a remote screen overrides the glyph mode.
let override = null;
function setGlyphMode(mode) {
  override = mode;
}

function glyphs() {
  const g = override || config().glyphs;
  if (g === "text") return TEXT;
  if (g === "font") return FONT;
  return radarInstalled() ? FONT : TEXT;
}

// Parts for one agent: { logo, logoColor, mark, markColor, label }.
// `step` advances about every 120 ms.
function agentMark(agent, step, colors) {
  const g = glyphs();
  const kind = agent.agent || "agent";
  const logo = g.logo[kind] || kind.slice(0, 1).toUpperCase();
  const logoColor = BRAND[kind] || colors.violet;
  switch (agent.agent_status) {
    case "working":
      return { logo, logoColor, mark: FRAMES[step % FRAMES.length], markColor: logoColor, label: "working" };
    case "blocked": {
      const quiet = Math.floor(step / PULSE_STEPS) % 2 === 1;
      return { logo, logoColor, mark: quiet ? g.ring : g.blocked, markColor: colors.red, label: "needs you" };
    }
    case "done":
      return { logo, logoColor, mark: g.done, markColor: colors.green, label: "done" };
    case "idle":
      return { logo, logoColor, mark: g.ring, markColor: colors.mute, label: "idle" };
    default:
      return { logo, logoColor, mark: g.unknown, markColor: colors.dim, label: "?" };
  }
}

module.exports = { agentMark, glyphs, setGlyphMode, FRAMES };
