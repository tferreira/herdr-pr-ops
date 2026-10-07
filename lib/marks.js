"use strict";

// Agent marks: vendor logo + lifecycle mark, braille spinner while working,
// a `?` that pulses with the ring while blocked.
//
// "nerd" (default) uses Nerd Font icons; the Claude and OpenAI logos need
// Nerd Fonts 3.5 or later. "text" is plain Unicode for terminals without a
// Nerd Font. Set `icons` in config.json.

const { config } = require("./util");

const NERD = {
  logo: {
    claude: "\uec82",
    codex: "\uec81",
    copilot: "\uf4b8",
  },
  done: "\uf42e",
  blocked: "\uf420",
  ring: "\uf4aa",
  unknown: "\uf4c3",
  pr: "\uf407",
  draft: "\uf4dd",
  merged: "\uf419",
  deploy: "\uf427",
};

const TEXT = { logo: {}, done: "✓", blocked: "?", ring: "○", unknown: "◌", pr: "●", draft: "◌", merged: "●", deploy: "⇡" };

const BRAND = { claude: "#d97757", gemini: "#4285f4", codex: "#10a37f", cursor: "#9aa4b8", copilot: "#8b949e" };

const FRAMES = ["⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽", "⣾"];
const PULSE_STEPS = 5;

// Before 0.5.0 the setting was `glyphs`; its "text" still counts.
function icons() {
  const cfg = config();
  return (cfg.icons || (cfg.glyphs === "text" ? "text" : "nerd")) === "text" ? TEXT : NERD;
}

// Parts for one agent: { logo, logoColor, mark, markColor, label }.
// `step` advances about every 120 ms.
function agentMark(agent, step, colors) {
  const g = icons();
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

module.exports = { agentMark, icons, BRAND, FRAMES };
