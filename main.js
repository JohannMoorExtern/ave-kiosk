// AVE Kiosk v2
// Walzen als rahmenlose Fenster über der lokal laufenden AVE (UE5): links Fahrzeuge,
// rechts Farben und Felgen. Fahrzeuge kommen aus fahrzeuge.json, Farben/Felgen aus
// katalog.json (per tools/dcc-katalog.js aus dem DCC gezogen). Geladen wird per
// AVESelectCar an http://localhost:4242/events. Im Betrieb kein Netz.

const { app, BrowserWindow, screen, globalShortcut, powerMonitor, desktopCapturer, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

// ---------- Config & Log ----------
const baseDir = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(baseDir, 'config.json'), 'utf8'));
if (process.argv.includes('--kiosk')) cfg.kiosk = true;
const logFile = path.join(baseDir, 'kiosk.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  fs.appendFile(logFile, line + '\n', () => {});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!app.requestSingleInstanceLock()) process.exit(0);
app.commandLine.appendSwitch('disable-pinch');
app.commandLine.appendSwitch('overscroll-history-navigation', '0');

const ave = Object.assign({
  url: 'http://localhost:4242/events',
  startSession: true,
  clientId: 'Kiosk',
  timeoutMs: 10000,        // AVEStartSession
  ladeTimeoutMs: 90000,    // AVESelectCar: die AVE antwortet erst, wenn sie fertig ist
  nachlaufMs: 500,         // nach der Antwort noch kurz gesperrt lassen
  loadingScreen: 'Auto',
  modelRevision: 'MP1',
  consumptionData: [],
}, cfg.ave || {});
const leiste = Object.assign({ seite: 'links', breite: 0.2, transparent: true, fokussierbar: false }, cfg.leiste || {});
const rechts = Object.assign({ farben: 0.07, felgen: 0.07 }, cfg.rechts || {});   // Breite der Walzen rechts
const unten = Object.assign({ breite: 0.5, hoehe: 150 }, cfg.unten || {});           // Umgebungswalze unten mittig
// Türen/Kofferraum: AVETriggerAnimations. Schließen = gleiche Animation rückwärts.
// Touch → Maus: Die AVE dreht mit der Maus sauber, mit Touch springt sie auf feste Kameras.
// Eine unsichtbare Fläche (touch.html) fängt Touch ab, tools/maus.ps1 erzeugt echte Mausereignisse.
const touchCfg = Object.assign({
  aktiv: true,
  modus: 'relativ',               // 'relativ' wie eine echte Maus, oder 'absolut' (Zeiger folgt dem Finger)
  faktor: 1,                      // Drehgeschwindigkeit (nur relativ)
  zoom: true, zoomSchrittPx: 40, zoomUmkehren: false,
  schwellePx: 6,                  // ab so viel Bewegung ist es Ziehen statt Tippen
  durchlaessigWaehrendZiehen: true,
  // Pause zwischen "Zeiger hinsetzen" und "Taste drücken". Ohne sie sieht die AVE beides im selben Bild
  // und wertet den Zeigersprung als Ziehen – die Kamera springt. Bei schweren Modellen (weniger Bilder
  // pro Sekunde) passiert das öfter. Etwa 2–3 Bilder.
  druckPauseMs: 60,
  // Automatische Mauserkennung: macht die Fläche nach Mausbewegung kurz durchlässig. Standardmäßig aus –
  // am Gerät löste sie ohne Maus aus (die AVE setzt den Zeiger selbst um), und Touch sprang dann wieder.
  // Mit Maus arbeiten: Strg+Alt+Shift+M schaltet die Touch-Fläche aus und an.
  mausErkennung: false,
  mausPauseMs: 3000,              // so lange bleibt die Fläche nach echter Mausbewegung durchlässig
  helfer: null,                   // nur zum Testen: { "befehl": "...", "argumente": [ ... ] }
}, cfg.touchAlsMaus || {});
const LICHT_STANDARD = {
  kamera: 'CAM_EXT_360_000',   // vorher anfliegen: Front (Vorgabe aus dem EventInterface; null = Ansicht lassen)
  zurueckKamera: 'ConfigureExterior1_mss3d_fix_env',   // danach zurück: die frei drehbare Kamera
  bewegung: 'flysmooth',       // movementMode der AVE: "set" (springen), "flysmooth" (fliegen), "fade" (überblenden)
  flugSek: 1.8969359024571,    // transitionDuration (wie im EventInterface)
  kameraWartenMs: 2000,        // nach dem Kamerawechsel warten, bevor das Licht startet
  nachlaufMs: 2500,            // Ergebnis kurz stehen lassen
  leaving: [
    { anim: 'COMINGHOME', dir: 'reverse', skip: true },
    { anim: 'LeavingHome', dir: 'reverse', skip: true },
    { anim: 'LeavingHome', dir: 'forward' },
  ],
  coming: [
    { anim: 'COMINGHOME', dir: 'reverse', skip: true },
    { anim: 'LeavingHome', dir: 'forward', skip: true },   // Licht an, damit Coming Home etwas ausschalten kann
    { anim: 'COMINGHOME', dir: 'forward' },
  ],
  danach: [],                  // zusätzliche Schritte nach der Show (die Lichter stellt der Kiosk selbst zurück)
};
const aktionen = Object.assign({ tueren: ['Doors'], kofferraum: ['TRUNK'], vor: 'forward', zurueck: 'reverse',
  dauerMs: 4000,   // so lange läuft die Animation: alles gesperrt (die AVE antwortet sofort, nicht am Ende)
  fahrszene: 'DrivingScene_Dubai',   // AVEDrivingSceneStart; "" oder null blendet das Lenkrad aus
  fahrszene2: 'DrivingScene_XianZen', // zweite Fahrszene (Knopf „Play 2“); leer = Knopf ausgeblendet. Namen: Strg+Alt+Shift+I → AVEListDrivingScenes
  knoepfe: ['leaving', 'fahren'],   // 'coming' funktioniert nicht zuverlässig – deshalb ohne Knopf   // Symbole oben: 'tueren', 'kofferraum', 'leaving', 'coming', 'fahren'
  // Lichtshow Leaving Home / Coming Home: Kamera anfahren, Schritte nacheinander, danach zurücksetzen.
  // Schritt: { "anim": "LeavingHome", "dir": "forward"|"reverse", "skip": true = sofort ohne Abspielen }
  //       oder { "warten": 1000 }. Ohne skip wird so lange gewartet, wie die AVE die Animation meldet.
  licht: LICHT_STANDARD,
  breite: null, hoehe: 90 }, cfg.aktionen || {});   // breite null: passend zur Zahl der Symbole
if (cfg.aktionen && cfg.aktionen.licht) aktionen.licht = Object.assign({}, LICHT_STANDARD, cfg.aktionen.licht);
// Interaktions-Spots: die AVE meldet per AVEGetAnimationSpots, wo Türen/Klappe gerade im Bild liegen
// (x/y 0…1). Der Kiosk zeichnet die Punkte selbst auf die Touch-Fläche; Tipp → AVETriggerAnimations.
const spots = Object.assign({
  aktiv: true,
  intervallMs: 400,               // so oft die Positionen abfragen (Kamera bewegt sich auch von selbst)
  groessePx: 26,                  // Durchmesser des Punkts
  trefferPx: 36,                  // Tipp zählt bis zu diesem Abstand vom Mittelpunkt (größer als der Punkt – Finger)
  deckkraft: 0.55,                // 0…1
  verdecken: true,                // Punkte auf der abgewandten Seite des Autos ausblenden
  spiegeln: false,                // Bild links/rechts gespiegelt auswerten (nur falls die AVE gespiegelt liefert)
  sichtAn: 0.10, sichtAus: 0.03,  // wie deutlich eine Fläche zur Kamera zeigen muss (0 = seitlich, 1 = frontal)
  ruheSchwelle: 0.004,            // bewegt sich ein Punkt zwischen zwei Abfragen mehr (Anteil Bildschirm), ist die Kamera in Bewegung → ausblenden
  ruheAbfragen: 2,                // so viele ruhige Abfragen hintereinander, bevor die Punkte wieder erscheinen
  ohne: '^Test',                  // Spots mit passender id nicht zeigen (regulärer Ausdruck, "" = alle)
  // Panoramadach: die AVE hat die Animation, liefert aber keinen Spot. Der Kiosk setzt selbst einen Punkt aufs Dach.
  // dach: erste vorhandene Animation aus der Liste wird genommen; [] = kein Dach-Spot
  dach: ['GlassRoofAll', 'GlassRoofSlide', 'SunShadeGlassRoof'],
  dachPunkt: [-0.25, 0, 0.55],    // Lage am Auto in m: [nach vorn ab Türgriff-Mitte, nach links, über Griffhöhe]
}, cfg.spots || {});

// ---------- Autostart: EventInterface (Port 4242) und optional die AVE ----------
// config.json: "autostart": [ { "name": "EventInterface", "pfad": "C:\\…\\EventInterface.exe", "port": 4242 },
//                              { "name": "AVE", "pfad": "C:\\…\\AVE.exe", "prozess": "AVE.exe", "argumente": [] } ]
// Erkennung: "port" (antwortet etwas?) oder "prozess" (läuft die .exe?). Reihenfolge = Startreihenfolge.
// "pfad" darf auch ein Ordner sein – die Startdatei (.exe, .bat, .cmd, .lnk) darin wird selbst gesucht.
// %APPDATA%, %USERPROFILE% usw. im Pfad auflösen – dieselbe config.json passt dann auf jedem Gerät
const umgebungsPfad = (p) => String(p || '').replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? process.env[v.toUpperCase()] ?? m);
const autostart = (Array.isArray(cfg.autostart) ? cfg.autostart : []).map((a) => ({ ...a, pfad: umgebungsPfad(a.pfad) }));
const portOffen = (port) => new Promise((ok) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); ok(true); });
  s.on('error', () => ok(false));
  s.setTimeout(1000, () => { s.destroy(); ok(false); });
});
function prozessLaeuft(exe) {
  if (process.platform !== 'win32') return false;
  try { return execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH'], { encoding: 'utf8', windowsHide: true }).toLowerCase().includes(exe.toLowerCase()); }
  catch { return false; }
}
async function laeuftSchon(a) {
  if (a.port && await portOffen(a.port)) return true;
  if (a.prozess && prozessLaeuft(a.prozess)) return true;
  return false;
}
// Ordner → Startdatei darin: passend zum Namen, sonst die einzige .exe, sonst die einzige Startdatei
const gemeldet = new Set();
function startDatei(a, name) {
  let p = a.pfad;
  if (!fs.existsSync(p)) { log(`Autostart ${name}: nicht gefunden: ${p}`); return null; }
  if (!fs.statSync(p).isDirectory()) return p;
  const kand = fs.readdirSync(p).filter((n) => /\.(exe|bat|cmd|lnk)$/i.test(n) && !/unins|setup|update|crash|helper/i.test(n));
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
  const exes = kand.filter((n) => /\.exe$/i.test(n));
  const wahl = kand.find((n) => norm(n).includes(norm(name))) || (exes.length === 1 ? exes[0] : null) || (kand.length === 1 ? kand[0] : null);
  if (!wahl) { log(`Autostart ${name}: im Ordner ${p} keine eindeutige Startdatei (${kand.join(', ') || 'keine'}) – bitte die Datei in "pfad" angeben`); return null; }
  p = path.join(p, wahl);
  if (!gemeldet.has(p)) { gemeldet.add(p); log(`Autostart ${name}: Startdatei ${p}`); }
  return p;
}
// .exe direkt; .bat/.cmd über cmd (Node startet sie nicht direkt); Verknüpfungen über "start"
function starte(datei, argumente) {
  const opt = { cwd: path.dirname(datei), detached: true, stdio: 'ignore', windowsHide: false };
  const ext = path.extname(datei).toLowerCase();
  // cmd /s /c "…": die äußeren Anführungszeichen entfernt cmd, alles darin bleibt wörtlich – so
  // überstehen Pfade mit Leerzeichen. Node würde "" sonst falsch maskieren (daher verbatim).
  const argStr = argumente.map((x) => ` "${x}"`).join('');
  const viaCmd = (zeile) => spawn('cmd.exe', ['/d', '/s', '/c', `"${zeile}"`], { ...opt, windowsHide: true, windowsVerbatimArguments: true }).unref();
  if (ext === '.bat' || ext === '.cmd') return viaCmd(`"${datei}"${argStr}`);
  if (ext === '.lnk') return viaCmd(`start "" "${datei}"${argStr}`);
  spawn(datei, argumente, opt).unref();
}
let autostartZuletzt = 0;
async function autostartSicherstellen(grund) {
  if (!autostart.length || Date.now() - autostartZuletzt < 30000) return;   // höchstens alle 30 s
  autostartZuletzt = Date.now();
  for (const a of autostart) {
    const name = a.name || path.basename(a.pfad || '?');
    if (!a.pfad) { log(`Autostart ${name}: kein "pfad" angegeben`); continue; }
    if (await laeuftSchon(a)) continue;
    const datei = startDatei(a, name);
    if (!datei) continue;
    log(`Autostart (${grund}): starte ${name}`);
    try { starte(datei, a.argumente || []); }
    catch (e) { log(`Autostart ${name}: ${e.message}`); continue; }
    if (!a.port && !a.prozess) { await sleep((a.wartenSek || 5) * 1000); continue; }
    const bis = Date.now() + (a.wartenSek || 60) * 1000;
    while (Date.now() < bis && !(await laeuftSchon(a))) await sleep(1000);
    log(`Autostart ${name}: ${await laeuftSchon(a) ? 'läuft' : 'antwortet nach ' + (a.wartenSek || 60) + ' s noch nicht'}`);
    if (a.nachStartSek) await sleep(a.nachStartSek * 1000);          // z. B. AVE braucht nach dem Start noch
  }
}

// ---------- AVE ----------
const fehlerArt = (e) => e.art || (e.name === 'TimeoutError' ? 'timeout' : 'verbindung');

async function aveSend(name, data, lastUpdate, timeoutMs = ave.timeoutMs) {
  const body = JSON.stringify([{ meta: { name, type: 'REQUEST', lastUpdate: !!lastUpdate }, data }]);
  const t0 = Date.now();
  const r = await fetch(ave.url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text().catch(() => '');
  // Antwort vollständig protokollieren: daraus lernen wir, ob und wie die AVE "fertig" meldet.
  log(`AVE ${name}: HTTP ${r.status} in ${Date.now() - t0} ms${text ? ' – ' + text.slice(0, 800).replace(/\s+/g, ' ') : ''}`);
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { art: 'http' });
  return text;
}

// Nur EINMAL anmelden. Jede neue Anmeldung setzt die AVE zurück in den Idle-Modus
// (Videos) und wirft das geladene Fahrzeug weg. Neu angemeldet wird nur, wenn die
// AVE nicht erreichbar war – dann ist sie vermutlich neu gestartet.
let sessionOk = false;
async function sessionSicher() {
  if (!ave.startSession || sessionOk) return;
  const sessionId = String(Math.floor(100000 + Math.random() * 900000));
  await aveSend('AVEStartSession', { clientId: ave.clientId, sessionId }, false);
  sessionOk = true;
}

// ---------- Fahrzeuge ----------
const fzFile = path.join(baseDir, 'fahrzeuge.json');
let fahrzeuge = [];

const prListe = (pr) => Array.isArray(pr) ? pr.map(String).filter(Boolean) : String(pr || '').split(/[\s,;]+/).filter(Boolean);

function bild(p) {
  if (!p) return null;
  const f = path.isAbsolute(p) ? p : path.join(baseDir, p);
  try {
    const ext = path.extname(f).slice(1).toLowerCase();
    const mime = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', svg: 'svg+xml' }[ext] || 'png';
    return `data:image/${mime};base64,` + fs.readFileSync(f).toString('base64');
  } catch {
    if (!bildCfg.auto) log(`Bild fehlt: ${f} – Fahrzeug wird ohne Bild gezeigt`);
    return null;
  }
}

// ---------- Katalog (Farben und Felgen je Modell, aus dem DCC) ----------
const katFile = path.join(baseDir, 'katalog.json');
const katBildDir = path.join(baseDir, 'bilder', 'katalog');
let katalog = [];
// Alle katalog*.json im Ordner (auch "katalog (1).json" usw. aus dem Browser-Download)
// werden zusammengeführt. Gleiches Modell (Modellcode + Jahr): die neueste Datei gewinnt.
const katalogDateien = () => fs.readdirSync(baseDir).filter((n) => /^katalog.*\.json$/i.test(n))
  .map((n) => path.join(baseDir, n)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
function ladeKatalog() {
  const nachModell = new Map();
  const dateien = katalogDateien();
  for (const d of dateien) {
    try {
      const k = JSON.parse(fs.readFileSync(d, 'utf8'));
      for (const e of k.fahrzeuge || []) {
        if (!e.aveString) continue;
        const a = e.aveString.split(',');
        nachModell.set(`${a[1]}-${a[2]}`, e);
      }
    } catch (e) { log(`FEHLER ${path.basename(d)}: ${e.message}`); }
  }
  katalog = [...nachModell.values()];
  if (dateien.length) log(`Katalog: ${katalog.length} Modelle aus ${dateien.length} Datei(en)`);
}
function katBildPfad(url) {
  if (!url) return null;
  let ext = '.jpg';
  try { ext = path.extname(new URL(url).pathname) || '.jpg'; } catch {}
  return path.join(katBildDir, crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + ext);
}
const bildCache = new Map();
function katBild(url) {
  const p = katBildPfad(url);
  if (!p || !fs.existsSync(p)) return null;
  if (!bildCache.has(p)) bildCache.set(p, bild(p));
  return bildCache.get(p);
}
// Katalogeintrag zu einem Fahrzeug: ausdrücklich per "katalog" (modelId oder Namensteil)
// oder über Modellcode + Modelljahr im PR-String (Stelle 2 und 3).
function findeKatalog(ref, pr) {
  if (ref) {
    const r = String(ref).toLowerCase();
    return katalog.find((e) => e.modelId === ref) || katalog.find((e) => String(e.name).toLowerCase().includes(r)) || null;
  }
  if (pr.length < 3) return null;
  return katalog.find((e) => { const a = e.aveString.split(','); return a[1] === pr[1] && a[2] === pr[2]; }) || null;
}

// ---------- PR-String für Farbe/Felge ----------
// Der Katalog speichert je Option, welche Codes gegenüber der Serienausstattung dazukommen
// (plus) und wegfallen (minus). Stelle 4 ist die Außenfarbe (4 Zeichen), Stelle 5 der
// Innenraum (2 Zeichen) – die werden an Ort und Stelle ersetzt, der Rest angehängt/entfernt.
const umkehr = (o) => ({ plus: o.minus || [], minus: o.plus || [] });
function wende(arr, o) {
  if (!o || (!o.plus && !o.minus)) return arr;
  const out = arr.slice(), minus = new Set(o.minus || []), plus = (o.plus || []).slice();
  for (const [i, len] of [[3, 4], [4, 2]]) {
    if (!minus.has(out[i])) continue;
    const k = plus.findIndex((c) => c.length === len);
    if (k >= 0) { minus.delete(out[i]); out[i] = plus.splice(k, 1)[0]; }
  }
  const rest = out.slice(5).filter((c) => !minus.has(c));
  return [...out.slice(0, 5), ...rest, ...plus.filter((c) => !out.includes(c) && !rest.includes(c))];
}
// Ausgangsfarbe. Ist sie ein Audi-exclusive-Platzhalter mit erfassten Farben, startet das Fahrzeug in der
// ersten Exklusivfarbe – der reine Platzhalter hätte in der AVE keine echte Farbe.
const grundFarbeCode = (f) => (f.farben.find((o) => o.code === f.pr[3]) || {}).code || null;
const grundFarbe = (f) => {
  const o = f.farben.find((x) => x.code === f.pr[3]);
  if (!o) return null;
  return o.exklusiv && o.exklusiv.length ? o.exklusiv[0].code : o.code;
};
const grundFelge = (f) => (f.felgen.find((o) => f.pr.includes(o.code)) || {}).code || null;
// Farbe "Q0Q0:AEEXC140" = Platzhalter Q0Q0 plus Audi-exclusive-Farbe → "LC_PR_AEEXC140" anhängen (wie der DCC)
const exklusivTeil = (farbe) => { const m = /^([^:]+):(.+)$/.exec(farbe || ''); return m ? { basis: m[1], ae: m[2] } : null; };
function prFuer(f, farbe, felge) {
  const ex = exklusivTeil(farbe);
  if (ex) farbe = ex.basis;
  let arr = f.pr.filter((c) => !/^LC_PR_/.test(c));
  const istF = f.farben.find((o) => o.code === grundFarbeCode(f)), zielF = f.farben.find((o) => o.code === farbe);
  if (zielF && zielF !== istF) { if (istF) arr = wende(arr, umkehr(istF)); arr = wende(arr, zielF); }
  const istW = f.felgen.find((o) => o.code === grundFelge(f)), zielW = f.felgen.find((o) => o.code === felge);
  if (zielW && zielW !== istW) { if (istW) arr = wende(arr, umkehr(istW)); arr = wende(arr, zielW); }
  if (ex) arr = [...arr, 'LC_PR_' + ex.ae];
  return arr;
}

// Unbrauchbare Katalogoptionen: Fehler beim Erfassen, oder der DCC war zwischendurch auf
// einem anderen Modell (dann steht der Modellcode in "minus")
// Platzhalter ausblenden: "Individuallackierungen/Polarmatteffekt Audi exclusive" (Q0Q0, O0O0) liefert die
// DCC-Schnittstelle mit, die DCC-Oberfläche bietet sie aber nicht an – die eigentliche Farbe fehlt.
// config.json: "optionenAusblenden": "Regulärer Ausdruck auf den Code", "" = nichts ausblenden
// Nur die reinen Platzhalter – echte Exklusivfarben wie Q0A2 "… Brillantschwarz" bleiben.
const ausblenden = cfg.optionenAusblenden === undefined ? /^(Q0Q0|O0O0)$/i : (cfg.optionenAusblenden ? new RegExp(cfg.optionenAusblenden, 'i') : null);
// Ohne erfasste Änderung (plus/minus leer) hat der DCC die Option beim Erfassen nicht übernommen –
// der Kiosk würde dann nur die Ausgangsfarbe laden. Solche Einträge ausblenden.
const optionOk = (o, kat) => !o.fehler && !(o.minus || []).includes(kat.aveString.split(',')[1])
  && (o.serie || (o.plus || []).length > 0 || (o.minus || []).length > 0)
  && !(ausblenden && ausblenden.test(o.code || '') && !(o.exklusiv && o.exklusiv.length));   // mit erfassten Exklusivfarben bleibt die Kachel

// "Audi Q7 SUV TDI quattro 180 kW tiptronic" → "Q7 SUV" – Name bis zur Motorisierung
function kurzName(n) {
  const s = String(n || '').replace(/\s+/g, ' ').replace(/^Audi /, '').trim();
  const m = s.match(/^(.*?)\s+(TDI|TFSI|quattro|\d+\s*kW)\b/);
  return (m && m[1]) || s;
}
// Gleiche Kurznamen (mehrere Motorisierungen einer Baureihe) um die Motorisierung ergänzen
function eindeutigeNamen(liste) {
  const zahl = new Map();
  for (const f of liste) zahl.set(f.name, (zahl.get(f.name) || 0) + 1);
  for (const f of liste) if (f.langName && zahl.get(f.name) > 1)
    f.name = String(f.langName).replace(/\s+/g, ' ').replace(/^Audi /, '').replace(/^(.*?\d+\s*kW).*$/, '$1');
}

// Eigene Fahrzeugbilder in bilder/fahrzeuge, benannt nach dem Modell ("Q7 SUV.jpg").
// Zuordnung über den Namen ohne "Audi", Groß-/Kleinschreibung und Sonderzeichen: erst exakt,
// sonst die einzige Datei, die mit dem Namen beginnt ("Audi Q9" → "Q9 SUV.jpg"), sonst die
// einzige, die alle Wörter enthält. Mehrdeutig → kein Bild, es wird wie bisher aufgenommen.
const fzBildDir = path.join(baseDir, 'bilder', 'fahrzeuge');
const bildNorm = (t) => String(t || '').toLowerCase().replace(/^\s*audi\s+/, '').replace(/[^a-z0-9]/g, '');
function fahrzeugBilder() {
  try { return fs.readdirSync(fzBildDir).filter((n) => /\.(png|jpe?g|webp)$/i.test(n)); } catch { return []; }
}
function eigenesFahrzeugbild(name, dateien) {
  const n = bildNorm(name);
  if (!n) return null;
  const stamm = (d) => bildNorm(d.replace(/\.[^.]+$/, ''));
  const einzig = (t) => (t.length === 1 ? t[0] : null);
  // Wörter einzeln: "A3 Sportback e-hybrid" passt zu "A3 Sportback S line e-hybrid.jpg"
  const woerter = (t) => String(t || '').toLowerCase().replace(/^\s*audi\s+/, '').split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  const w = woerter(name);
  const wahl = dateien.find((d) => stamm(d) === n)
    || einzig(dateien.filter((d) => stamm(d).startsWith(n)))
    || einzig(dateien.filter((d) => { const dw = woerter(d.replace(/\.[^.]+$/, '')); return w.every((x) => dw.includes(x)); }));
  return wahl ? path.join('bilder', 'fahrzeuge', wahl) : null;
}

function ladeFahrzeuge() {
  const eigeneBilder = fahrzeugBilder();
  let raw = [];
  if (fs.existsSync(fzFile)) {
    try { raw = JSON.parse(fs.readFileSync(fzFile, 'utf8')); } catch (e) {
      log(`FEHLER fahrzeuge.json: ${e.message} – bisherige Liste bleibt`);
      return false;
    }
  }
  const list = (Array.isArray(raw) ? raw : raw.fahrzeuge) || [];
  const ok = [], ids = new Set(), benutzt = new Set();
  list.forEach((f, i) => {
    const eigen = prListe(f.pr);
    const kat = findeKatalog(f.katalog, eigen);
    if (f.katalog && !kat) log(`fahrzeuge.json: "${f.id}" – Katalogeintrag "${f.katalog}" nicht gefunden`);
    const pr = eigen.length ? eigen : (kat ? kat.aveString.split(',') : []);
    if (!f.id || !f.name || pr.length < 3) return log(`fahrzeuge.json: Eintrag ${i + 1} unvollständig (id, name und pr oder katalog) – übersprungen`);
    if (ids.has(f.id)) return log(`fahrzeuge.json: id "${f.id}" doppelt – übersprungen`);
    ids.add(f.id);
    if (kat) benutzt.add(kat);
    ok.push({
      id: f.id, name: f.name, pr,
      bildDatei: f.img || dccBild(kat) || eigenesFahrzeugbild(f.name, eigeneBilder) || path.join('bilder', `${dateiname(f.id)}.png`),
      modelRevision: f.modelRevision || ave.modelRevision,
      consumptionData: f.consumptionData || (kat && kat.verbrauch && kat.verbrauch.length ? kat.verbrauch : ave.consumptionData),
      farben: kat ? kat.farben.filter((o) => optionOk(o, kat)) : [],
      felgen: kat ? kat.felgen.filter((o) => optionOk(o, kat)) : [],
    });
  });
  // Alle übrigen Katalogmodelle automatisch als Fahrzeuge (abschaltbar: "katalogFahrzeuge": false)
  if (cfg.katalogFahrzeuge !== false) {
    for (const e of katalog) {
      if (benutzt.has(e)) continue;
      const pr = e.aveString.split(',');
      const id = dateiname(`kat-${pr[1]}-${pr[2]}`);
      if (ids.has(id)) continue;
      ids.add(id);
      ok.push({
        id, name: kurzName(e.name), langName: e.name, pr,
        bildDatei: dccBild(e) || eigenesFahrzeugbild(kurzName(e.name), eigeneBilder) || path.join('bilder', `${id}.png`),
        modelRevision: ave.modelRevision,
        consumptionData: e.verbrauch && e.verbrauch.length ? e.verbrauch : ave.consumptionData,
        farben: e.farben.filter((o) => optionOk(o, e)),
        felgen: e.felgen.filter((o) => optionOk(o, e)),
      });
    }
  }
  eindeutigeNamen(ok);
  for (const f of ok) f.img = bild(f.bildDatei);
  // Pflichtangaben: Fahrzeuge ohne echte Verbrauchswerte (Platzhalter X.X oder leer) melden
  const ohneWerte = ok.filter((f) => !f.consumptionData.length || f.consumptionData.some((z) => /X\.X|XXX/.test(z)));
  if (ohneWerte.length) log(`WARNUNG: ${ohneWerte.length} Fahrzeug(e) ohne Verbrauchswerte – im DCC neu erfassen: ${ohneWerte.map((f) => f.name).join(', ')}`);
  fahrzeuge = ok;
  const mitOpt = ok.filter((f) => f.farben.length > 1 || f.felgen.length > 1).length;
  log(`${ok.length} Fahrzeuge geladen (${list.length} aus fahrzeuge.json, ${mitOpt} mit Farben/Felgen): ${ok.map((f) => f.id).join(', ')}`);
  return true;
}
// ---------- Showcar: ein festes Fahrzeug nur zeigen, ohne Konfiguration ----------
// Eintrag „★ <name>“ in der Typ-Walze. Gewählt: Farbe, Felge, Umgebung und Fahrzeugwalze verschwinden,
// das Showcar wird geladen (und, falls angegeben, seine Umgebung). Anderer Typ: vorheriges Fahrzeug zurück.
// config.json: "showcar": { "name": "…", "pr": "…", "umgebung": "AVE-Name der Umgebung" }  –  false = aus
const SHOWCAR_STANDARD = {
  name: 'Nuvolari',
  pr: '59997,H13RX1,2027,0000,99,6H4,0HN,4VN,4UF,GV1,EA0,5JB,0K3,A8S,6K8,2EK,1LG,6FP,B0A,1S2,7YF,QJ5,C00,IT3,IU1,JE3,IW3,2MC,3FI,NI1,7AL,7X2,7W0,03M,6A0,8K3,5L6,F0A,T04,8T6,G1F,6V0,A52,5J8,4HG,8IY,U5A,K8C,0Y1,KA2,31K,A1Z,QQ2,ES3,L0L,8G4,70T,73A,76A,1XY,AV1,9VD,2C7,FN9,IY1,EM2,8Z5,M3C,7Q2,P01,ZDE,FT0,46N,ER1,86I,1G8,8VP,N6C,0LI,8F2,7L3,7Y0,6I3,4KV,FA0,4F2,B01,5D1,QV3,Q1J,7E1,4GQ,8FL,2WA,0TC,ARFPZ,FBCPZ,SEIPZ,FTAPZ,LBWPZ,CANPZ,AZMPZ,CONPZ,BZAPZ,DORPZ,FCCPZ,DOOPZ,AZAPZ,SBTPZ',
  umgebung: 'Studio_Cream_3D',   // AVE-Name; leer = aktuelle Umgebung bleibt
  leerlaufSek: 30,               // ohne Berührung so lange → zurück auf „Alle“ (0 = aus)
};
const showCfg = cfg.showcar === false ? null : Object.assign({}, SHOWCAR_STANDARD, cfg.showcar || {});
const SHOW_ID = '__showcar';
const showcar = showCfg && showCfg.pr ? {
  id: SHOW_ID, name: showCfg.name, pr: prListe(showCfg.pr), img: '-',   // img gesetzt: kein automatisches Vorschaubild
  modelRevision: showCfg.modelRevision || ave.modelRevision, consumptionData: showCfg.consumptionData || [],
  farben: [], felgen: [],
} : null;
let showAktiv = false, showVorher = null, showWunsch = false, showArbeitet = false;
const fzFinden = (id) => fahrzeuge.find((x) => x.id === id) || (showcar && id === SHOW_ID ? showcar : null);

// Wunsch von der Typ-Walze: wird abgearbeitet, sobald nichts mehr lädt – geht nie verloren.
// (Vorher wurde ein Wechsel während eines Ladevorgangs verworfen, dann blieben Umgebung und Knöpfe aus.)
function showcarWunsch(an, grund) {
  if (!showcar) return;
  showWunsch = !!an;
  if (!showArbeitet) showcarAbarbeiten(grund);
}
async function showcarAbarbeiten(grund) {
  showArbeitet = true;
  try {
    while (showWunsch !== showAktiv) {
      while (laeuft || animLaeuft()) await sleep(300);
      if (showWunsch === showAktiv) break;
      await showcarModus(showWunsch, grund);
    }
  } catch (e) { log(`Showcar: ${e.message}`); }
  finally { showArbeitet = false; }
}
async function showcarModus(an, grund) {
  if (!showcar || an === showAktiv) return;
  if (an) {
    showVorher = { aktiv, farbe: aktivFarbe, felge: aktivFelge, umgebung: aktivUmgebung };
    showAktiv = true;
    pushOptionen(); pushUmgebungen(); pushAktionen();
    if (!(await ladeFahrzeug(SHOW_ID, grund))) {          // Laden fehlgeschlagen: alles zurück auf normal
      showAktiv = false; showWunsch = false; showVorher = null;
      pushOptionen(); pushUmgebungen(); pushAktionen();
      fe(`fe.setFilter && fe.setFilter('alle')`, 'models');
      return;
    }
    if (!showWunsch) return;                               // inzwischen schon wieder weggedreht
    if (showCfg.umgebung) {
      const u = umgebungen.find((x) => x.env === showCfg.umgebung || x.name === showCfg.umgebung);
      if (u) await ladeUmgebung(u.id, `${grund} Showcar`);
      else {
        try { await aveSend('AVESelectEnvironment', { environmentName: showCfg.umgebung }, true, ave.ladeTimeoutMs); aktivUmgebung = null; }
        catch (e) { log(`Showcar-Umgebung ${showCfg.umgebung}: ${e.message}`); }
      }
    }
  } else {
    showAktiv = false;
    const v = showVorher || {}; showVorher = null;
    const id = fahrzeuge.some((f) => f.id === v.aktiv) ? v.aktiv : startId();
    pushUmgebungen(); pushAktionen();
    while (laeuft) await sleep(300);
    if (id && await ladeFahrzeug(id, grund, id === v.aktiv ? { farbe: v.farbe, felge: v.felge } : {})) push();
    const env = v.umgebung || envStart;
    if (showCfg.umgebung && env && env !== aktivUmgebung) await ladeUmgebung(env, `${grund} Showcar Ende`);
  }
}

// ---------- Fahrzeugbilder aus der AVE ----------
// Nach dem ersten Laden eines Fahrzeugs ohne Bild wird ein Ausschnitt des Bildschirms
// aufgenommen und unter bilder/<id>.png gespeichert. Vorhandene Dateien haben Vorrang;
// zum Neuaufnehmen die Datei löschen oder Strg+Alt+Shift+B.
const bildCfg = Object.assign({ auto: true, wartenMs: 1500, x: 0.3, y: 0.2, w: 0.6, h: 0.6, breitePx: 520,
  // Renderbild aus dem DCC (beim Erfassen gespeichert) vor eigenen Bildern verwenden – einheitlich für alle Modelle.
  // dcc: true/false, dccHintergrund: "moma" (ohne Hintergrund) oder "standard" (mit DCC-Hintergrund)
  dcc: true, dccHintergrund: 'moma' }, cfg.bild || {});
// Pfad des heruntergeladenen DCC-Renderbilds zu einem Katalogeintrag (null, wenn keins da ist)
function dccBild(kat) {
  if (!bildCfg.dcc || !kat || !kat.bild) return null;
  const url = kat.bild[bildCfg.dccHintergrund] || kat.bild.moma || kat.bild.standard;
  const p = katBildPfad(url);
  return p && fs.existsSync(p) ? p : null;
}
const dateiname = (id) => String(id).replace(/[^a-z0-9._-]+/gi, '_');

async function bildAufnehmen(f, grund, bereich = bildCfg) {
  const d = display();
  const sf = d.scaleFactor || 1;
  const size = { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) };
  const quellen = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const q = quellen.find((s) => s.display_id === String(d.id)) || quellen[0];
  if (!q || q.thumbnail.isEmpty()) throw new Error('keine Bildschirmaufnahme möglich');
  const { width: W, height: H } = q.thumbnail.getSize();
  const rect = { x: Math.round(W * bereich.x), y: Math.round(H * bereich.y), width: Math.round(W * bereich.w), height: Math.round(H * bereich.h) };
  const bild = q.thumbnail.crop(rect).resize({ width: bereich.breitePx, quality: 'best' });
  // Schwarzes Bild = AVE im exklusiven Vollbild, dort sieht die Aufnahme nichts.
  const px = bild.toBitmap();
  let hell = 0;
  for (let i = 0; i < px.length; i += 4 * 97) hell = Math.max(hell, px[i], px[i + 1], px[i + 2]);
  if (hell < 12) throw new Error('Aufnahme ist schwarz – läuft die AVE im exklusiven Vollbild?');
  const png = bild.toPNG();
  const datei = path.isAbsolute(f.bildDatei) ? f.bildDatei : path.join(baseDir, f.bildDatei);
  fs.mkdirSync(path.dirname(datei), { recursive: true });
  fs.writeFileSync(datei, png);
  f.img = 'data:image/png;base64,' + png.toString('base64');
  log(`${grund}: Bild für ${f.name} aufgenommen → ${datei}`);
}

// ---------- Umgebungen (AVESelectEnvironment) ----------
// umgebungen.json: { "start": "Studio", "umgebungen": [ { "name": "Private Villa Winter" }, … ] }
// "env" ist der Name für die AVE; fehlt er, wird er aus "name" gebildet (Leerzeichen → _).
const envFile = path.join(baseDir, 'umgebungen.json');
const envBildCfg = Object.assign({ x: 0.14, y: 0.08, w: 0.72, h: 0.84, breitePx: 320 }, cfg.umgebungBild || {});
let umgebungen = [], envStart = null, aktivUmgebung = null;
function eigenesUmgebungsbild(env) {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const rel = path.join('bilder', 'umgebungen', `${env}.${ext}`);
    if (fs.existsSync(path.join(baseDir, rel))) return rel;
  }
  return null;
}
function ladeUmgebungen() {
  umgebungen = []; envStart = null;
  if (!fs.existsSync(envFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    const liste = Array.isArray(raw) ? raw : (raw.umgebungen || []);
    for (const u of liste) {
      const o = typeof u === 'string' ? { name: u } : (u || {});
      if (!o.name && !o.env) continue;
      const env = o.env || String(o.name).trim().replace(/\s+/g, '_');
      const name = o.name || String(env).replace(/_/g, ' ');
      const id = dateiname(env);
      // Bildquelle: "img" in umgebungen.json > bilder/umgebungen/<AVE-Name>.png|jpg|webp > selbst aufgenommen
      const bildDatei = o.img || eigenesUmgebungsbild(env) || path.join('bilder', `umgebung-${id}.png`);
      umgebungen.push({ id, name, env, bildDatei, img: bild(bildDatei) });
    }
    const st = !Array.isArray(raw) && raw.start;
    envStart = (umgebungen.find((u) => u.name === st || u.env === st || u.id === st) || {}).id || null;
    log(`${umgebungen.length} Umgebungen geladen${envStart ? `, Start: ${envStart}` : ''}`);
  } catch (e) { log(`FEHLER umgebungen.json: ${e.message}`); }
}
// Umgebungswalze weich aus- und einblenden (während der Kamerafahrt der Lichtshow)
let envAus = false, envFade = null;
function umgebungFaden(an, ms) {
  const w = wins.envs;
  envAus = !an;
  if (!w || w.isDestroyed()) return;
  clearInterval(envFade);
  const sichtbar = umgebungen.length > 1 && !offen.fahren && !showAktiv;
  if (an && !sichtbar) return;
  if (an) { w.setOpacity(0); w.showInactive(); }
  const t0 = Date.now(), dauer = Math.max(1, ms);
  envFade = setInterval(() => {
    if (w.isDestroyed()) return clearInterval(envFade);
    const p = Math.min(1, (Date.now() - t0) / dauer), e = p * p * (3 - 2 * p);
    w.setOpacity(an ? e : 1 - e);
    if (p >= 1) { clearInterval(envFade); if (!an) { w.hide(); w.setOpacity(1); } }
  }, 30);
}
function pushUmgebungen() {
  const w = wins.envs;
  if (!w || w.isDestroyed()) return;
  if (umgebungen.length > 1 && !offen.fahren && !showAktiv && !envAus) w.showInactive();
  else if (!envAus) w.hide();                         // envAus: das Ausblenden übernimmt umgebungFaden
  const list = umgebungen.map((u) => ({ id: u.id, name: u.name, img: u.img }));
  fe(`fe.setEnvs(${JSON.stringify(list)}, ${JSON.stringify(aktivUmgebung)})`, 'envs');
}
async function ladeUmgebung(id, grund) {
  const u = umgebungen.find((x) => x.id === id);
  if (!u) return log(`${grund}: unbekannte Umgebung "${id}"`);
  if (laeuft) return log(`${grund}: Umgebung ${u.name} verworfen – es lädt noch`);
  if (!(await fahrszeneVorher(grund))) return false;
  laeuft = true;
  sperre(true, 'wird geladen …');
  log(`${grund}: Umgebung ${u.name} (${u.env})`);
  let ok = false;
  try {
    await sessionSicher();
    await aveSend('AVESelectEnvironment', { environmentName: u.env }, true, ave.ladeTimeoutMs);
    aktivUmgebung = u.id; ok = true;
    await sleep(ave.nachlaufMs);
    if (!u.img) {
      await sleep(bildCfg.wartenMs);
      await bildAufnehmen(u, 'Umgebung', envBildCfg).catch((e) => log(`Bild ${u.name}: ${e.message}`));
    }
  } catch (e) {
    const art = fehlerArt(e);
    if (art === 'timeout') { log(`WARNUNG Umgebung ${u.name}: keine Antwort – gilt als geladen`); aktivUmgebung = u.id; ok = true; }
    else { log(`FEHLER Umgebung ${u.name}: ${e.message} (${art})`); if (art === 'verbindung') sessionOk = false; }
  } finally {
    laeuft = false;
    sperre(false);
  }
  setTimeout(pushUmgebungen, ok ? 0 : 4200);
  return ok;
}

// ---------- Türen, Kofferraum, Fahrszene ----------
const offen = { tueren: false, kofferraum: false, fahren: false };
let aktionLaeuft = false;
const KNOEPFE = ['tueren', 'kofferraum', 'leaving', 'coming', 'fahren', 'fahren2'];
const knopfDa = (k) => (k === 'fahren2' ? aktionen.knoepfe.includes('fahren') && !!aktionen.fahrszene2 : aktionen.knoepfe.includes(k))
  && (k !== 'fahren' || !!aktionen.fahrszene)
  && (!['leaving', 'coming'].includes(k) || !!(aktionen.licht && aktionen.licht[k]));
const knopfZahl = () => KNOEPFE.filter(knopfDa).length;
function pushAktionen() {
  const w = wins.actions;
  if (!w || w.isDestroyed()) return;
  if (aktiv && !offen.fahren && !showAktiv && knopfZahl()) w.showInactive(); else w.hide();   // Showcar: keine Knöpfe
  const zustand = { ...offen, busy: laeuft || aktionLaeuft || lichtLaeuft,
    gesperrt: offen.fahren ? ['tueren', 'kofferraum', 'leaving', 'coming'] : [],   // in der Fahrszene nur Play
    ohne: KNOEPFE.filter((k) => !knopfDa(k)) };
  fe(`fe.setAktionen(${JSON.stringify(zustand)})`, 'actions');
}
async function aktion(was, zu = null, grund = 'Aktion') {
  if (was === 'leaving' || was === 'coming') return lichtshow(was, grund);
  let szene = aktionen.fahrszene;
  if (was === 'fahren2') { was = 'fahren'; szene = aktionen.fahrszene2; }   // zweite Fahrszene, gleicher Ablauf
  const fahren = was === 'fahren';
  if (!(fahren ? (szene || offen.fahren) : aktionen[was]) || !aktiv) return false;
  if (laeuft || aktionLaeuft || lichtLaeuft) { log(`${grund}: ${was} verworfen – es läuft noch etwas`); return false; }
  if (!fahren && offen.fahren) { log(`${grund}: ${was} verworfen – Fahrszene läuft`); return false; }
  const oeffnen = zu === null ? !offen[was] : !zu;
  if (oeffnen === offen[was]) return true;
  // Wie beim Fahrzeugladen: alles sperren, bis die Animation durch ist
  aktionLaeuft = true; laeuft = true;
  sperre(true, fahren ? (oeffnen ? 'Fahrszene startet …' : 'Fahrszene endet …') : (oeffnen ? 'öffnet …' : 'schließt …'));
  log(`${grund}: ${fahren ? 'Fahrszene ' + (oeffnen ? `starten (${szene})` : 'beenden') : was + ' ' + (oeffnen ? 'öffnen' : 'schließen')}`);
  let ok = false;
  const t0 = Date.now();
  try {
    await sessionSicher();
    if (fahren) {
      // Die AVE baut dafür eine eigene Szene auf – wie beim Fahrzeugladen auf die Antwort warten
      await aveSend(oeffnen ? 'AVEDrivingSceneStart' : 'AVEDrivingSceneStop', oeffnen ? { name: szene } : {}, true, ave.ladeTimeoutMs);
      if (oeffnen) { offen.tueren = false; offen.kofferraum = false; }
      offen.fahren = oeffnen;
      fahrtAnsicht(oeffnen);
    } else {
      await aveSend('AVETriggerAnimations', { carId: 'current', animationIds: aktionen[was], direction: oeffnen ? aktionen.vor : aktionen.zurueck, skip: false }, true);
    }
    offen[was] = oeffnen; ok = true;
  } catch (e) {
    const art = fehlerArt(e);
    if (art === 'timeout') { offen[was] = oeffnen; ok = true; }     // Animation läuft trotzdem
    else { log(`FEHLER ${was}: ${e.message} (${art})`); if (art === 'verbindung') sessionOk = false; }
  } finally {
    if (ok) await sleep(fahren ? ave.nachlaufMs : Math.max(0, aktionen.dauerMs - (Date.now() - t0)));
    aktionLaeuft = false; laeuft = false;
    sperre(false);
  }
  return ok;
}
// ---------- Interaktions-Spots ----------
let spotListe = [], spotAbfrage = false, spotZuletztLeer = false, spotRoh = [];
// Strg+Alt+Shift+D: aktuelle Spot-Daten und die Entscheidung ins Log – zum Abgleich mit dem, was man sieht
function spotDiagnose(ansicht) {
  const sicht = spotSichtbarkeit(spotListe);
  const d = spotLetzterBlick;
  log(`SPOT-DIAGNOSE ${ansicht || ''} | Bildschirm ${display().bounds.width}x${display().bounds.height} | spiegeln=${spots.spiegeln}`
    + ` | Blick=${d ? d.map((v) => v.toFixed(2)).join(',') : 'keiner'} | L=${spotSicht.L} R=${spotSicht.R} hinten=${spotSicht.hinten} vorn=${spotSicht.vorn}`);
  for (const r of spotRoh) {
    const s = spotListe.find((x) => x.id === r.id);
    log(`  ${r.id} | ${r.animationTrigger} | ${r.type} | ${r.animationState} | x=${r.location && r.location.x.toFixed(4)} y=${r.location && r.location.y.toFixed(4)} | ${s ? (sicht(s) ? 'GEZEIGT' : 'verdeckt') : 'gefiltert'}`);
  }
}
// Verdeckung: die AVE liefert nur 2D-Positionen. Aus der Lage der Türen (und Klappe) zueinander wird
// die Blickrichtung der Kamera geschätzt (ungefähres Fahrzeugmodell, schwache Perspektive, Kamera
// über Griffhöhe). Türpunkte nur zeigen, wenn ihre Seitenfläche zur Kamera zeigt, die Klappe nur von hinten.
// Fahrzeugkoordinaten: X nach vorn, Y nach links, Meter ab Fahrzeugmitte.
const MODELL = { FL: [0.25, 0.93], RL: [-0.75, 0.93], FR: [0.25, -0.93], RR: [-0.75, -0.93], TRUNK: [-2.3, 0] };
function spotBlick(punkte, aspekt) {   // punkte: {FL:{x,y},...} → d (Kamerablick in Fahrzeugkoordinaten) oder null
  const P = Object.keys(MODELL).filter((k) => punkte[k]);
  if (P.length < 3) return null;
  // Kleinste Quadrate: [X Y 1] * [m] = bild
  const A = P.map((k) => [MODELL[k][0], MODELL[k][1], 1]);
  const lsq = (b) => {
    const AtA = [[0,0,0],[0,0,0],[0,0,0]], Atb = [0,0,0];
    A.forEach((r, i) => { for (let a = 0; a < 3; a++) { Atb[a] += r[a] * b[i]; for (let c = 0; c < 3; c++) AtA[a][c] += r[a] * r[c]; } });
    return loese3(AtA, Atb);
  };
  const rx = lsq(P.map((k) => punkte[k].x * aspekt)), ry = lsq(P.map((k) => punkte[k].y));
  if (!rx || !ry) return null;
  const p = rx[0]**2 + rx[1]**2, q = ry[0]**2 + ry[1]**2, c = rx[0]*ry[0] + rx[1]*ry[1];
  const A2 = p*q - c*c, B2 = -(p + q);
  let k;
  if (Math.abs(A2) < 1e-12) k = 1 / (p + q);
  else { const disk = B2*B2 - 4*A2; if (disk < 0) return null; k = (-B2 - Math.sqrt(disk)) / (2*A2); }
  if (!(k > 0)) return null;
  const s = Math.sqrt(k);
  const u0 = Math.sqrt(Math.max(0, 1 - p*k)), v0 = Math.sqrt(Math.max(0, 1 - q*k));
  const sg = c > 0 ? -1 : 1;                   // u*v = -c*k
  // Zwei Lösungen (Kippbild). Kamera schaut von oben: die Bild-Abwärtsrichtung zeigt in der Welt nach unten (r2.z < 0)
  const z = sg > 0 ? -1 : 1;
  const r1 = [rx[0]*s, rx[1]*s, z*u0], r2 = [ry[0]*s, ry[1]*s, z*sg*v0];
  const d = [r1[1]*r2[2] - r1[2]*r2[1], r1[2]*r2[0] - r1[0]*r2[2], r1[0]*r2[1] - r1[1]*r2[0]];
  d.abb = { rx, ry, aspekt, rxz: r1[2] / s, ryz: r2[2] / s };   // Abbildung Fahrzeug → Bild (z = Höhe über Griff)
  return d;
}
// Bildpunkt zurück auf die Fahrzeugebene (Griffhöhe): ungefähre Lage eines beliebigen Spots am Auto
function spotAufAuto(abb, p) {
  const { rx, ry, aspekt } = abb;
  const u = p.x * aspekt - rx[2], v = p.y - ry[2];
  const det = rx[0] * ry[1] - rx[1] * ry[0];
  if (Math.abs(det) < 1e-9) return null;
  return [(u * ry[1] - v * rx[1]) / det, (rx[0] * v - ry[0] * u) / det];   // [X nach vorn, Y nach links]
}
// Punkt am Auto (X vorn, Y links, Z über Griffhöhe) → Bildpunkt 0…1
function spotInsBild(abb, [X, Y, Z]) {
  const { rx, ry, aspekt, rxz, ryz } = abb;
  const x = (rx[0] * X + rx[1] * Y + rx[2] + rxz * Z) / aspekt, y = ry[0] * X + ry[1] * Y + ry[2] + ryz * Z;
  return { x: spots.spiegeln ? 1 - x : x, y };
}
// Dach-Animation des geladenen Fahrzeugs (aus AVEListAnimations) und ihr Zustand
let dachAnim = null, dachOffen = false;
async function dachPruefen() {
  dachAnim = null; dachOffen = false;
  if (!(spots.dach || []).length) return;
  try {
    const liste = JSON.parse(await aveSend('AVEListAnimations', {}, true))[0].data.animations || [];
    const da = spots.dach.map((id) => liste.find((a) => a.animationId === id)).find(Boolean);
    if (da) { dachAnim = da.animationId; dachOffen = da.state !== 'initial'; log(`Dach-Spot: ${dachAnim}`); }
  } catch (e) { log(`Dach-Spot: Animationen nicht lesbar – ${e.message}`); }
}
function loese3(M, b) {
  const m = M.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let piv = i; for (let j = i + 1; j < 3; j++) if (Math.abs(m[j][i]) > Math.abs(m[piv][i])) piv = j;
    if (Math.abs(m[piv][i]) < 1e-12) return null;
    [m[i], m[piv]] = [m[piv], m[i]];
    for (let j = 0; j < 3; j++) if (j !== i) { const f = m[j][i] / m[i][i]; for (let c = i; c < 4; c++) m[j][c] -= f * m[i][c]; }
  }
  return [m[0][3]/m[0][0], m[1][3]/m[1][1], m[2][3]/m[2][2]];
}
const spotSicht = { L: false, R: false, hinten: false, vorn: false };
let spotLetzterBlick = null;
// Heckklappe nur bei genauem Namen – "FrontTrunk" (Frunk) sitzt vorn und darf nicht als Heckklappe zählen
const istKofferraum = (t) => aktionen.kofferraum.includes(t) || /^(trunk|tailgate)$/i.test(t || '');
// Fläche eines Spots aus seinem Namen, soweit eindeutig: L, R, hinten, vorn – sonst null
function spotFlaeche(s) {
  const t = `${s.trigger || ''} ${s.id || ''}`;
  const tuer = /door.*[FR]([LR])$/i.exec(s.trigger || '');
  if (tuer) return tuer[1].toUpperCase();
  if (istKofferraum(s.trigger)) return 'hinten';
  if (/front.?trunk|frunk|hood|bonnet/i.test(t)) return 'vorn';
  if (/roof|pano|sunroof|schiebe|dach/i.test(t)) return 'oben';   // Panoramadach: von außen praktisch immer sichtbar
  if (/right/i.test(t)) return 'R';
  if (/left/i.test(t)) return 'L';
  if (/seat.*rear|rear.*seat/i.test(t)) return 'hinten';   // Rücksitze: durch die Heckklappe
  return null;
}
function spotSichtbarkeit(alle) {
  const bild = (s) => (spots.spiegeln ? { x: 1 - s.x, y: s.y } : { x: s.x, y: s.y });
  // Für die Blickrichtung nur geschlossene, ruhende Türen und Klappe: offene stehen nicht mehr an ihrer Modellposition
  const punkte = {};
  const schluessel = (s) => { const m = /door.*([FR])([LR])$/i.exec(s.trigger || ''); return m ? (m[1] + m[2]).toUpperCase() : (istKofferraum(s.trigger) ? 'TRUNK' : null); };
  for (const s of alle) {
    if (s.zustand !== 'Initial' || spotAnimiert(s.trigger)) continue;
    const k = schluessel(s);
    if (k && !punkte[k]) punkte[k] = bild(s);
  }
  // Weniger als 3 geschlossene Punkte (mehrere Türen/Klappen offen): offene, ruhende dazunehmen.
  // Ungenauer, aber besser als die letzte Blickrichtung einzufrieren – sonst bleibt eine Seite verdeckt.
  if (Object.keys(punkte).length < 3) for (const s of alle) {
    if (spotAnimiert(s.trigger)) continue;
    const k = schluessel(s);
    if (k && !punkte[k]) punkte[k] = bild(s);
  }
  const b = display().bounds;
  let d = spotBlick(punkte, b.width / b.height);
  if (d) spotLetzterBlick = d; else d = spotLetzterBlick;   // z. B. alle Türen offen: letzte bekannte Blickrichtung
  // Hysterese: erst ab deutlich zugewandt zeigen, erst ab fast seitlich wieder ausblenden
  const an = -spots.sichtAn, aus = -spots.sichtAus;
  const neu = (alt, wert) => (wert < an ? true : wert > aus ? false : alt);   // wert = Normale · Blick (< 0 = zugewandt)
  if (d) {
    spotSicht.L = neu(spotSicht.L, d[1]); spotSicht.R = neu(spotSicht.R, -d[1]);
    spotSicht.hinten = neu(spotSicht.hinten, -d[0]); spotSicht.vorn = neu(spotSicht.vorn, d[0]);
  }
  return (s) => {
    if (!spots.verdecken) return true;
    if (!d) return false;                              // keine Aussage möglich → lieber nichts zeigen
    const f = spotFlaeche(s);
    if (f === 'oben') return true;
    if (f) return spotSicht[f];
    // Unbekannte Spots: Lage am Auto aus dem Bildpunkt schätzen, dann gilt die Fläche, auf der er sitzt
    const xy = spotAufAuto(d.abb, bild(s));
    if (!xy) return false;
    const [X, Y] = xy;
    if (Math.abs(Y) / 0.93 >= Math.abs(X) / 2.3) return Y > 0 ? spotSicht.L : spotSicht.R;
    return X < 0 ? spotSicht.hinten : spotSicht.vorn;
  };
}
// Kamera in Bewegung (Auto-Drehung, Kamerafahrt nach dem Laden)? Dann Punkte weg, bis es ruhig ist.
let spotVorher = new Map(), spotRuhig = 0;
function spotBewegung(liste) {
  let max = 0;
  for (const s of liste) {
    if (spotAnimiert(s.trigger)) continue;          // bewegt sich, weil die Tür aufgeht – nicht die Kamera
    const v = spotVorher.get(s.id); if (v) max = Math.max(max, Math.hypot(s.x - v.x, s.y - v.y)); else max = Infinity; }
  spotVorher = new Map(liste.map((s) => [s.id, { x: s.x, y: s.y }]));
  spotRuhig = max > spots.ruheSchwelle ? 0 : spotRuhig + 1;
  return spotRuhig >= spots.ruheAbfragen;
}
const spotZustaende = new Set();
const spotsErlaubt = () => spots.aktiv && aktiv && !laeuft && !aktionLaeuft && !offen.fahren && !geste
  && wins.touch && !wins.touch.isDestroyed() && wins.touch.isVisible();
// Laufende Spot-Animationen: trigger → Ende. Während eine läuft, ist nur dieser Spot gesperrt;
// andere Spots, Farben und Felgen bleiben bedienbar. Fahrzeug, Umgebung und Fahrszene sind gesperrt.
const spotAnim = new Map();
const spotAnimiert = (t) => (spotAnim.get(t) || 0) > Date.now();
const spotAnimLaeuft = () => [...spotAnim.values()].some((t) => t > Date.now());
let lichtLaeuft = false;
const animLaeuft = () => spotAnimLaeuft() || lichtLaeuft;   // Tür-Animation oder Lichtshow
// Während einer Animation ist nur die Fahrzeugwahl gesperrt (und dieselbe Animation, siehe spotTippen).
// Andere Spots, Farben, Felgen, Umgebungen, Leaving Home und Fahrszene bleiben bedienbar.
// Ausnahme: während der Lichtshow ist die Umgebungswalze ohnehin ausgeblendet und gesperrt.
let spotTeilGesperrt = '';
function spotTeilSperre() {
  const fz = animLaeuft() && !laeuft, env = lichtLaeuft && !laeuft;
  const key = `${fz}|${env}`;
  if (key === spotTeilGesperrt) return;
  spotTeilGesperrt = key;
  fe(`fe.setBusy(${fz}, ${JSON.stringify(fz ? 'Animation läuft …' : null)})`, 'models');
  fe(`fe.setBusy(${env}, ${JSON.stringify(env ? 'Animation läuft …' : null)})`, 'envs');
  pushAktionen();
}
function spotAnimEnde(trigger) {
  spotAnim.delete(trigger);
  spotTeilSperre();
}
function spotsSenden(liste) {
  fe(`fe.setSpots(${JSON.stringify({ t: Date.now(), groesse: spots.groessePx, treffer: spots.trefferPx, deckkraft: spots.deckkraft, liste })})`, 'touch');
}
async function spotsHolen() {
  if (spotAbfrage) return;
  if (!spotsErlaubt()) { spotRuhig = 0; if (!spotZuletztLeer) { spotsSenden([]); spotZuletztLeer = true; } return; }
  spotAbfrage = true;
  const t0 = Date.now();
  try {
    // Eigene Abfrage ohne Log: läuft mehrmals pro Sekunde
    const r = await fetch(ave.url, { method: 'POST', headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(2000),
      body: JSON.stringify([{ meta: { name: 'AVEGetAnimationSpots', type: 'REQUEST', lastUpdate: true }, data: {} }]) });
    const antwort = JSON.parse(await r.text());
    const roh = (Array.isArray(antwort) ? antwort : [antwort]).map((a) => a && a.data && a.data.animationSpots).find(Array.isArray) || [];
    const ohne = spots.ohne ? new RegExp(spots.ohne, 'i') : null;
    const alle = roh.filter((s) => s && s.location && s.animationTrigger && !(ohne && ohne.test(s.id)))
      .map((s) => ({ id: s.id, trigger: s.animationTrigger, zustand: s.animationState, x: s.location.x, y: s.location.y }));
    spotRoh = roh;
    const ruhig = spotBewegung(alle);
    const sichtbar = spotSichtbarkeit(alle);
    if (dachAnim && spotLetzterBlick && !alle.some((s) => s.trigger === dachAnim)) {   // eigener Dach-Spot
      const p = spotInsBild(spotLetzterBlick.abb, spots.dachPunkt);
      alle.push({ id: 'Dach', trigger: dachAnim, zustand: dachOffen ? 'offen' : 'Initial', x: p.x, y: p.y, eigen: true });
    }
    spotListe = alle;                                   // für Tipp und Leerlauf: alle, auch verdeckte
    const zeigen = ruhig ? alle.filter((s) => sichtbar(s) && s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1) : [];
    // Neue Zustandsnamen einmal protokollieren (z. B. wie "offen" heißt)
    for (const s of spotListe) if (!spotZustaende.has(s.zustand)) { spotZustaende.add(s.zustand); log(`Spots: Zustand "${s.zustand}" gesehen (${s.id})`); }
    // Während der Abfrage kann eine Geste oder ein Laden begonnen haben – dann nichts zeigen
    if (spotsErlaubt()) { spotsSenden(zeigen.map((s) => ({ ...s, t0, laeuft: spotAnimiert(s.trigger) }))); spotZuletztLeer = !zeigen.length; }
  } catch (e) {
    if (!spotZuletztLeer) { spotsSenden([]); spotZuletztLeer = true; }
  } finally { spotAbfrage = false; }
}
async function spotTippen(id) {
  const s = spotListe.find((x) => x.id === id);
  if (!s || !aktiv || offen.fahren) return;
  if (laeuft || aktionLaeuft) { log(`Spot ${id}: verworfen – es lädt noch`); return; }
  if (spotAnimiert(s.trigger)) { log(`Spot ${id}: verworfen – Animation läuft noch`); return; }
  const oeffnen = s.zustand === 'Initial';
  const trigger = s.trigger;
  spotAnim.set(trigger, Date.now() + aktionen.dauerMs);
  spotTeilSperre();
  setTimeout(() => { if ((spotAnim.get(trigger) || 0) <= Date.now() + 100) spotAnimEnde(trigger); }, aktionen.dauerMs + 50);   // verlängerte Sperre (Dach) nicht vorzeitig aufheben
  log(`Spot: ${id} (${trigger}) ${oeffnen ? 'öffnen' : 'schließen'}`);
  try {
    await sessionSicher();
    const antwort = await aveSend('AVETriggerAnimations', { carId: 'current', animationIds: [trigger], direction: oeffnen ? aktionen.vor : aktionen.zurueck, skip: false }, true);
    if (/"type"\s*:\s*"ERROR"/.test(antwort)) { log(`Spot ${id}: AVE lehnt ab`); spotAnimEnde(trigger); pushAktionen(); return; }
    // Die AVE nennt die tatsächliche Länge (Dach: 10 s) – so lange gesperrt, sonst kommt "currently animating"
    const len = Number((/"animationLength"\s*:\s*([\d.]+)/.exec(antwort) || [])[1]);
    if (len > 0) {
      const bis = Date.now() + len * 1000 + 300;
      if (bis > (spotAnim.get(trigger) || 0)) { spotAnim.set(trigger, bis); setTimeout(() => { if ((spotAnim.get(trigger) || 0) <= Date.now() + 100) spotAnimEnde(trigger); }, bis - Date.now() + 50); }
    }
    // Kofferraum-Knopf mitführen (gleiche Animation). Einzelne Türen ändern den Türen-Knopf nicht.
    if (aktionen.kofferraum.includes(trigger)) offen.kofferraum = oeffnen;
    s.zustand = oeffnen ? 'offen' : 'Initial';   // bis zur nächsten Abfrage
    if (s.eigen) dachOffen = oeffnen;            // eigener Spot: die AVE meldet keinen Zustand
  } catch (e) {
    const art = fehlerArt(e);
    if (art !== 'timeout') {
      log(`FEHLER Spot ${id}: ${e.message} (${art})`);
      if (art === 'verbindung') sessionOk = false;
      spotAnimEnde(trigger);                      // nichts läuft – sofort wieder frei
    }
  }
  pushAktionen();
}

// ---------- Lichtshow: Leaving Home / Coming Home ----------
async function kameraWaehlen(id) {
  if (!id) return;
  // Format wie im EventInterface mitgeschnitten
  const L = aktionen.licht;
  const text = await aveSend('AVESelectCamera', { cameraId: id, transition: { movementMode: L.bewegung || 'set', transitionDuration: Number(L.flugSek) || 0 } }, true);
  if (/"type"\s*:\s*"ERROR"/.test(text)) log(`Lichtshow: Kamera ${id} – AVE meldet Fehler`);
}
async function lichtSchritte(liste) {
  for (const sch of liste || []) {
    if (sch.warten) { await sleep(sch.warten); continue; }
    if (!sch.anim) continue;
    const text = await aveSend('AVETriggerAnimations', { carId: 'current', animationIds: [sch.anim],
      direction: sch.dir === 'reverse' ? aktionen.zurueck : aktionen.vor, skip: !!sch.skip }, true);
    if (sch.skip) { await sleep(150); continue; }
    let sek = 0;
    try { sek = Number(JSON.parse(text)[0].data.animationLength) || 0; } catch {}
    await sleep(Math.min(15000, sek * 1000 + 300));
  }
}
// Zustand aller Lichtanimationen (Kategorie "Lights") – vor der Show merken, danach genau so wiederherstellen
async function lichtZustand() {
  const text = await aveSend('AVEListAnimations', {}, true);
  const z = {};
  try {
    for (const a of JSON.parse(text)[0].data.animations || [])
      if (a.category === 'Lights' && a.animationId) z[a.animationId] = a.state === 'initial' ? 'initial' : 'animated';
  } catch {}
  return z;
}
async function lichtWiederherstellen(vorher) {
  if (!vorher || !Object.keys(vorher).length) return;
  const jetzt = await lichtZustand();
  for (const [id, soll] of Object.entries(vorher)) {
    if (jetzt[id] === soll) continue;
    log(`Lichtshow: ${id} zurück auf ${soll}`);
    await aveSend('AVETriggerAnimations', { carId: 'current', animationIds: [id],
      direction: soll === 'initial' ? aktionen.zurueck : aktionen.vor, skip: true }, true);
    await sleep(120);
  }
}
async function lichtshow(was, grund) {
  const L = aktionen.licht;
  if (!L || !L[was] || !aktiv || offen.fahren) return false;
  if (laeuft || aktionLaeuft || lichtLaeuft) { log(`${grund}: ${was} verworfen – es läuft noch etwas`); pushAktionen(); return false; }
  // Nur Fahrzeug, Umgebung und die Knöpfe oben sperren – Farben, Felgen und Spots bleiben bedienbar
  lichtLaeuft = true;
  spotTeilSperre();
  log(`${grund}: Lichtshow ${was}`);
  let vorher = null;
  try {
    await sessionSicher();
    vorher = await lichtZustand();
    const flugMs = (Number(L.flugSek) || 1) * 1000;
    umgebungFaden(false, flugMs);                       // Umgebungswalze blendet mit dem Kameraflug aus
    if (L.kamera) { await kameraWaehlen(L.kamera); await sleep(L.kameraWartenMs || 0); }
    await lichtSchritte(L[was]);
    await sleep(L.nachlaufMs || 0);
    await lichtWiederherstellen(vorher);
    await lichtSchritte(L.danach);
    if (L.zurueckKamera) await kameraWaehlen(L.zurueckKamera);
  } catch (e) {
    log(`FEHLER Lichtshow ${was}: ${e.message} (${fehlerArt(e)})`);
    if (fehlerArt(e) === 'verbindung') sessionOk = false;
  } finally {
    umgebungFaden(true, (Number(L.flugSek) || 1) * 1000);   // und mit dem Rückflug wieder ein
    lichtLaeuft = false;
    spotTeilSperre();
    pushAktionen();
  }
  return true;
}

// Neues Fahrzeug (auch Farb-/Felgenwechsel) wird geschlossen geladen
function aktionenZuruecksetzen() { offen.tueren = false; offen.kofferraum = false; spotListe = []; spotAnim.clear(); spotTeilGesperrt = ''; pushAktionen(); }
// Fahrszene: alle Walzen und die Symbolleiste aus, die Touch-Fläche fängt jede Berührung zum Beenden
function fahrtAnsicht(an) {
  fe(`fe.setTouch(${JSON.stringify({ fahrt: an })})`, 'touch');
  if (an) for (const part of ['models', 'colors', 'wheels', 'envs', 'actions']) { const w = wins[part]; if (w && !w.isDestroyed()) w.hide(); }
  else { if (wins.models && !wins.models.isDestroyed()) wins.models.showInactive(); pushOptionen(); pushUmgebungen(); pushAktionen(); }
  zeigeTouch();
  ebenen();
}
// Vor jeder Auswahl (Fahrzeug, Farbe, Felge, Umgebung) die Fahrszene beenden
async function fahrszeneVorher(grund) {
  if (!offen.fahren) return true;
  return aktion('fahren', true, `${grund}: vorher`);
}

// ---------- Fahrzeug aus der Zwischenablage übernehmen ----------
// Im EventInterface ein Fahrzeug laden, in den DevTools die Anfrage AVESelectCar
// per "Copy as fetch" kopieren, dann Strg+Alt+Shift+P. Geht auch mit der reinen
// Payload oder einer Liste von PR-Codes.
function prAusText(text) {
  const t = String(text || '').replace(/\\"/g, '"');
  const m = t.match(/"PrStringList"\s*:\s*\[([^\]]*)\]/);
  const pr = m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).filter(Boolean) : prListe(t);
  const rev = (t.match(/"ModelRevision"\s*:\s*"([^"]*)"/) || [])[1] || null;
  // Plausibel: Modellcode an Stelle 2, Modelljahr an Stelle 3
  if (pr.length < 5 || !/^\d{4}$/.test(pr[2] || '')) return null;
  return { pr, rev };
}

function uebernehmeAusZwischenablage() {
  const r = prAusText(clipboard.readText());
  if (!r) return hinweis('Zwischenablage enthält keinen PR-String');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(fzFile, 'utf8')); } catch (e) { return hinweis(`fahrzeuge.json nicht lesbar: ${e.message}`); }
  const liste = Array.isArray(raw) ? raw : (raw.fahrzeuge = raw.fahrzeuge || []);
  const schluessel = r.pr.join(' ');
  const doppelt = liste.find((f) => prListe(f.pr).join(' ') === schluessel);
  if (doppelt) return hinweis(`schon vorhanden: ${doppelt.id}`);
  const basis = `${r.pr[1]}-${r.pr[3]}`;          // Modellcode-Farbe, z. B. G9BANA-5L5L
  let id = basis, n = 2;
  while (liste.some((f) => f.id === id)) id = `${basis}-${n++}`;
  const neu = { id, name: `${r.pr[1]} ${r.pr[3]}`, pr: schluessel };
  if (r.rev && r.rev !== ave.modelRevision) neu.modelRevision = r.rev;
  liste.push(neu);
  fs.writeFileSync(fzFile, JSON.stringify(Array.isArray(raw) ? liste : raw, null, 2), 'utf8');
  log(`Übernommen: ${id} (${r.pr.length} PR) – Name in fahrzeuge.json anpassen`);
  ladeFahrzeuge();
  aktiv = id;   // die AVE zeigt gerade genau dieses Fahrzeug – B nimmt dann das richtige Bild auf
  const neuF = fahrzeuge.find((x) => x.id === id);
  if (neuF) [aktivFarbe, aktivFelge] = [grundFarbe(neuF), grundFelge(neuF)];
  push();
  hinweis(`übernommen: ${id}`);
}

// Kurze Meldung oben in der Leiste (sperrt 2,5 s)
function hinweis(text) {
  log(`Hinweis: ${text}`);
  if (laeuft) return;
  sperre(true, text);
  setTimeout(() => { if (!laeuft) sperre(false); }, 2500);
}

const startId = () => (fahrzeuge.find((f) => f.id === cfg.startFahrzeug) || fahrzeuge[0] || {}).id || null;

// ---------- Frontend ----------
const wins = {};         // models, colors, wheels
let aktiv = null;       // id des zuletzt erfolgreich an die AVE geschickten Fahrzeugs
let aktivFarbe = null, aktivFelge = null;
let laeuft = false;
let letzterFehler = null;

function fe(code, nur) {
  for (const [part, w] of Object.entries(wins)) {
    if (nur ? part !== nur : part === 'touch') continue;   // Touch-Fläche hat keine Walze
    if (w && !w.isDestroyed()) w.webContents.executeJavaScript(`if (window.fe) { ${code} }`).catch(() => {});
  }
}
// Fahrzeugtypen für den Filter über der Walze – aus dem Modellnamen. Ein Modell kann mehreren angehören (RS 3 Sportback).
function fahrzeugTypen(f) {
  const n = `${f.langName || ''} ${f.name || ''}`;
  const t = [];
  if (/\bSUV\b/i.test(n)) t.push('suv');
  if (/Limousine/i.test(n)) t.push('limo');
  if (/Sportback/i.test(n)) t.push('sportback');
  if (/Avant|allroad/i.test(n)) t.push('avant');
  if (/(^|\s)RS(\s|\d)/.test(n)) t.push('rs');
  return t;
}
function push() {
  const list = fahrzeuge.map((f) => ({ id: f.id, name: f.name, img: f.img, typ: fahrzeugTypen(f) }));
  fe(`fe.setModels(${JSON.stringify(list)}, ${JSON.stringify(aktiv)}, ${JSON.stringify(showcar ? { name: showcar.name, an: showAktiv } : null)})`, 'models');
  pushOptionen();
}
// Farb- und Felgenwalze: nur sichtbar, wenn das aktive Fahrzeug Katalogdaten hat
function pushOptionen() {
  const f = fahrzeuge.find((x) => x.id === aktiv);
  const karte = (o, sel) => ({ code: o.code, name: o.name, img: katBild(o.img), checked: o.code === sel });
  // Audi exclusive: Kachel öffnet in der Walze eine Unterauswahl mit den konkreten Farben
  const farbKarte = (o) => {
    const k = karte(o, aktivFarbe);
    if (o.exklusiv && o.exklusiv.length) {
      k.unter = o.exklusiv.map((x) => ({ code: x.code, name: x.name, img: katBild(x.img), checked: x.code === aktivFarbe }));
      k.checked = String(aktivFarbe || '').startsWith(o.code + ':');
      k.name = 'Audi exclusive';
      if (!k.img && k.unter[0]) k.img = k.unter[0].img;
    }
    return k;
  };
  // Konkrete Exklusivfarben mit eigenem Code (z. B. Q0A2 „… Audi exclusive Brillantschwarz“) gehören in die
  // Exclusive-Walze, nicht in die Serie: sie werden zu einer eigenen Platzhalter-Kachel zusammengefasst.
  const istExklDirekt = (o) => /^[QO]0/i.test(o.code || '') && !/^(Q0Q0|O0O0)$/i.test(o.code) && !(o.exklusiv && o.exklusiv.length);
  const alle = f ? f.farben : [];
  const direkt = alle.filter(istExklDirekt);
  const colors = alle.filter((o) => !istExklDirekt(o)).map(farbKarte);
  if (direkt.length) {
    const unter = direkt.map((o) => ({ code: o.code, name: o.name.replace(/^Individuallackierungen Audi exclusive\s*/i, 'Audi exclusive ').trim(), img: katBild(o.img), checked: o.code === aktivFarbe }));
    colors.push({ code: 'exkl-direkt', name: 'Audi exclusive', img: unter[0].img, checked: unter.some((u) => u.checked), unter });
  }
  const wheels = f ? f.felgen.map((o) => karte(o, aktivFelge)) : [];
  const zeigen = (part, n) => { const w = wins[part]; if (!w || w.isDestroyed()) return; if (n > 1 && !offen.fahren) w.showInactive(); else w.hide(); };
  zeigen('colors', colors.length); zeigen('wheels', wheels.length);
  const o = { colors, wheels, sel: { color: aktivFarbe, wheel: aktivFelge } };
  fe(`fe.setOptions(${JSON.stringify(o)})`, 'colors');
  fe(`fe.setOptions(${JSON.stringify(o)})`, 'wheels');
}
const sperre = (on, text) => { fe(`fe.setBusy(${!!on}, ${JSON.stringify(text || null)})`); setTimeout(pushAktionen, 0); };

async function ladeFahrzeug(id, grund, wahl = {}) {
  const f = fzFinden(id);
  if (!f) return log(`${grund}: unbekanntes Fahrzeug "${id}"`);
  if (laeuft) return log(`${grund}: ${f.name} verworfen – es lädt noch`);
  if (!(await fahrszeneVorher(grund))) return false;
  const farbe = wahl.farbe || grundFarbe(f), felge = wahl.felge || grundFelge(f);
  const pr = prFuer(f, farbe, felge);
  const grundzustand = farbe === grundFarbe(f) && felge === grundFelge(f);
  laeuft = true;
  sperre(true, 'wird geladen …');
  log(`${grund}: lade ${f.name}${farbe ? ` · Farbe ${farbe}` : ''}${felge ? ` · Felge ${felge}` : ''} (${pr.length} PR)`);
  const vorher = [aktiv, aktivFarbe, aktivFelge];
  let ok = false;
  try {
    await sessionSicher();
    await aveSend('AVESelectCar', {
      PrStringList: pr,
      LoadingScreen: ave.loadingScreen,
      ConsumptionData: f.consumptionData,
      ModelRevision: f.modelRevision,
    }, true, ave.ladeTimeoutMs);
    [aktiv, aktivFarbe, aktivFelge] = [f.id, farbe, felge];
    ok = true;
    pushOptionen();
    aktionenZuruecksetzen();
    dachPruefen();
    await sleep(ave.nachlaufMs);
    if (!f.img && bildCfg.auto && grundzustand) {   // Vorschaubild nur von der Grundausstattung
      await sleep(bildCfg.wartenMs);     // Ladebildschirm ausblenden lassen
      await bildAufnehmen(f, 'Automatik').catch((e) => log(`Bild ${f.name}: ${e.message}`));
      push();
    }
  } catch (e) {
    const art = fehlerArt(e);
    if (art === 'timeout') {
      // Keine Antwort, aber die AVE hat den Auftrag sehr wahrscheinlich angenommen.
      // NICHT wiederholen und NICHT neu anmelden – das hat sie in den Idle-Modus geworfen.
      log(`WARNUNG ${f.name}: keine Antwort nach ${ave.ladeTimeoutMs / 1000}s – gilt als geladen`);
      [aktiv, aktivFarbe, aktivFelge] = [f.id, farbe, felge];
      ok = true;
      pushOptionen();
    } else {
      log(`FEHLER ${f.name}: ${e.message} (${art})`);
      if (art === 'verbindung') { sessionOk = false; autostartSicherstellen('Verbindung verloren'); }
      [aktiv, aktivFarbe, aktivFelge] = vorher;
      letzterFehler = art;
    }
  } finally {
    laeuft = false;
    sperre(false);
  }
  // Walze auf den tatsächlichen Stand zurückstellen. Die Walze nimmt das erst
  // 4 s nach der letzten Berührung an, deshalb verzögert.
  if (!ok) setTimeout(push, 4200);
  return ok;
}

// Letzte echte Bedienung am Kiosk (Touch auf dem Auto, Walzen, Knöpfe, Spots). Die Windows-Leerlaufzeit
// war dafür unzuverlässig: nachts lief kein einziger Wachhalte-Befehl, obwohl niemand am Tisch war.
let letzteBedienung = Date.now();
const ruheSek = () => Math.floor((Date.now() - letzteBedienung) / 1000);
function onFrontend(part, json) {
  let m; try { m = JSON.parse(json); } catch { return; }
  if (m.type === 'select' || m.type === 'touch') letzteBedienung = Date.now();
  if (part === 'touch') {
    if (m.type === 'ready') fe(`fe.setTouch(${JSON.stringify({ schwellePx: touchCfg.schwellePx, zoomSchrittPx: touchCfg.zoomSchrittPx, fahrt: offen.fahren })})`, 'touch');
    if (m.type === 'touch' && m.cmd === 'fahrtEnde') { aktion('fahren', true, 'Berührung'); return; }
    if (m.type === 'touch' && m.cmd === 'spot') { spotTippen(m.id); return; }
    if (m.type === 'touch') touchBefehl(m);
    return;
  }
  if (m.type === 'ready') { log(`Frontend ${part} bereit`); push(); pushUmgebungen(); pushAktionen(); if (laeuft) sperre(true, 'wird geladen …'); }
  if (m.type === 'diag') { if (cfg.diagnose) log(`[Diagnose ${part}] ${JSON.stringify(m)}`); return; }   // "diagnose": true in config.json
  if (m.type === 'select') log(`[${part}] Auswahl empfangen: ${m.kind} ${m.value}`);
  if (m.type !== 'select') return;
  if (m.kind === 'show') {
    showcarWunsch(!!m.value, 'Showcar');
    return;
  }
  if ((m.kind === 'model' && animLaeuft()) || (m.kind === 'env' && lichtLaeuft)) {   // Fahrzeug: während jeder Animation gesperrt
    log(`[${part}] ${m.kind} ${m.value} verworfen – Animation läuft`);
    setTimeout(m.kind === 'model' ? push : pushUmgebungen, 4200);
    return;
  }
  if (m.kind === 'model') ladeFahrzeug(m.value, 'Auswahl');
  if (m.kind === 'color' && aktiv) ladeFahrzeug(aktiv, 'Farbe', { farbe: m.value, felge: aktivFelge }).then((ok) => !ok && setTimeout(pushOptionen, 4200));
  if (m.kind === 'env') ladeUmgebung(m.value, 'Auswahl');
  if (m.kind === 'aktion') aktion(m.value);
  if (m.kind === 'wheel' && aktiv) ladeFahrzeug(aktiv, 'Felge', { farbe: aktivFarbe, felge: m.value }).then((ok) => !ok && setTimeout(pushOptionen, 4200));
}

// ---------- Fenster ----------
const display = () => screen.getAllDisplays()[cfg.bildschirm || 0] || screen.getPrimaryDisplay();
function bounds(part) {
  const b = display().bounds;
  if (part === 'touch') return { ...b };
  const px = (v) => Math.round(v <= 1 ? b.width * v : v);
  if (part === 'models') {
    const w = px(leiste.breite);
    return { x: leiste.seite === 'rechts' ? b.x + b.width - w : b.x, y: b.y, width: w, height: b.height };
  }
  if (part === 'actions') {
    const n = Math.max(1, knopfZahl());
    const w = Math.round(aktionen.breite || n * 58 + (n - 1) * 22 + 40), h = Math.round(aktionen.hoehe);
    return { x: b.x + Math.round((b.width - w) / 2), y: b.y, width: w, height: h };
  }
  if (part === 'envs') {
    const w = px(unten.breite), h = Math.round(unten.hoehe);
    return { x: b.x + Math.round((b.width - w) / 2), y: b.y + b.height - h, width: w, height: h };
  }
  const wf = px(rechts.felgen), wc = px(rechts.farben);
  if (part === 'wheels') return { x: b.x + b.width - wf, y: b.y, width: wf, height: b.height };
  return { x: b.x + b.width - wf - wc, y: b.y, width: wc, height: b.height };   // colors links neben den Felgen
}

function createWindow(part) {
  const win = new BrowserWindow({
    ...bounds(part),
    frame: false,
    transparent: !!leiste.transparent,
    backgroundColor: leiste.transparent ? '#00000000' : '#000000',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false,
    focusable: !!leiste.fokussierbar,   // AVE behält den Fokus und rendert nicht gedrosselt
    alwaysOnTop: true,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  const wc = win.webContents;
  wc.on('console-message', (e) => {
    const msg = e.message, lvl = e.level;
    if (typeof msg !== 'string') return;
    if (msg.startsWith('KIOSK_FE ')) onFrontend(part, msg.slice(9));
    else if (lvl === 'error' || lvl === 3) log(`[Frontend ${part}] ${msg}`);
  });
  wc.on('render-process-gone', () => setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 1000));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.setVisualZoomLevelLimits(1, 1).catch(() => {});
  wc.loadFile(path.join(baseDir, part === 'touch' ? 'touch.html' : 'frontend.html'), { query: { part } });
  if (part === 'models') win.once('ready-to-show', () => win.showInactive());   // Farben/Felgen erst, wenn es welche gibt
  if (part === 'touch') win.once('ready-to-show', zeigeTouch);                   // erst, wenn der Maus-Helfer läuft
  screen.on('display-metrics-changed', () => !win.isDestroyed() && win.setBounds(bounds(part)));
  wins[part] = win;
}

// UE5 im Vollbild schiebt sich gern nach vorn: regelmäßig nach oben holen, ohne Fokus.
// Reihenfolge zählt: die Touch-Fläche zuerst (liegt dann unter den Walzen), danach die Walzen.
function ebenen() {
  for (const part of ['touch', 'envs', 'actions', 'models', 'colors', 'wheels']) {
    const w = wins[part];
    if (w && !w.isDestroyed() && w.isVisible()) { w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); }
  }
}

// ---------- Touch → Maus ----------
let helfer = null, helferBereit = false, helferPuffer = '', helferEnde = false, helferFehlstarts = 0;
const syncWarten = new Map();
let syncNr = 0, touchAn = touchCfg.aktiv;
function helferStarten() {
  if (!touchCfg.aktiv || helfer || helferEnde) return;
  let befehl, argumente;
  if (touchCfg.helfer) { befehl = touchCfg.helfer.befehl; argumente = touchCfg.helfer.argumente || []; }
  else {
    if (process.platform !== 'win32') return log('Touch als Maus: nur unter Windows');
    befehl = 'powershell.exe';
    argumente = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(baseDir, 'tools', 'maus.ps1')];
  }
  try { helfer = spawn(befehl, argumente, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { helfer = null; return log(`Touch als Maus: Helfer startet nicht – ${e.message}`); }
  helfer.stdout.setEncoding('utf8');
  helfer.stdout.on('data', (d) => {
    helferPuffer += d;
    let i;
    while ((i = helferPuffer.indexOf('\n')) >= 0) {
      const z = helferPuffer.slice(0, i).trim();
      helferPuffer = helferPuffer.slice(i + 1);
      if (z === 'bereit') { helferBereit = true; helferFehlstarts = 0; log('Touch als Maus: bereit'); zeigeTouch(); }
      else if (z.startsWith('ok ')) { const f = syncWarten.get(z.slice(3)); if (f) f(); }
    }
  });
  helfer.stderr.on('data', (d) => log(`Maus-Helfer: ${String(d).trim()}`));
  helfer.stdin.on('error', () => {});
  helfer.on('error', (e) => log(`Touch als Maus: Helfer-Fehler – ${e.message}`));
  helfer.on('exit', (code) => {
    if (helferEnde) return;
    if (!helferBereit) helferFehlstarts++;
    log(`Touch als Maus: Helfer beendet (${code}) – Touch geht wieder direkt an die AVE`);
    helfer = null; helferBereit = false; zeigeTouch();
    if (helferFehlstarts >= 3) return log('Touch als Maus: Helfer startet nicht – aufgegeben. tools\\maus.ps1 von Hand testen.');
    setTimeout(helferStarten, 5000);
  });
}
const hs = (z) => { if (helfer && helferBereit) helfer.stdin.write(z + '\n'); };
// Warten, bis der Helfer alles davor ausgeführt hat (höchstens 400 ms)
const hsync = () => new Promise((ok) => {
  if (!helfer || !helferBereit) return ok();
  const id = String(++syncNr);
  const fertig = () => { clearTimeout(t); syncWarten.delete(id); ok(); };
  const t = setTimeout(fertig, 400);
  syncWarten.set(id, fertig);
  hs(`s ${id}`);
});
function zeigeTouch() {
  const w = wins.touch;
  if (!w || w.isDestroyed()) return;
  if ((touchAn && helferBereit) || offen.fahren) { w.setIgnoreMouseEvents(false); zeigerMerken(); w.showInactive(); ebenen(); }
  else w.hide();
}
let durchlaessigAn = false;
function durchlaessig(on, mitWeiterleitung = false) {
  const w = wins.touch;
  if (!w || w.isDestroyed()) return;
  durchlaessigAn = on;
  w.setIgnoreMouseEvents(on, on && mitWeiterleitung ? { forward: true } : undefined);
}
// touch.html liefert Fenster-Koordinaten in DIP, SendInput braucht physische Bildschirm-Pixel
const physisch = (x, y) => {
  const b = wins.touch.getContentBounds();
  const d = { x: b.x + x, y: b.y + y };
  const p = process.platform === 'win32' && screen.dipToScreenPoint ? screen.dipToScreenPoint(d) : d;
  return { x: Math.round(p.x), y: Math.round(p.y) };
};
let touchKette = Promise.resolve(), letzterPunkt = null, rest = { x: 0, y: 0 }, geste = null, gestenLog = 0, mausTimer = null;
// Wo der Zeiger stand, als wir ihn zuletzt selbst bewegt haben. Steht er noch dort, war
// eine gemeldete "Mausbewegung" nur Windows, das die Fläche unter dem Zeiger entdeckt hat.
let ruhePunkt = null;
const zeigerMerken = () => { ruhePunkt = screen.getCursorScreenPoint(); };
const zeigerBewegt = () => { const c = screen.getCursorScreenPoint(); return !ruhePunkt || Math.hypot(c.x - ruhePunkt.x, c.y - ruhePunkt.y) > 3; };
function touchBefehl(m) {
  touchKette = touchKette.then(() => touchAusfuehren(m)).catch((e) => log(`Touch: ${e.message}`));
}
function gesteLoggen() {
  if (!geste) return;
  // Die ersten 20 Gesten nach dem Start immer, danach nur mit "diagnose": true
  if (gestenLog++ < 20 || cfg.diagnose) log(`Touch: ${geste.art}, ${geste.n} Schritte, ${Date.now() - geste.t} ms`);
  geste = null;
}
async function touchAusfuehren(m) {
  if (!helferBereit) return;
  const p = m.x != null ? physisch(m.x, m.y) : null;
  switch (m.cmd) {
    case 'zugStart':        // Maus an den Startpunkt, drücken – dabei durchlässig, damit der Klick die AVE trifft
      clearTimeout(mausTimer);
      geste = { art: 'Drehen', n: 0, t: Date.now() };
      durchlaessig(true);
      hs(`a ${p.x} ${p.y}`);
      await hsync(); await sleep(touchCfg.druckPauseMs);
      hs('d');
      await hsync(); await sleep(touchCfg.druckPauseMs / 2);   // Drücken erst ankommen lassen, dann ziehen
      if (!touchCfg.durchlaessigWaehrendZiehen) durchlaessig(false);
      letzterPunkt = p; rest = { x: 0, y: 0 };
      break;
    case 'zug':
      if (!letzterPunkt) break;
      if (geste) geste.n++;
      if (touchCfg.modus === 'absolut') hs(`a ${p.x} ${p.y}`);
      else {
        rest.x += (p.x - letzterPunkt.x) * touchCfg.faktor;
        rest.y += (p.y - letzterPunkt.y) * touchCfg.faktor;
        const dx = Math.trunc(rest.x), dy = Math.trunc(rest.y);
        rest.x -= dx; rest.y -= dy;
        if (dx || dy) hs(`r ${dx} ${dy}`);
      }
      letzterPunkt = p;
      break;
    case 'zugEnde':
      durchlaessig(true);
      hs('u');
      await hsync();
      durchlaessig(false);
      letzterPunkt = null;
      zeigerMerken();
      gesteLoggen();
      break;
    case 'tipp':
      clearTimeout(mausTimer);
      geste = { art: 'Tipp', n: 0, t: Date.now() };
      durchlaessig(true);
      hs(`a ${p.x} ${p.y}`);
      await hsync(); await sleep(touchCfg.druckPauseMs);
      hs('d');
      await hsync(); await sleep(30);
      hs('u');
      await hsync();
      durchlaessig(false);
      zeigerMerken();
      gesteLoggen();
      break;
    case 'zoomStart':       // Mausrad geht an das Fenster unter dem Zeiger: Zeiger in die Mitte, durchlässig bis zum Ende
      if (!touchCfg.zoom) break;
      clearTimeout(mausTimer);
      geste = { art: 'Zoom', n: 0, t: Date.now() };
      durchlaessig(true);
      hs(`a ${p.x} ${p.y}`);
      break;
    case 'rad':
      if (!touchCfg.zoom || !geste) break;
      geste.n++;
      hs(`w ${(touchCfg.zoomUmkehren ? -1 : 1) * m.n * 120}`);
      break;
    case 'zoomEnde':
      if (!touchCfg.zoom) break;
      await hsync();
      durchlaessig(false);
      zeigerMerken();
      gesteLoggen();
      break;
    case 'maus':            // echte Maus: Fläche durchlässig, solange sie bewegt wird
      if (!touchCfg.mausErkennung || geste || !zeigerBewegt()) break;
      if (!durchlaessigAn) log('Touch: Maus erkannt – Fläche durchlässig');
      durchlaessig(true, true);
      clearTimeout(mausTimer);
      mausTimer = setTimeout(() => { if (!geste) { durchlaessig(false); zeigerMerken(); } }, touchCfg.mausPauseMs);
      break;
  }
}

// ---------- Katalogbilder einmalig herunterladen (braucht Netz) ----------
let importLaeuft = false;
// fahrzeugbilder*.json (vom DCC-Sucher, „Nur Vorschaubilder holen“): Renderbilder nach bilder/fahrzeuge,
// Dateiname = Kurzname ("Q8 SUV S line business e-hybrid.png"). Gleichnamige alte Bilder wandern nach bilder/fahrzeuge/alt.
async function fahrzeugbilderImport() {
  const dateien = fs.readdirSync(baseDir).filter((n) => /^fahrzeugbilder.*\.json$/i.test(n)).map((n) => path.join(baseDir, n))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  if (!dateien.length) return { neu: 0, fehl: 0 };
  const jeName = new Map();
  for (const d of dateien) {
    try { for (const b of JSON.parse(fs.readFileSync(d, 'utf8')).bilder || []) if (b.kurz) jeName.set(b.kurz, b); }   // neuere Datei gewinnt
    catch (e) { log(`FEHLER ${path.basename(d)}: ${e.message}`); }
  }
  fs.mkdirSync(fzBildDir, { recursive: true });
  const altDir = path.join(fzBildDir, 'alt');
  let neu = 0, fehl = 0;
  const stand = Math.max(...dateien.map((d) => fs.statSync(d).mtimeMs));
  for (const b of jeName.values()) {
    const url = b[bildCfg.dccHintergrund] || b.moma || b.standard;
    const stamm = String(b.kurz).replace(/[\\/:*?"<>|]+/g, ' ').trim();
    // schon geholt (Bild jünger als die json): nicht erneut laden
    const da = fs.readdirSync(fzBildDir).find((n) => n.replace(/\.[^.]+$/, '').toLowerCase() === stamm.toLowerCase());
    if (da && fs.statSync(path.join(fzBildDir, da)).mtimeMs >= stand) continue;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const typ = r.headers.get('content-type') || '';
      const ext = /png/.test(typ) ? '.png' : /webp/.test(typ) ? '.webp' : '.jpg';
      const daten = Buffer.from(await r.arrayBuffer());
      // vorhandene Bilder mit gleichem Namen (auch andere Endung) beiseitelegen, sonst wäre die Zuordnung mehrdeutig
      for (const alt of fs.readdirSync(fzBildDir)) {
        if (alt.replace(/\.[^.]+$/, '').toLowerCase() !== stamm.toLowerCase() || !/\.(png|jpe?g|webp)$/i.test(alt)) continue;
        fs.mkdirSync(altDir, { recursive: true });
        fs.renameSync(path.join(fzBildDir, alt), path.join(altDir, `${Date.now()}_${alt}`));
      }
      fs.writeFileSync(path.join(fzBildDir, stamm + ext), daten);
      neu++;
    } catch (e) { fehl++; log(`Vorschaubild ${b.kurz}: ${e.message}`); }
  }
  log(`Vorschaubilder: ${neu} gespeichert in ${fzBildDir}${fehl ? `, ${fehl} Fehler` : ''}`);
  return { neu, fehl };
}
async function katalogImport() {
  if (importLaeuft) return;
  if (!katalogDateien().length) {          // nur Vorschaubilder?
    importLaeuft = true;
    try { const v = await fahrzeugbilderImport(); ladeFahrzeuge(); push(); hinweis(v.neu ? `${v.neu} Vorschaubilder` : 'keine katalog*.json / fahrzeugbilder.json im Ordner'); }
    finally { importLaeuft = false; }
    return;
  }
  importLaeuft = true;
  try {
    const vb = await fahrzeugbilderImport();
    ladeKatalog();
    const urls = new Set();
    for (const e of katalog) for (const o of [...(e.farben || []), ...(e.felgen || [])]) {
      if (o.img) urls.add(o.img);
      for (const x of o.exklusiv || []) if (x.img) urls.add(x.img);   // Audi-exclusive-Farben
    }
    for (const e of katalog) if (e.bild) for (const u of [e.bild.moma, e.bild.standard]) if (u) urls.add(u);   // DCC-Renderbilder
    fs.mkdirSync(katBildDir, { recursive: true });
    const offen = [...urls];
    let neu = 0, da = 0, fehl = 0;
    log(`Katalog-Import: ${offen.length} Bilder`);
    hinweis(`lade ${offen.length} Bilder …`);
    const arbeiter = async () => {
      while (offen.length) {
        const u = offen.pop(), p = katBildPfad(u);
        if (fs.existsSync(p)) { da++; continue; }
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
          neu++;
        } catch (e) { fehl++; log(`Bild ${u}: ${e.message}`); }
      }
    };
    await Promise.all(Array.from({ length: 6 }, arbeiter));
    log(`Katalog-Import fertig: ${neu} neu, ${da} vorhanden, ${fehl} Fehler`);
    bildCache.clear();
    ladeFahrzeuge();
    push();
    hinweis(`Katalog: ${neu + da} Bilder${vb.neu ? `, ${vb.neu} Vorschaubilder` : ''}${fehl + vb.fehl ? `, ${fehl + vb.fehl} Fehler` : ''}`);
  } finally { importLaeuft = false; }
}

// ---------- Start, Leerlauf ----------
async function startLaden() {
  await autostartSicherstellen('Kioskstart');
  if (cfg.beimStartLaden === false) return;
  // Die AVE kann nach dem Kiosk hochfahren: so lange versuchen, bis sie antwortet.
  for (let n = 1; ; n++) {
    if (aktiv) return;          // inzwischen hat jemand ein Fahrzeug gewählt: nicht überschreiben
    const id = startId();
    if (!id) return log('Kein Startfahrzeug – fahrzeuge.json leer?');
    letzterFehler = null;
    if (await ladeFahrzeug(id, `Start (Versuch ${n})`)) {
      push();
      if (envStart) await ladeUmgebung(envStart, 'Start');
      return;
    }
    // Nur warten und erneut versuchen, wenn die AVE noch nicht erreichbar ist.
    if (letzterFehler !== 'verbindung') return log('Start abgebrochen – AVE erreichbar, lehnt aber ab');
    await autostartSicherstellen('Start wartet');
    await sleep(10000);
  }
}

// ---------- Bilder-Rundgang: jedes Fahrzeug ohne Bild einmal laden und aufnehmen ----------
// Strg+Alt+Shift+A startet, nochmal drücken bricht ab. Die AVE muss dabei sichtbar sein.
let rundgang = false;
async function bilderRundgang() {
  if (rundgang) { rundgang = false; return log('Bilder-Rundgang: wird nach dem aktuellen Fahrzeug abgebrochen'); }
  const offen = fahrzeuge.filter((f) => !f.img);
  const offenEnv = umgebungen.filter((u) => !u.img);
  if (!offen.length && !offenEnv.length) return hinweis('alle Fahrzeuge und Umgebungen haben ein Bild');
  rundgang = true;
  log(`Bilder-Rundgang: ${offen.length} Fahrzeuge`);
  let n = 0;
  for (const f of offen) {
    while (laeuft) await sleep(300);            // laufenden Ladevorgang abwarten
    if (!rundgang) break;
    if (!(await ladeFahrzeug(f.id, `Rundgang ${++n}/${offen.length}`))) continue;
    if (!f.img) {
      await sleep(bildCfg.wartenMs);
      await bildAufnehmen(f, 'Rundgang').catch((e) => log(`Bild ${f.name}: ${e.message}`));
    }
    push();
  }
  for (const u of offenEnv) {
    while (laeuft) await sleep(300);
    if (!rundgang) break;
    await ladeUmgebung(u.id, 'Rundgang Umgebung');   // nimmt das Bild beim ersten Laden selbst auf
  }
  if (rundgang && envStart && aktivUmgebung !== envStart) { while (laeuft) await sleep(300); await ladeUmgebung(envStart, 'Rundgang Ende'); }
  rundgang = false;
  log(`Bilder-Rundgang beendet: ${fahrzeuge.filter((f) => !f.img).length} Fahrzeuge, ${umgebungen.filter((u) => !u.img).length} Umgebungen ohne Bild`);
}

// Wachhalten: Die AVE springt nach 15 min ohne Aktivität in die Videoschleife. Nach "minuten" ohne
// Berührung und ohne eigenen Befehl schickt der Kiosk deshalb einen harmlosen Befehl.
// config.json: "wachhalten": { "minuten": 5, "art": "kamera" | "fahrzeug" | "abfrage", "kamera": "…" }  –  false = aus
//   kamera   = sanfter Kameraflug auf die Standardansicht (Standard)
//   fahrzeug = Startfahrzeug neu laden (mit Ladebildschirm)
//   abfrage  = nur AVEGetStates (unsichtbar – ob das der AVE als Aktivität reicht, ist nicht sicher)
const wachCfg = cfg.wachhalten === false ? null : Object.assign({ minuten: 5, art: 'kamera', kamera: '' }, cfg.wachhalten || {});
let letzterWachBefehl = Date.now(), wachBlockGemeldet = '';
function wachhalten() {
  if (!wachCfg || !(Number(wachCfg.minuten) > 0)) return log('Wachhalten: aus');
  const ms = Number(wachCfg.minuten) * 60000;
  log(`Wachhalten: aktiv – nach ${wachCfg.minuten} min ohne Bedienung „${wachCfg.art}“`);
  // Einmal pro Stunde den Stand ins Log, damit man nachts sieht, dass es läuft
  setInterval(() => log(`Wachhalten: Stand – ${ruheSek()}s ohne Bedienung, Windows-Leerlauf ${powerMonitor.getSystemIdleTime()}s`), 3600000);
  setInterval(async () => {
    if (Date.now() - Math.max(letzteBedienung, letzterWachBefehl) < ms) return;
    const block = laeuft ? 'lädt' : aktionLaeuft ? 'Aktion' : animLaeuft() ? 'Animation' : rundgang ? 'Rundgang' : offen.fahren ? 'Fahrszene' : '';
    if (block) { if (block !== wachBlockGemeldet) log(`Wachhalten: wartet (${block})`); wachBlockGemeldet = block; return; }
    wachBlockGemeldet = '';
    letzterWachBefehl = Date.now();
    const art = wachCfg.art;
    try {
      if (art === 'fahrzeug') {
        const id = startId();
        if (id) { log(`Wachhalten: lade Startfahrzeug neu`); if (await ladeFahrzeug(id, 'Wachhalten')) push(); }
      } else if (art === 'abfrage') {
        await aveSend('AVEGetStates', {}, true);
        log('Wachhalten: AVEGetStates');
      } else {
        const L = aktionen.licht || {};
        const cam = wachCfg.kamera || L.zurueckKamera;
        if (!cam) return log('Wachhalten: keine Kamera bekannt – "wachhalten.kamera" in config.json setzen');
        await aveSend('AVESelectCamera', { cameraId: cam, transition: { movementMode: L.bewegung || 'flysmooth', transitionDuration: Number(L.flugSek) || 1.9 } }, true);
        log(`Wachhalten: Kameraflug auf ${cam}`);
      }
    } catch (e) { log(`Wachhalten (${art}): ${e.message}`); }
  }, 20000);
}

// Showcar: nach kurzer Zeit ohne Berührung zurück auf „Alle“ und das vorherige Fahrzeug
function showLeerlauf() {
  const sek = showcar ? Number(showCfg.leerlaufSek) || 0 : 0;
  if (!sek) return;
  setInterval(() => {
    if (!showAktiv || laeuft || animLaeuft() || ruheSek() < sek) return;
    log(`Showcar: ${sek}s ohne Berührung – zurück auf „Alle“`);
    showcarWunsch(false, `Showcar-Leerlauf ${sek}s`);   // setzt showAktiv sofort zurück – die Meldung der Walze läuft dann ins Leere
    fe(`fe.setFilter && fe.setFilter('alle')`, 'models');
  }, 2000);
}

function idleWatch() {
  const sek = cfg.idleTimeoutSec || 0;
  if (!sek) return;
  // Systemweiter Leerlauf: zählt auch Berührungen in der AVE (Fahrzeug drehen).
  setInterval(() => {
    const id = startId(), f = fahrzeuge.find((x) => x.id === id);
    if (laeuft || rundgang || !f || animLaeuft()) return;
    const spotsOffen = spotListe.filter((s) => s.zustand !== 'Initial' && !aktionen.kofferraum.includes(s.trigger));
    if ((offen.tueren || offen.kofferraum || offen.fahren || spotsOffen.length) && !aktionLaeuft && ruheSek() >= sek) {
      (async () => {
        if (offen.fahren) await aktion('fahren', true, 'Leerlauf');
        for (const s of spotsOffen) await spotTippen(s.id);
        if (offen.tueren) await aktion('tueren', true, 'Leerlauf');
        if (offen.kofferraum) await aktion('kofferraum', true, 'Leerlauf');
      })();
      return;
    }
    const autoOk = aktiv === id && aktivFarbe === grundFarbe(f) && aktivFelge === grundFelge(f);
    const envOk = !envStart || aktivUmgebung === envStart;
    if (autoOk && envOk) return;
    if (ruheSek() < sek) return;
    if (showAktiv || showWunsch) { showAktiv = false; showWunsch = false; showVorher = null; pushUmgebungen(); pushAktionen(); }   // Leerlauf beendet das Showcar
    fe(`fe.setFilter && fe.setFilter('alle')`, 'models');   // Filter zurück auf „Alle“
    (autoOk ? Promise.resolve(true) : ladeFahrzeug(id, `Leerlauf ${sek}s`).then((ok) => { if (ok) push(); return ok; }))
      .then((ok) => ok && !envOk && ladeUmgebung(envStart, `Leerlauf ${sek}s`));
  }, 10000);
}

// Gewolltes Beenden: Code 10 – kiosk.bat startet dann nicht neu. Jeder andere Ausgang
// (Absturz, Windows beendet den Prozess) führt zum Neustart.
function beenden() {
  log('Beendet per Tastenkürzel');
  helferEnde = true;
  if (helfer) { try { helfer.stdin.end(); helfer.kill(); } catch {} }
  globalShortcut.unregisterAll();
  app.exit(10);
}

// Strg+Alt+Shift+I: alles, was die AVE über das geladene Fahrzeug weiß, in ave-info.txt (Kiosk-Ordner)
async function aveInfo() {
  const teile = [`AVE-Info ${new Date().toISOString()} – Fahrzeug: ${(fahrzeuge.find((f) => f.id === aktiv) || {}).name || '?'}`];
  for (const name of ['AVEListAnimations', 'AVEListCameras', 'AVEListCameraOrbits', 'AVEGetCurrentCameraDefinition', 'AVEGetAnimationSpots', 'AVEGetStates', 'AVEListDrivingScenes']) {
    try {
      const r = await fetch(ave.url, { method: 'POST', headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify([{ meta: { name, type: 'REQUEST', lastUpdate: true }, data: {} }]) });
      const text = await r.text();
      let lesbar = text;
      try { lesbar = JSON.stringify(JSON.parse(text).map((x) => x.data), null, 1); } catch {}
      teile.push(`\n===== ${name} (HTTP ${r.status}) =====\n${lesbar}`);
    } catch (e) { teile.push(`\n===== ${name}: FEHLER ${e.message} =====`); }
  }
  const datei = path.join(baseDir, 'ave-info.txt');
  fs.writeFileSync(datei, teile.join('\n'), 'utf8');
  log(`AVE-Info geschrieben: ${datei}`);
  hinweis('ave-info.txt geschrieben');
}

function shortcuts() {
  const reg = (k, fn) => { if (!globalShortcut.register(k, fn)) log(`Tastenkürzel ${k} belegt`); };
  reg('Control+Alt+Shift+Q', beenden);    // auch im Betrieb: Personal mit angesteckter Tastatur
  // Diagnose auch im Betrieb – schreibt nur ins Log bzw. ave-info.txt, ändert nichts
  reg('Control+Alt+Shift+D', () => { spotDiagnose(); hinweis('Spot-Diagnose ins Log geschrieben'); });
  reg('Control+Alt+Shift+I', () => { aveInfo().catch((e) => log(`AVE-Info: ${e.message}`)); });
  if (cfg.kiosk) return;
  reg('Control+Alt+Shift+R', () => { ladeKatalog(); ladeUmgebungen(); if (ladeFahrzeuge()) push(); pushUmgebungen(); });
  reg('Control+Alt+Shift+K', katalogImport);
  reg('Control+Alt+Shift+A', bilderRundgang);
  reg('Control+Alt+Shift+S', () => { const id = startId(); if (id) ladeFahrzeug(id, 'Tastenkürzel').then((ok) => ok && push()); });
  reg('Control+Alt+Shift+P', uebernehmeAusZwischenablage);
  reg('Control+Alt+Shift+B', () => {
    const f = fahrzeuge.find((x) => x.id === aktiv);
    if (!f || laeuft) return log('Bild: kein geladenes Fahrzeug oder es lädt noch');
    bildAufnehmen(f, 'Tastenkürzel').then(push).catch((e) => log(`Bild ${f.name}: ${e.message}`));
  });
  reg('Control+Alt+Shift+M', () => {
    if (!touchCfg.aktiv) return hinweis('touchAlsMaus ist in config.json aus');
    touchAn = !touchAn; zeigeTouch();
    hinweis(`Touch als Maus: ${touchAn ? 'an' : 'aus'}`);
  });
  reg('Control+Alt+Shift+T', () => wins.models && wins.models.webContents.openDevTools({ mode: 'detach' }));
}

app.whenReady().then(() => {
  log(`--- AVE Kiosk start${cfg.kiosk ? ' (Kiosk)' : ''} – ${ave.url}`);
  ladeKatalog();
  ladeFahrzeuge();
  ladeUmgebungen();
  for (const part of ['touch', 'models', 'colors', 'wheels', 'envs', 'actions']) createWindow(part);
  setInterval(ebenen, 5000);
  helferStarten();
  shortcuts();
  idleWatch();
  showLeerlauf();
  wachhalten();
  startLaden();
  if (spots.aktiv) setInterval(spotsHolen, Math.max(150, spots.intervallMs));
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  helferEnde = true;
  if (helfer) { try { helfer.stdin.end(); helfer.kill(); } catch {} }
});
app.on('window-all-closed', () => app.quit());
