// "Last read" snapshots, shared by VS Code and the web reader so reading a doc in
// either place counts as read in both. Stored per user in ~/.md-highlighter/.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = path.join(os.homedir(), '.md-highlighter');

function file(doc) {
  const key = crypto.createHash('sha1').update(path.resolve(doc).toLowerCase()).digest('hex');
  return path.join(HOME, 'baselines', key + '.json');
}

function load(doc) {
  try { return JSON.parse(fs.readFileSync(file(doc), 'utf8')); } catch { return null; }
}

function save(doc, text) {
  const f = file(doc);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ time: new Date().toISOString(), text: text ?? fs.readFileSync(doc, 'utf8') }));
}

/** Small per-user state (scroll positions, reader preferences). */
function state() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')); } catch { return {}; }
}
function setState(patch) {
  const s = Object.assign(state(), patch);
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify(s));
  return s;
}

module.exports = { HOME, load, save, state, setState };
