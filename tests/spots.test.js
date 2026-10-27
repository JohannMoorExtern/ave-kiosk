// Blickrichtung aus den Spot-Positionen, Projektion des Dach-Spots, Sichtbarkeit je Seite.
// Die echten Messwerte stammen aus kiosk.log (Spot-Diagnose, Strg+Alt+Shift+D).
const test = require('node:test');
const assert = require('node:assert/strict');
const { ladeMain } = require('./lade-main');

const m = ladeMain();
const spotBlick = m.holen('spotBlick');
const spotInsBild = m.holen('spotInsBild');
const spotSichtbarkeit = m.holen('spotSichtbarkeit');
const spotFlaeche = m.holen('spotFlaeche');
const MODELL = m.holen('MODELL');
const ASPEKT = 16 / 9;

// Schwache Perspektive: Kamera mit Gier g und Neigung n (rad), Bildpunkte 0…1
function kamera(g, n, scale = 0.12) {
  const cg = Math.cos(g), sg = Math.sin(g), cn = Math.cos(n), sn = Math.sin(n);
  const view = [-cg * cn, -sg * cn, -sn], right = [-sg, cg, 0];   // rechts im Bild = Blick × oben (kein Spiegelbild)
  let down = [view[1] * right[2] - view[2] * right[1], view[2] * right[0] - view[0] * right[2], view[0] * right[1] - view[1] * right[0]].map((v) => -v);
  if (down[2] > 0) down = down.map((v) => -v);
  return ([X, Y, Z]) => ({ x: (0.5 * ASPEKT + scale * (right[0] * X + right[1] * Y + right[2] * Z)) / ASPEKT, y: 0.5 + scale * (down[0] * X + down[1] * Y + down[2] * Z) });
}
const spot = (id, trigger, x, y, zustand = 'Initial') => ({ id, trigger, zustand, x, y });

test('Dach-Spot: Projektion stimmt mit der Kamera überein (4 Blickwinkel)', () => {
  for (const [g, n] of [[0.6, 0.3], [2.4, 0.25], [-0.8, 0.4], [3.6, 0.2]]) {
    const pr = kamera(g, n), pk = {};
    for (const [k, [X, Y]] of Object.entries(MODELL)) pk[k] = pr([X, Y, 0]);
    const d = spotBlick(pk, ASPEKT);
    assert.ok(d, `keine Lösung bei g=${g}`);
    const soll = pr([-0.25, 0, 0.55]), ist = spotInsBild(d.abb, [-0.25, 0, 0.55]);
    assert.ok(Math.abs(soll.x - ist.x) < 1e-6 && Math.abs(soll.y - ist.y) < 1e-6, `g=${g}`);
  }
});

test('Q8 echt (07.10.): Dach-Punkt liegt über der Griffmitte', () => {
  const pk = { FL: { x: 0.6137, y: 0.5656 }, FR: { x: 0.4229, y: 0.3664 }, RL: { x: 0.7465, y: 0.4836 }, RR: { x: 0.5525, y: 0.3049 }, TRUNK: { x: 0.8014, y: 0.3287 } };
  const d = spotBlick(pk, ASPEKT);
  const dach = spotInsBild(d.abb, [-0.25, 0, 0.55]), griff = spotInsBild(d.abb, [-0.25, 0, 0]);
  assert.ok(dach.y < griff.y - 0.05, 'Dach muss deutlich höher im Bild liegen');
});

test('Weniger als 3 Punkte: keine Blickrichtung', () => {
  assert.equal(spotBlick({ FL: { x: 0.5, y: 0.6 }, RR: { x: 0.66, y: 0.44 } }, ASPEKT), null);
});

test('Fläche aus dem Namen: Türen, Heckklappe, Frunk, Dach', () => {
  assert.equal(spotFlaeche({ trigger: 'DoorFL', id: 'Door_FL' }), 'L');
  assert.equal(spotFlaeche({ trigger: 'DoorRR', id: 'Door_RR' }), 'R');
  assert.equal(spotFlaeche({ trigger: 'TRUNK', id: 'Trunk' }), 'hinten');
  assert.equal(spotFlaeche({ trigger: 'FrontTrunk', id: 'Frunk' }), 'vorn');   // Fehler vom 05.10.: zählte als Heckklappe
  assert.equal(spotFlaeche({ trigger: 'GlassRoofAll', id: 'Dach' }), 'oben');
});

test('S3 echt (26.10.): Fahrerseite sichtbar, obwohl 2 Türen und Kofferraum offen sind', () => {
  // Vorher fror die Blickrichtung auf der Beifahrerseite ein, die linken Spots fehlten
  const alle = [
    spot('Door_FL', 'DoorFL', 0.4927, 0.6024),
    spot('Door_FR', 'DoorFR', 0.5316, 0.4289, 'Animated'),
    spot('Door_RL', 'DoorRL', 0.6531, 0.6088, 'Animated'),
    spot('Door_RR', 'DoorRR', 0.6623, 0.4351),
    spot('Trunk', 'TRUNK', 0.8602, 0.5410, 'Animated'),
  ];
  const sichtbar = spotSichtbarkeit(alle);
  assert.equal(sichtbar(alle[0]), true, 'Door_FL (Fahrerseite) muss sichtbar sein');
  assert.equal(sichtbar(alle[3]), false, 'Door_RR (abgewandt) muss verdeckt sein');
});

test('Alle Türen zu, Blick von hinten: Heckklappe sichtbar, Frunk verdeckt', () => {
  const pr = kamera(Math.PI, 0.3), alle = [];
  for (const [k, trig] of [['FL', 'DoorFL'], ['RL', 'DoorRL'], ['FR', 'DoorFR'], ['RR', 'DoorRR'], ['TRUNK', 'TRUNK']]) {
    const [X, Y] = MODELL[k]; const p = pr([X, Y, 0]); alle.push(spot(k, trig, p.x, p.y));
  }
  const frunk = { ...pr([2.2, 0, 0]), id: 'Frunk', trigger: 'FrontTrunk', zustand: 'Initial' };
  alle.push(frunk);
  const sichtbar = spotSichtbarkeit(alle);
  assert.equal(sichtbar(alle[4]), true, 'Heckklappe');
  assert.equal(sichtbar(frunk), false, 'Frunk');
});
