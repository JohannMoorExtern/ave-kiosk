// DCC-Erfassung für den AVE-Kiosk – Modell für Modell per Knopf
// Im DCC-Tab (eingeloggt) F12 → Console → gesamten Inhalt einfügen → Enter.
// Oben rechts erscheint ein Feld: Modell im DCC wählen → „Dieses Modell erfassen“.
// Nach jedem Modell wird katalog.json heruntergeladen (enthält alle bisher erfassten).
// „Liste erfassen“: Namen einfügen (z. B. die Bildnamen "Q7 SUV", "A6 Avant e-hybrid"), das Skript
// sucht je Name ein Modell im DCC und erfasst alle nacheinander. Nach Abbruch: F5, neu einfügen,
// Liste erneut starten – bereits erfasste Modelle werden übersprungen.
(async () => {
  if (window.AVE_ERFASSEN) { window.AVE_ERFASSEN.zeigen(); return; }   // schon geladen: Feld nur wieder zeigen

  const API = 'https://dccbff.cocos-eu-prd.webapps.audi.io/api/v1';
  const PAUSE = window.AVE_PAUSE_MS || 1200;       // Abstand zwischen Aufrufen: sonst "Error updating session"
  const KEY = 'aveKatalogManuell';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lade = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { fahrzeuge: [] }; } catch { return { fahrzeuge: [] }; } };
  const st = lade();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };
  let laeuft = false;

  // ---------- Feld im DCC ----------
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#111;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:12px 14px;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.4);width:280px';
  // Alle Farben ausdrücklich setzen: die DCC-Seite gibt Knöpfen/Feldern eigene Stile (z. B. weiß auf weiß)
  const knopf = (a, text, extra = '') => `<button data-a="${a}" style="all:unset;box-sizing:border-box;display:block;width:100%;padding:8px;margin-bottom:6px;text-align:center;cursor:pointer;background:#fff!important;color:#111!important;-webkit-text-fill-color:#111!important;border:1px solid #888!important;border-radius:4px;font:600 13px system-ui,sans-serif;${extra}">${text}</button>`;
  box.innerHTML = '<div style="font-weight:700;margin-bottom:6px;color:#fff">AVE-Katalog</div>'
    + '<div data-a="status" style="margin-bottom:8px;min-height:36px;white-space:pre-line;color:#fff">Modell wählen, dann erfassen.</div>'
    + knopf('los', 'Dieses Modell erfassen', 'background:#fff;font-weight:700')
    + knopf('dl', 'Katalog herunterladen')
    + '<details style="margin-top:8px;color:#fff"><summary style="cursor:pointer;color:#fff;margin-bottom:6px">Liste erfassen</summary>'
    + '<textarea data-a="namen" rows="6" placeholder="Ein Modell je Zeile, z. B. Q7 SUV" style="all:unset;display:block;box-sizing:border-box;width:100%;min-height:96px;margin:6px 0;padding:6px;white-space:pre;overflow:auto;background:#fff!important;color:#111!important;-webkit-text-fill-color:#111!important;border:1px solid #888!important;border-radius:4px;font:12px/1.4 system-ui,sans-serif"></textarea>'
    + knopf('suchen', 'Modelle suchen')
    + knopf('start', 'Alle erfassen', 'display:none')
    + knopf('stop', 'Anhalten', 'display:none')
    + knopf('bilder', 'Nur Vorschaubilder holen')
    + '<div style="font-size:11px;opacity:.75;color:#fff;margin-top:-2px">Ohne Namen: alle Baureihen (je letzte Motorisierung). Mit Namen: nur diese.</div>'
    + '</details>'
    + '<div data-a="liste" style="margin-top:8px;max-height:160px;overflow:auto;opacity:.75;font-size:12px;color:#fff"></div>';
  document.body.appendChild(box);
  const $ = (a) => box.querySelector(`[data-a="${a}"]`);
  const sperr = (a, an) => { const b = $(a); b.disabled = an; b.style.opacity = an ? '.45' : '1'; b.style.cursor = an ? 'default' : 'pointer'; };
  const status = (t, farbe) => { $('status').textContent = t; $('status').style.color = farbe || '#fff'; console.log('[Erfassen]', t); };
  const liste = () => { $('liste').innerHTML = st.fahrzeuge.map((f) => `✓ ${f.name}`).join('<br>') || '<i>noch nichts erfasst</i>'; };
  liste();

  // Die Datei enthält immer ALLE bisher erfassten Modelle (gespeichert im Browser dieses DCC-Tabs)
  function download() {
    const blob = new Blob([JSON.stringify({ stand: new Date().toISOString(), ...st }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'katalog.json';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- Schnittstelle ----------
  async function call(method, path, { versuche = 3 } = {}) {
    for (let v = 1; ; v++) {
      let r;
      try { r = await fetch(API + path, { method, credentials: 'include', headers: { 'content-type': 'application/json' } }); }
      catch { throw Object.assign(new Error('Verbindung zum DCC verloren – Anmeldung abgelaufen? Seite neu laden, einloggen, Skript neu einfügen.'), { stop: true }); }
      if (r.ok) { const t = await r.text(); await sleep(PAUSE); return t ? JSON.parse(t) : null; }
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Nicht angemeldet – im DCC neu einloggen.'), { stop: true });
      if (v >= versuche) throw new Error(`${method} ${path} → HTTP ${r.status}`);
      await sleep((window.AVE_RETRY_MS || 4000) * v);
    }
  }
  // Option wählen. Konflikte: beim Modellwechsel verwerfen (wie der DCC), sonst annehmen.
  async function add(id, beiKonflikt = 'ACCEPT') {
    let c = await call('PATCH', '/configuration/add?triggerId=' + encodeURIComponent(id));
    if (c && /CONFLICT/.test(c.configurationState || '')) c = await call('PATCH', '/configuration/add?adopt=' + beiKonflikt, { versuche: 1 });
    return c;
  }
  const aveString = async () => ((await call('GET', '/visualization')) || {}).aveString || '';
  // Renderbild des DCC für die Fahrzeugwalze: gleiche Ansicht für alle Modelle, genau diese Ausstattung.
  // Ansicht über window.AVE_BILD_ANSICHT änderbar (exterior_side-front, exterior_front-middle, exterior_side-middle …)
  async function renderBild() {
    try {
      const v = (await call('GET', '/visualization', { versuche: 2 })) || {};
      const alle = v.renderImages || [];
      const ansicht = alle.find((r) => r.id === (window.AVE_BILD_ANSICHT || 'exterior_side-front')) || alle[0];
      if (!ansicht) return null;
      const url = (typ) => {
        const l = (ansicht.renderDetails || []).filter((d) => d.backgroundType === typ).sort((a, b) => a.size - b.size);
        return (l.find((d) => d.size >= 900) || l[l.length - 1] || {}).url || null;
      };
      return { ansicht: ansicht.id, moma: url('MOMA'), standard: url('DEFAULT') };
    } catch (e) { if (e.stop) throw e; return null; }
  }
  const modellcode = (ave) => ave.split(',')[1];
  const diff = (basis, neu) => {
    if (modellcode(neu) !== modellcode(basis)) throw new Error(`DCC zeigt anderes Modell (${modellcode(neu)})`);
    const a = new Set(basis.split(',')), b = new Set(neu.split(','));
    return { plus: [...b].filter((x) => !a.has(x)), minus: [...a].filter((x) => !b.has(x)) };
  };
  // Verbrauchs- und Emissionswerte (Pkw-EnVKV) des Modells, so wie der DCC sie anzeigt
  const tiefgestellt = '₀₁₂₃₄₅₆₇₈₉';
  const text = (t) => String(t || '').replace(/<sub>(\d)<\/sub>/gi, (m, d) => tiefgestellt[d]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  async function verbrauch() {
    try {
      const eff = await call('GET', '/efficiencyData/formatted', { versuche: 2 });
      return ((eff && eff.efficiencyGroups) || [])
        .flatMap((g) => (g.efficiencyNodes || []).map((n) => `${text(n.label)}: ${text(n.value)}`))
        .filter((z) => !/^:|:\s*$/.test(z));
    } catch (e) { if (e.stop) throw e; return []; }
  }
  // Audi exclusive: Platzhalter-Lack (Q0Q0, O0O0) → konkrete Farben vom Exklusiv-Dienst des DCC.
  // Gewählt wird eine Farbe, indem "LC_PR_<ae_color>" an den PR-String gehängt wird (so macht es der DCC).
  const EXKLUSIV_URL = 'https://audiexclusive.avp.tech/v2/packages';
  async function exklusivFarben(code, prString) {
    const u = `${EXKLUSIV_URL}?code=${encodeURIComponent(code)}&model=${encodeURIComponent(prString.split(',')[1].slice(0, 3))}&prstring=${encodeURIComponent(prString)}`;
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const werte = (((await r.json()) || {}).data || {}).values || [];
      const je = new Map();
      for (const v of werte) if (v.id === code && String(v.is_active) === 'true' && v.ae_color && !je.has(v.ae_color))
        je.set(v.ae_color, { code: `${code}:${v.ae_color}`, ae: v.ae_color, pr: 'LC_PR_' + v.ae_color, name: v.dcc_text_de || v.dcc_text_en || v.ae_color, img: v.image_url || null });
      return [...je.values()];
    } catch (e) { console.warn('[Erfassen] Exklusivfarben', code, e.message); return []; }
  }
  const bild = (e, ids) => ((e.media || []).find((m) => ids.includes(m.id) && m.path) || {}).path || null;
  function optionen(eq) {
    const alle = [];
    const lauf = (o) => {
      if (Array.isArray(o)) o.forEach(lauf);
      else if (o && typeof o === 'object') { if (o.id && o.evaKey && 'selected' in o) alle.push(o); Object.values(o).forEach(lauf); }
    };
    lauf(eq);
    const uniq = (l) => [...new Map(l.map((e) => [e.id, e])).values()];
    const farben = uniq(alle.filter((e) => /^F14 /.test(e.id)))
      .map((e) => ({ id: e.id, code: e.evaKey, name: e.name, preis: e.price, img: bild(e, ['outer_tile_small_hd']), serie: false }));
    const felgen = uniq(alle.filter((e) => /^MRAD/.test(e.id) && !/winter/i.test(e.name)))
      .map((e) => ({ id: e.id, code: e.evaKey, name: e.name, preis: e.price, img: bild(e, ['wheel_image_small', 'wheel_image', 'small_hd_image']), serie: false }));
    return { farben, felgen };
  }

  // ---------- Erfassen des gerade geöffneten Modells ----------
  async function erfassen(ausListe = false) {
    if (laeuft && !ausListe) return;
    laeuft = true;
    sperr('los', true);
    try {
      status('lese Modell …');
      const basis = await aveString();
      if (!basis) throw new Error('Kein Modell konfiguriert – im DCC erst ein Modell wählen.');
      const pr = basis.split(',');
      const name = String(((await call('GET', '/cart')) || {}).cartName || pr[1]).replace(/\s+/g, ' ').trim();
      const werte = await verbrauch();        // vor dem Durchklicken: Werte der Ausgangskonfiguration
      const bildDcc = await renderBild();      // ebenso das Renderbild der Ausgangskonfiguration
      const eq = await call('GET', '/catalog/equipment');
      const { farben, felgen } = optionen(eq);
      const istFarbe = farben.find((f) => f.code === pr[3]);
      const istFelge = felgen.find((w) => pr.includes(w.code));
      if (istFarbe) Object.assign(istFarbe, { serie: true, plus: [], minus: [] });
      if (istFelge) Object.assign(istFelge, { serie: true, plus: [], minus: [] });
      const todo = [...farben, ...felgen].filter((o) => !o.serie);
      let n = 0;
      for (const o of todo) {
        status(`${name}\n${++n}/${todo.length}: ${o.name} – bitte nichts im DCC anklicken`, '#fc6');
        try {
          await add(o.id);
          const neu = await aveString();
          Object.assign(o, diff(basis, neu));
          if (farben.includes(o) && /^(Q0Q0|O0O0)$/.test(o.code)) {
            status(`${name}\n${n}/${todo.length}: ${o.name} – Exklusivfarben lesen …`, '#fc6');
            o.exklusiv = await exklusivFarben(o.code, neu);
          }
        }
        catch (e) { if (e.stop) throw e; o.fehler = e.message; }
        // nach jeder Farbe zurück auf die Ausgangsfarbe, damit die Felgen sauber vergleichbar sind
        if (farben.includes(o) && istFarbe) await add(istFarbe.id).catch(() => {});
      }
      // Steht die Ausgangsfarbe selbst auf einem Platzhalter (Q0Q0/O0O0), dessen Liste mit dem Ausgangs-PR-String holen
      for (const o of farben) if (/^(Q0Q0|O0O0)$/.test(o.code) && !o.fehler && !o.exklusiv) {
        status(`${name}\n${o.name} – Exklusivfarben lesen …`, '#fc6');
        o.exklusiv = await exklusivFarben(o.code, basis);
      }
      // DCC wieder auf den Ausgangszustand stellen
      if (istFelge) await add(istFelge.id).catch(() => {});
      const eintrag = { carlineId: pr[0] + '\\' + pr[2], modelId: `${pr[1]}-${pr[0]}\\${pr[2]}`, name, aveString: basis, verbrauch: werte, bild: bildDcc, farben, felgen };
      st.fahrzeuge = st.fahrzeuge.filter((f) => modellcode(f.aveString) !== pr[1] || f.aveString.split(',')[2] !== pr[2]);
      st.fahrzeuge.push(eintrag);
      save(); liste();
      if (!ausListe) download();            // im Listenlauf nur einmal am Ende: Browser blockieren Serien-Downloads
      const fehl = todo.filter((o) => o.fehler).length;
      const exkl = farben.reduce((s, f) => s + ((f.exklusiv || []).length), 0);
      status(`✓ ${name}: ${farben.length} Farben${exkl ? ` (+${exkl} exclusive)` : ''}, ${felgen.length} Felgen${fehl ? `, ${fehl} nicht erfassbar` : ''}, ${werte.length ? werte.length + ' Verbrauchswerte' : 'KEINE Verbrauchswerte'}. Nächstes Modell wählen.`, werte.length ? '#7e7' : '#fc6');
      return true;
    } catch (e) {
      status('✗ ' + e.message, '#f77');
      if (ausListe) throw e;
      return false;
    } finally {
      if (!ausListe) { laeuft = false; sperr('los', false); }
    }
  }

  // ---------- Liste erfassen ----------
  // Kurzname wie im Kiosk: "Audi Q7 SUV TDI quattro 180 kW tiptronic" → "Q7 SUV"
  const kurzName = (n) => { const t = String(n || '').replace(/\s+/g, ' ').replace(/^Audi /, '').trim(); const m = t.match(/^(.*?)\s+(TDI|TFSI|quattro|\d+\s*kW)\b/); return (m && m[1]) || t; };
  const norm = (t) => String(t || '').toLowerCase().replace(/^\s*audi\s+/, '').replace(/[^a-z0-9]/g, '');
  const woerter = (t) => String(t || '').toLowerCase().replace(/^\s*audi\s+/, '').split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  function carlineIds(o, set = new Set()) {
    if (typeof o === 'string') { if (/^\d{4,6}\\\d{4}$/.test(o)) set.add(o); }
    else if (o && typeof o === 'object') for (const v of Object.values(o)) carlineIds(v, set);
    return set;
  }
  // Liefert der DCC die Liste nicht (z. B. 400, solange kein Modell geöffnet ist), gilt die zuletzt
  // erfolgreich gelesene – sie wird im Browser gemerkt.
  const CL_KEY = 'aveKatalogCarlines';
  async function carlines() {
    for (const p of ['/catalog/carlines', '/catalog/carlineGroups', '/catalog/carline-groups', '/catalog']) {
      try {
        const ids = carlineIds(await call('GET', p, { versuche: 1 }));
        if (ids.size) { try { localStorage.setItem(CL_KEY, JSON.stringify([...ids])); } catch {} return [...ids]; }
      } catch (e) { if (e.stop) throw e; }
    }
    try { const alt = JSON.parse(localStorage.getItem(CL_KEY) || '[]'); if (alt.length) { console.log('[Erfassen] Modellliste aus dem Speicher:', alt.length); return alt; } } catch {}
    const dom = [...document.querySelectorAll('[data-testid^="select-carline-button-"]')]
      .map((el) => el.getAttribute('data-testid').replace('select-carline-button-', '').replace(/\.(\d{4})$/, '\\$1'));
    if (dom.length) return [...new Set(dom)];
    throw new Error('Der DCC liefert die Modellliste gerade nicht. Im DCC ein beliebiges Modell öffnen (bis die Konfiguration steht), dann erneut „Modelle suchen“.');
  }
  let plan = [], stop = false;
  async function suchen() {
    const namen = $('namen').value.split(/\r?\n/).map((z) => z.replace(/\.(png|jpe?g|webp)$/i, '').trim()).filter(Boolean);
    if (!namen.length) return status('Erst Namen einfügen, einer je Zeile.', '#fc6');
    laeuft = true; sperr('suchen', true); sperr('los', true);
    try {
      status('lese Modellliste …');
      const alle = [];
      const cls = await carlines();
      let i = 0;
      for (const cl of cls) {
        status(`lese Modellliste … ${++i}/${cls.length}`);
        for (const m of ((await call('GET', '/catalog/models?carlineId=' + encodeURIComponent(cl))) || {}).models || [])
          alle.push({ id: m.id, name: String(m.name || '').replace(/\s+/g, ' ').trim(), kurz: kurzName(m.name) });
      }
      const fehlt = [];
      plan = [];
      for (const n of namen) {
        const nn = norm(n), w = woerter(n);
        // erst exakt, sonst eindeutig über alle Wörter; bei mehreren Motorisierungen die letzte (unten in der DCC-Liste)
        let t = alle.filter((m) => norm(m.kurz) === nn);
        if (!t.length) { const k = [...new Set(alle.filter((m) => w.every((x) => woerter(m.kurz).includes(x))).map((m) => m.kurz))]; if (k.length === 1) t = alle.filter((m) => m.kurz === k[0]); }
        if (t.length) plan.push({ wunsch: n, ...t[t.length - 1] }); else fehlt.push(n);
      }
      const erledigt = (m) => st.fahrzeuge.some((f) => m.id.startsWith(f.aveString.split(',')[1] + '\\') && m.id.endsWith(f.aveString.split(',')[2]));
      const offen = plan.filter((m) => !erledigt(m));
      console.table(plan.map((m) => ({ Name: m.wunsch, Modell: m.name, erfasst: erledigt(m) ? 'ja' : '' })));
      status(`${plan.length} von ${namen.length} gefunden, davon ${offen.length} noch offen.${fehlt.length ? '\nNicht gefunden: ' + fehlt.join(', ') : ''}\nDauer etwa ${offen.length} min. Details in der Console.`, fehlt.length ? '#fc6' : '#7e7');
      $('start').style.display = offen.length ? 'block' : 'none';
    } catch (e) { status('✗ ' + e.message, '#f77'); }
    finally { laeuft = false; sperr('suchen', false); sperr('los', false); }
  }
  async function alleErfassen() {
    if (laeuft) return;
    laeuft = true; stop = false;
    for (const b of ['los', 'suchen', 'start']) sperr(b, true);
    $('stop').style.display = 'block';
    let n = 0, fehler = 0;
    const erledigt = (m) => st.fahrzeuge.some((f) => m.id.startsWith(f.aveString.split(',')[1] + '\\') && m.id.endsWith(f.aveString.split(',')[2]));
    const offen = plan.filter((m) => !erledigt(m));
    try {
      for (const m of offen) {
        if (stop) { status(`Angehalten nach ${n} Modellen.`, '#fc6'); break; }
        n++;
        status(`${n}/${offen.length}: wechsle zu ${m.name} …`, '#fc6');
        await add(m.id, 'REJECT');                  // Modellwechsel wie im DCC: alte Ausstattung verwerfen
        try { await erfassen(true); }
        catch (e) { if (e.stop) throw e; fehler++; console.warn('[Erfassen] übersprungen:', m.name, e.message); }
      }
      if (!stop) status(`Fertig: ${n - fehler} erfasst${fehler ? `, ${fehler} übersprungen (Console)` : ''}. katalog.json mit ${st.fahrzeuge.length} Modellen wird heruntergeladen – falls nicht, „Katalog herunterladen“ drücken.`, fehler ? '#fc6' : '#7e7');
    } catch (e) {
      status('✗ ' + e.message + `\nBisher erfasst bleibt gespeichert und wird heruntergeladen. Nach F5 und neuem Einfügen „Liste erfassen“ erneut starten.`, '#f77');
    } finally {
      if (n) download();                    // einmal am Ende – auch nach Abbruch oder Anhalten
      laeuft = false;
      for (const b of ['los', 'suchen', 'start']) sperr(b, false);
      $('stop').style.display = 'none';
    }
  }

  // ---------- Nur Vorschaubilder: Modell für Modell umschalten, Renderbild-Adresse merken ----------
  // Ergebnis: fahrzeugbilder.json → in den Kiosk-Ordner legen, Strg+Alt+Shift+K lädt die Bilder nach bilder\fahrzeuge.
  async function nurBilder() {
    if (laeuft) return;
    laeuft = true; stop = false;
    for (const b of ['los', 'suchen', 'start', 'bilder']) sperr(b, true);
    $('stop').style.display = 'block';
    const bilder = [];
    try {
      let liste = plan.slice();
      if (!liste.length) {                    // keine Namen gesucht: alle Baureihen, je die letzte Motorisierung
        status('lese Modellliste …');
        const cls = await carlines();
        let i = 0;
        for (const cl of cls) {
          status(`lese Modellliste … ${++i}/${cls.length}`);
          const ms = (((await call('GET', '/catalog/models?carlineId=' + encodeURIComponent(cl))) || {}).models || []);
          const jeKurz = new Map();
          for (const m of ms) jeKurz.set(kurzName(m.name), m);   // gleiche Baureihe/Karosserie: die letzte gewinnt
          for (const m of jeKurz.values()) liste.push({ id: m.id, name: String(m.name || '').replace(/\s+/g, ' ').trim() });
        }
      }
      let n = 0;
      for (const m of liste) {
        if (stop) { status(`Angehalten nach ${n} Bildern.`, '#fc6'); break; }
        n++;
        status(`Bilder ${n}/${liste.length}: ${m.name} – bitte nichts im DCC anklicken`, '#fc6');
        try {
          await add(m.id, 'REJECT');
          const b = await renderBild();
          const name = String(((await call('GET', '/cart')) || {}).cartName || m.name).replace(/\s+/g, ' ').trim();
          if (b && (b.moma || b.standard)) bilder.push({ name, kurz: kurzName(name), ...b });
          else console.warn('[Erfassen] kein Renderbild:', m.name);
        } catch (e) { if (e.stop) throw e; console.warn('[Erfassen] Bild übersprungen:', m.name, e.message); }
      }
    } catch (e) { status('✗ ' + e.message, '#f77'); }
    finally {
      if (bilder.length) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify({ stand: new Date().toISOString(), bilder }, null, 1)], { type: 'application/json' }));
        a.download = 'fahrzeugbilder.json';
        document.body.appendChild(a); a.click(); a.remove();
        if (!stop) status(`✓ ${bilder.length} Vorschaubilder – fahrzeugbilder.json wird heruntergeladen. In den Kiosk-Ordner legen, dort Strg+Alt+Shift+K.`, '#7e7');
      }
      console.table(bilder.map((b) => ({ Kurzname: b.kurz, Modell: b.name })));
      laeuft = false;
      for (const b of ['los', 'suchen', 'start', 'bilder']) sperr(b, false);
      $('stop').style.display = 'none';
    }
  }
  $('bilder').onclick = nurBilder;
  $('los').onclick = () => erfassen();
  $('suchen').onclick = suchen;
  $('start').onclick = alleErfassen;
  $('stop').onclick = () => { stop = true; status('hält nach dem aktuellen Modell an …', '#fc6'); };
  $('dl').onclick = download;
  window.AVE_ERFASSEN = { erfassen, download, suchen, alleErfassen, nurBilder, zeigen: () => { box.style.display = ''; } };
  status(st.fahrzeuge.length ? `${st.fahrzeuge.length} Modelle gespeichert. Modell wählen, dann erfassen.` : 'Modell im DCC wählen, dann erfassen.');
})();
