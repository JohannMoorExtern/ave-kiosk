// Lädt main.js ohne Electron in eine abgeschottete Umgebung, damit die reinen Rechenfunktionen
// (PR-String, Optionen, Spot-Sichtbarkeit …) getestet werden können, ohne main.js zu verändern.
// Electron wird durch Attrappen ersetzt; app.whenReady() kehrt nie zurück, es startet also nichts.
// Ergebnis: holen('prFuer') liefert eine Funktion oder Variable aus main.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

function electronAttrappe() {
  const nichts = () => {};
  const fenster = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  return {
    app: {
      requestSingleInstanceLock: () => true,
      commandLine: { appendSwitch: nichts },
      whenReady: () => new Promise(nichts),   // nie: keine Fenster, keine Intervalle
      on: nichts, quit: nichts, exit: nichts,
    },
    BrowserWindow: function () {},
    screen: { getAllDisplays: () => [fenster], getPrimaryDisplay: () => fenster, getCursorScreenPoint: () => ({ x: 0, y: 0 }), on: nichts },
    globalShortcut: { register: () => true, unregisterAll: nichts },
    powerMonitor: { getSystemIdleTime: () => 0 },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => '' },
  };
}

function ladeMain() {
  const log = [];
  const echtesRequire = require;
  const kontext = {
    require: (name) => (name === 'electron' ? electronAttrappe() : echtesRequire(name)),
    __dirname: FIXTURES,                 // config.json und katalog.json aus tests/fixtures
    __filename: path.join(FIXTURES, 'main.js'),
    process: { ...process, argv: ['electron', 'main.js'], exit: () => {} },
    console: { log: (...a) => log.push(a.join(' ')), info: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    fetch: async () => { throw new Error('kein Netz im Test'); },
    AbortSignal, URL, Buffer, TextDecoder, TextEncoder,
  };
  vm.createContext(kontext);
  const code = fs.readFileSync(path.join(WURZEL, 'main.js'), 'utf8');
  vm.runInContext(code, kontext, { filename: 'main.js' });
  // const/let der obersten Ebene sind für spätere Skripte im selben Kontext sichtbar
  const holen = (name) => vm.runInContext(name, kontext);
  return { holen, kontext, log };
}

module.exports = { ladeMain, WURZEL, FIXTURES };
