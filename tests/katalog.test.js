// PR-String, Farb-/Felgenwechsel, Exklusivfarben, Optionsfilter, Namen und Fahrzeugtypen
const test = require('node:test');
const assert = require('node:assert/strict');
const { ladeMain } = require('./lade-main');

const m = ladeMain();
m.holen('ladeKatalog')();
m.holen('ladeFahrzeuge')();
const fahrzeuge = m.holen('fahrzeuge');
const prFuer = m.holen('prFuer');
const grundFarbe = m.holen('grundFarbe');
const grundFelge = m.holen('grundFelge');
const optionOk = m.holen('optionOk');
const kurzName = m.holen('kurzName');
const fahrzeugTypen = m.holen('fahrzeugTypen');
const fz = (code) => fahrzeuge.find((f) => f.pr[1] === code);
// Werte aus dem vm-Kontext haben eigene Array-Prototypen – für deepEqual in normale Werte wandeln
const roh = (x) => JSON.parse(JSON.stringify(x));

test('Testkatalog: alle 4 Modelle werden Fahrzeuge', () => {
  assert.equal(fahrzeuge.length, 4);
  for (const code of ['8YVS5Y', 'FN2A2Y', 'FN5A5Y', '4MT0P3']) assert.ok(fz(code), code);
});

test('Grundausstattung: PR-String bleibt unverändert', () => {
  for (const f of fahrzeuge) {
    const erwartet = roh(f.pr);
    // Ausgangsfarbe ist ein Exklusiv-Platzhalter (Q8: Q0Q0): Start in der ersten Exklusivfarbe
    if (String(grundFarbe(f)).includes(':')) erwartet.push('LC_PR_' + grundFarbe(f).split(':')[1]);
    assert.deepEqual(roh(prFuer(f, grundFarbe(f), grundFelge(f))), erwartet, f.name);
  }
});

test('Farbwechsel: Ausgangsfarbe raus, Zielfarbe rein, Länge gleich', () => {
  const f = fz('FN5A5Y');                       // A6 Avant TFSI, Ausgangsfarbe L5L5
  assert.equal(grundFarbe(f), 'L5L5');
  const pr = prFuer(f, 'Z9Z9', grundFelge(f));
  assert.equal(pr[3], 'Z9Z9');
  assert.ok(!pr.includes('L5L5'));
  assert.equal(pr.length, f.pr.length);
});

test('Farbwechsel mit Zusatzcodes: plus rein, minus raus', () => {
  const f = fz('FN5A5Y');
  const o = f.farben.find((x) => x.code === '0E0E');   // Mythosschwarz: plus CZ3, H2X / minus C2R, I54
  const pr = prFuer(f, '0E0E', grundFelge(f));
  for (const c of o.plus) assert.ok(pr.includes(c), `fehlt ${c}`);
  for (const c of o.minus) assert.ok(!pr.includes(c), `noch drin ${c}`);
});

test('Farbe und Felge zugleich: beide Änderungen im String', () => {
  const f = fz('FN5A5Y');
  const farbe = f.farben.find((x) => x.code === '0E0E');
  const felge = f.felgen.find((o) => o.code !== grundFelge(f) && (o.plus || []).length);
  const pr = prFuer(f, '0E0E', felge.code);
  for (const c of [...farbe.plus, ...felge.plus]) assert.ok(pr.includes(c), `fehlt ${c}`);
  assert.ok(!pr.includes(grundFarbe(f)));
});

test('Felgenwechsel: neue Felge im String, alte draußen', () => {
  const f = fz('FN5A5Y');
  const alt = grundFelge(f);
  const neu = f.felgen.find((o) => o.code !== alt && (o.plus || []).length);
  assert.ok(neu, 'Testmodell braucht eine zweite Felge mit Diff');
  const pr = prFuer(f, grundFarbe(f), neu.code);
  for (const c of neu.plus) assert.ok(pr.includes(c));
  for (const c of neu.minus) assert.ok(!pr.includes(c));
});

test('Exklusivfarbe: Platzhalter Q0Q0 plus LC_PR_<Farbe> am Ende', () => {
  const f = fz('8YVS5Y');                       // S3 Limousine
  const q = f.farben.find((o) => o.code === 'Q0Q0');
  assert.ok(q && q.exklusiv.length >= 20);
  const farbe = q.exklusiv[0].code;            // z. B. Q0Q0:AEEXC140
  const ae = farbe.split(':')[1];
  const pr = prFuer(f, farbe, grundFelge(f));
  assert.equal(pr[3], 'Q0Q0');
  assert.equal(pr.at(-1), 'LC_PR_' + ae);
  assert.equal(pr.filter((c) => c.startsWith('LC_PR_')).length, 1);
});

test('Exklusivfarbe wechseln: nur ein LC_PR_ bleibt', () => {
  const f = fz('8YVS5Y');
  const q = f.farben.find((o) => o.code === 'Q0Q0');
  const erst = prFuer(f, q.exklusiv[0].code, grundFelge(f));
  const dann = prFuer({ ...f, pr: erst }, q.exklusiv[1].code, grundFelge(f));
  assert.equal(dann.filter((c) => c.startsWith('LC_PR_')).length, 1);
  assert.equal(dann.at(-1), 'LC_PR_' + q.exklusiv[1].code.split(':')[1]);
});

test('Optionsfilter: Platzhalter nur mit Exklusivliste, Fehler raus, Modellwechsel raus', () => {
  const kat = { aveString: '1,FN5A5Y,2027,L5L5' };
  assert.equal(optionOk({ code: 'Q0Q0', plus: ['Q0Q0'], minus: ['L5L5'] }, kat), false);
  assert.equal(optionOk({ code: 'Q0Q0', plus: ['Q0Q0'], minus: ['L5L5'], exklusiv: [{ code: 'Q0Q0:X' }] }, kat), true);
  assert.equal(optionOk({ code: 'Z9Z9', plus: ['Z9Z9'], minus: ['L5L5'], fehler: 'DCC zeigt anderes Modell' }, kat), false);
  assert.equal(optionOk({ code: 'Z9Z9', plus: ['Z9Z9'], minus: ['FN5A5Y'] }, kat), false);
  assert.equal(optionOk({ code: 'Z9Z9', plus: [], minus: [] }, kat), false);           // ohne Diff
  assert.equal(optionOk({ code: 'Z9Z9', serie: true, plus: [], minus: [] }, kat), true); // Serie darf
});

test('Kurzname: ohne Audi, vor TDI/TFSI/quattro/kW abgeschnitten', () => {
  assert.equal(kurzName('Audi A6 Avant TFSI quattro 270 kW S tronic'), 'A6 Avant');
  assert.equal(kurzName('Audi S3 Limousine TFSI 245 kW S tronic'), 'S3 Limousine');
  assert.equal(kurzName('Audi RS 3 Sportback 294 kW S tronic'), 'RS 3 Sportback');
});

test('Fahrzeugtypen für den Filter', () => {
  assert.deepEqual(roh(fahrzeugTypen({ name: 'Q8 SUV' })), ['suv']);
  assert.deepEqual(roh(fahrzeugTypen({ name: 'RS 3 Sportback' })), ['sportback', 'rs']);
  assert.deepEqual(roh(fahrzeugTypen({ name: 'A6 allroad' })), ['avant']);
  assert.deepEqual(roh(fahrzeugTypen({ name: 'A6 Limousine e-hybrid' })), ['limo']);
});
