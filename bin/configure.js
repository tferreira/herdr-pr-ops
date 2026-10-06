#!/usr/bin/env node
"use strict";

// configure.js --apply    bind the board to a key in Herdr's config.toml
// configure.js --remove   take that binding out again
//
// Runs as the install build step, so people do not have to edit config.toml
// by hand. The binding lives in a marked block; nothing outside it is
// touched. It uses prefix+d, or prefix+alt+d when prefix+d is taken, and
// does nothing when the board is already bound somewhere. The result is
// validated with `herdr config check` and rolled back if Herdr rejects it.
// Never fails: an install must not abort over a key binding.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ACTION = "tferreira.herdr-pr-ops.open";
const BEGIN = "# >>> herdr-pr-ops key binding (managed: remove with the plugin's remove-keybinding action)";
const END = "# <<< herdr-pr-ops key binding";
const HERDR = process.env.HERDR_BIN_PATH || "herdr";

function configPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg || path.join(os.homedir(), ".config"), "herdr", "config.toml");
}

function stripBlock(text) {
  const re = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END}\\n?`, "g");
  return text.replace(re, "\n").replace(/\n{3,}$/, "\n\n");
}

function herdr(args) {
  return spawnSync(HERDR, args, { encoding: "utf8", timeout: 15000 });
}

function apply() {
  const file = configPath();
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const rest = stripBlock(before);
  if (rest.includes(ACTION)) return say("the board already has a key binding; leaving config.toml alone");
  const taken = (k) => new RegExp(`key\\s*=\\s*"${k.replace(/\+/g, "\\+")}"`).test(rest);
  const key = ["prefix+d", "prefix+alt+d"].find((k) => !taken(k));
  if (!key) return say("prefix+d and prefix+alt+d are both taken; bind tferreira.herdr-pr-ops.open yourself (see README)");
  const block = [BEGIN, "[[keys.command]]", `key = "${key}"`, 'type = "plugin_action"', `command = "${ACTION}"`, 'description = "PR//OPS"', END].join("\n");
  const next = `${rest.replace(/\s*$/, "")}${rest.trim() ? "\n\n" : ""}${block}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  const check = herdr(["config", "check"]);
  if (check.status !== 0 && !check.error) {
    fs.writeFileSync(file, before);
    return say(`herdr config check rejected the binding, rolled back: ${(check.stdout + check.stderr).trim().split("\n")[0]}`);
  }
  herdr(["server", "reload-config"]);
  say(`bound the board to ${key} in ${file}`);
}

function remove() {
  const file = configPath();
  if (!fs.existsSync(file)) return say("no config.toml");
  const before = fs.readFileSync(file, "utf8");
  const after = stripBlock(before);
  if (after === before) return say("no managed key binding to remove");
  fs.writeFileSync(file, after);
  herdr(["server", "reload-config"]);
  say("removed the key binding");
}

function say(msg) {
  process.stdout.write(`herdr-pr-ops: ${msg}\n`);
}

try {
  if (process.argv.includes("--remove")) remove();
  else apply();
} catch (e) {
  say(`key binding skipped: ${e.message}`);
}
process.exit(0);
