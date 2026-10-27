import { buildNetwork, matchRoute, stripSegments, tollSummary, vignetteOptions, distance } from './core.js';
import { LANGS, pickLang, makeT } from './i18n.js';
import { searchPlaces, reverseGeocode, route, eurRate, RouteError } from './services.js';

const L = window.L;
const HU_CENTER = [47.17, 19.45];
// Standard OSM tiles, shown in greyscale (css/style.css) so that only the toll overlay carries colour.
const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const REPO = 'https://github.com/barnabashub/autopalya';
// Public address of the site (GitHub Pages). Change it here, in index.html and sitemap.xml for a custom domain.
const SITE = 'https://barnabashub.github.io/autopalya/';
const OG_LOCALE = { hu: 'hu_HU', en: 'en_GB', de: 'de_DE', ro: 'ro_RO', sk: 'sk_SK', pl: 'pl_PL', uk: 'uk_UA' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  lang: 'hu',
  t: makeT('hu'),
  cat: 'D1',
  trailer: false,
  ends: { from: null, to: null }, // { latlng, label }
  net: null,
  prices: null,
  counties: null,
  generated: '',
  rate: null,
  result: null, // last analysed route
  routeAbort: null,
};

let map, tiles, layers = {};

// ---------------------------------------------------------------- formatting

function nf() { return new Intl.NumberFormat(state.lang === 'uk' ? 'uk-UA' : state.lang, { useGrouping: 'always' }); }
function fmtFt(n) { return `${nf().format(n)} Ft`; }
function fmtEur(n) { return state.rate && state.lang !== 'hu' ? `≈ ${nf().format(Math.round(n / state.rate))} €` : ''; }
function fmtKm(m) {
  const km = m / 1000;
  return `${new Intl.NumberFormat(state.lang, { maximumFractionDigits: km < 10 ? 1 : 0 }).format(km)} km`;
}
function fmtTime(s) {
  const min = Math.round(s / 60);
  const h = Math.floor(min / 60);
  const t = state.t;
  return h ? `${h} ${t('units.h')} ${min % 60} ${t('units.min')}` : `${min} ${t('units.min')}`;
}
function countyList(ids) { return ids.map((c) => state.net.counties[c]).join(', '); }
function plate(ref) { return `<span class="plate">${esc(ref)}</span>`; }

// ---------------------------------------------------------------- language

function applyLang(lang) {
  state.lang = lang;
  state.t = makeT(lang);
  document.documentElement.lang = lang;
  document.title = state.t('docTitle');
  // search engines render the page per language URL (?lang=xx), so the head follows the language
  const url = lang === 'hu' ? SITE : `${SITE}?lang=${lang}`;
  const setMeta = (sel, attr, value) => { const el = $(sel); if (el) el.setAttribute(attr, value); };
  setMeta('meta[name="description"]', 'content', state.t('metaDesc'));
  setMeta('meta[property="og:title"]', 'content', state.t('docTitle'));
  setMeta('meta[property="og:description"]', 'content', state.t('metaDesc'));
  setMeta('meta[property="og:url"]', 'content', url);
  setMeta('meta[property="og:locale"]', 'content', OG_LOCALE[lang]);
  setMeta('link[rel="canonical"]', 'href', url);
  $$('[data-i18n]').forEach((el) => { el.textContent = state.t(el.dataset.i18n); });
  $$('[data-i18n-title]').forEach((el) => {
    el.title = state.t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  });
  $$('input[role="combobox"]').forEach((el) => { el.placeholder = state.t('placeholder'); });
  $('#lang').value = lang;
  store.set('lang', lang);
  renderLegend();
  renderPrices();
  renderGuide();
  if (state.result) renderResult();
  for (const end of ['from', 'to']) {
    const e = state.ends[end];
    if (e && e.mine) setInput(end, state.t('myLocation'));
  }
  writeHash();
}

// ---------------------------------------------------------------- map

function initMap() {
  map = L.map('map', { zoomControl: true, minZoom: 6, maxZoom: 18, zoomSnap: 0.25, attributionControl: true })
    .setView(HU_CENTER, 7);
  map.attributionControl.setPrefix(false);
  tiles = L.tileLayer(TILE, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', restyleNetwork);

  map.createPane('counties').style.zIndex = 350;
  map.createPane('labels').style.zIndex = 430;
  map.createPane('network').style.zIndex = 420;
  map.createPane('route').style.zIndex = 440;
  map.createPane('gates').style.zIndex = 460;

  layers.counties = L.geoJSON(state.counties, {
    pane: 'counties',
    style: () => countyStyle(false),
    interactive: false,
  }).addTo(map);

  map.fitBounds(layers.counties.getBounds(), { padding: [10, 10] });

  layers.network = L.layerGroup().addTo(map);
  state.pieceLayers = state.net.pieces.map((p) => {
    const line = L.polyline(p.pts, { pane: 'network', ...pieceStyle(p) });
    line.on('click', (e) => { L.DomEvent.stop(e); openPiecePopup(p, e.latlng); });
    line.addTo(layers.network);
    return line;
  });

  layers.gates = L.layerGroup();
  const gateIcon = L.divIcon({
    className: 'gate-icon',
    html: '<svg viewBox="0 0 16 14" aria-hidden="true"><path d="M2 14V3h12v11" fill="none" stroke="#262b30" stroke-width="2"/><rect x="1" y="1" width="14" height="4" fill="#262b30"/></svg>',
    iconSize: [16, 14],
  });
  for (const g of state.net.gates) {
    L.marker([g.lat, g.lon], { icon: gateIcon, pane: 'gates', keyboard: false, title: `${state.t('gate')} ${g.ref}` })
      .on('click', (e) => openGatePopup(g, e.latlng))
      .addTo(layers.gates);
  }
  const syncGates = () => {
    if (map.getZoom() >= 8) layers.gates.addTo(map); else layers.gates.remove();
  };
  map.on('zoomend', syncGates);
  syncGates();

  layers.labels = L.layerGroup();
  for (const f of state.counties.features) {
    L.marker(labelPoint(f.geometry), {
      pane: 'labels',
      interactive: false,
      keyboard: false,
      icon: L.divIcon({ className: 'county-label', html: `<span>${countyLabelHtml(f.properties.name)}</span>`, iconSize: [0, 0] }),
    }).addTo(layers.labels);
  }
  map.on('zoomend', syncLabels);
  syncLabels();

  layers.route = L.layerGroup().addTo(map);
  layers.alt = L.layerGroup().addTo(map);
  layers.markers = L.layerGroup().addTo(map);

  map.on('click', (e) => openPointPopup(e.latlng));
  map.on('popupclose', () => highlightCounty(null));
}

// County names are shown while browsing; a planned route takes over the map.
function syncLabels() {
  const z = map.getZoom();
  const show = !state.result && z <= 10.5;
  if (show) layers.labels.addTo(map); else layers.labels.remove();
}

function countyLabelHtml(name) {
  // long double names break after their first hyphen
  return name.length > 13 ? esc(name).replace('-', '-<br>') : esc(name);
}

/** A point well inside the county: the grid point farthest from the border of its largest part. */
function labelPoint(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const area = (ring) => Math.abs(ring.reduce((s, [x1, y1], i) => {
    const [x2, y2] = ring[(i + 1) % ring.length];
    return s + x1 * y2 - x2 * y1;
  }, 0));
  const poly = polys.reduce((a, b) => (area(b[0]) > area(a[0]) ? b : a));
  const kx = Math.cos(47.2 * Math.PI / 180);
  const xs = poly[0].map((c) => c[0]), ys = poly[0].map((c) => c[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const edgeDist = (x, y) => {
    let best = Infinity;
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
        const dx = (bx - ax) * kx, dy = by - ay;
        const px = (x - ax) * kx, py = y - ay;
        const ll = dx * dx + dy * dy;
        const tt = ll ? Math.max(0, Math.min(1, (px * dx + py * dy) / ll)) : 0;
        best = Math.min(best, Math.hypot(px - tt * dx, py - tt * dy));
      }
    }
    return best;
  };
  let best = null;
  const n = 24;
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < n; j++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * j) / n;
      const p = [y, x];
      if (!pointInRing(p, poly[0]) || poly.slice(1).some((h) => pointInRing(p, h))) continue;
      const d = edgeDist(x, y);
      if (!best || d > best.d) best = { d, p };
    }
  }
  return best ? best.p : [(y0 + y1) / 2, (x0 + x1) / 2];
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function countyStyle(selected) {
  return {
    color: cssVar('--ink-soft'),
    weight: selected ? 2 : 1,
    opacity: selected ? 0.9 : 0.55,
    dashArray: '4 4',
    fill: selected,
    fillColor: cssVar('--toll'),
    fillOpacity: selected ? 0.08 : 0,
  };
}

function pieceStyle(p, mode = 'normal') {
  if (p.toll) {
    return {
      color: cssVar('--toll'),
      weight: mode === 'on' ? 6 : 3.5,
      opacity: mode === 'off' ? 0.25 : 0.95,
      dashArray: null,
      lineCap: 'butt',
    };
  }
  return { color: cssVar('--sign'), weight: 2.5, opacity: mode === 'off' ? 0.2 : 0.8, dashArray: '6 5', lineCap: 'butt' };
}

function restyleNetwork() {
  state.net.pieces.forEach((p, i) => state.pieceLayers[i].setStyle(pieceStyle(p)));
  layers.counties.setStyle(() => countyStyle(false));
  if (state.result) drawRoute();
}

function highlightCounty(cid) {
  state.selectedCounty = cid;
  state.net.pieces.forEach((p, i) => {
    const mode = !cid ? 'normal' : p.counties.includes(cid) ? 'on' : 'off';
    state.pieceLayers[i].setStyle(pieceStyle(p, mode));
  });
  layers.counties.setStyle((f) => countyStyle(f.properties.id === cid));
}

function pointInRing(pt, ring) {
  let inside = false;
  const x = pt[1], y = pt[0];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function countyAt(latlng) {
  for (const f of state.counties.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      if (pointInRing(latlng, poly[0]) && !poly.slice(1).some((hole) => pointInRing(latlng, hole))) {
        return f.properties;
      }
    }
  }
  return null;
}

function countyPriceText(cid) {
  const p = state.prices.categories[state.cat === 'D1M' ? 'D1' : state.cat];
  return state.t('perYear', { price: fmtFt(cid === 'borsod' ? p.countyBorsod : p.county) });
}

function countySections(cid) {
  const out = [];
  for (const [road, rows] of Object.entries(state.net.ranges)) {
    for (const r of rows) if (r.c === cid) out.push({ road, from: r.from, to: r.to, k1: r.k1 });
  }
  const num = (r) => parseInt(r.slice(1), 10);
  return out.sort((a, b) => num(a.road) - num(b.road) || a.k1 - b.k1);
}

function countyBlock(props) {
  const t = state.t;
  const cid = props.vignette;
  if (cid === 'nograd') return `<div class="county"><p class="muted">${esc(t('countyNone'))}</p></div>`;
  const extra = props.id === 'budapest' ? `<p class="muted">${esc(t('countyBudapest'))}</p>` : '';
  return `<div class="county">
    ${extra}
    <button type="button" class="linkbtn" data-county="${cid}" aria-expanded="false">${esc(t('countyVignette', { name: state.net.counties[cid] }))}: ${esc(countyPriceText(cid))}</button>
    <div class="county-detail" hidden>
      <p class="muted">${esc(t('countyValid'))}</p>
      <ul>${countySections(cid).map((s) => `<li><b>${esc(s.road)}</b> ${esc(s.from)} – ${esc(s.to)}</li>`).join('')}</ul>
    </div>
  </div>`;
}

function bindPopup(html, latlng) {
  // DOM content (not a string), so pop.update() keeps the expanded state and the listeners
  const el = document.createElement('div');
  el.innerHTML = html;
  const pop = L.popup({ maxWidth: 320, autoPanPadding: [20, 20] }).setLatLng(latlng).setContent(el);
  el.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => {
    setEnd(b.dataset.set, { latlng: [latlng.lat, latlng.lng], label: null });
    map.closePopup();
  }));
  el.querySelectorAll('[data-county]').forEach((b) => b.addEventListener('click', () => {
    const detail = b.nextElementSibling;
    detail.hidden = !detail.hidden;
    b.setAttribute('aria-expanded', String(!detail.hidden));
    highlightCounty(detail.hidden ? null : b.dataset.county);
    pop.update();
  }));
  pop.openOn(map);
  return pop;
}

function openPointPopup(latlng) {
  const t = state.t;
  const props = countyAt([latlng.lat, latlng.lng]);
  bindPopup(`<div class="pop">
    <div class="acts">
      <button type="button" data-set="from">${esc(t('setFrom'))}</button>
      <button type="button" class="b" data-set="to">${esc(t('setTo'))}</button>
    </div>
    ${props ? `<h4 style="margin-top:10px">${esc(t('countyName', { name: props.name }))}</h4>${countyBlock(props)}` : ''}
  </div>`, latlng);
}

function openPiecePopup(p, latlng) {
  const t = state.t;
  const km = p.km[0] != null ? `${p.km[0]}–${p.km[1]} km` : '';
  const body = p.toll ? t('pieceValid', { list: countyList(p.counties) }) : t('pieceFree');
  const props = countyAt([latlng.lat, latlng.lng]);
  bindPopup(`<div class="pop">
    <h4>${plate(p.road)} <span>${esc(km)}</span></h4>
    <p>${esc(body)}</p>
    <div class="acts" style="margin-top:10px">
      <button type="button" data-set="from">${esc(t('setFrom'))}</button>
      <button type="button" class="b" data-set="to">${esc(t('setTo'))}</button>
    </div>
    ${props ? countyBlock(props) : ''}
  </div>`, latlng);
}

function openGatePopup(g, latlng) {
  const t = state.t;
  bindPopup(`<div class="pop">
    <h4>${esc(t('gate'))} ${esc(g.ref)}</h4>
    <p>${plate(g.r)} ${g.km != null ? esc(`${g.km} km`) : ''}</p>
  </div>`, latlng);
}

function renderLegend() {
  const t = state.t;
  $('#legend').innerHTML = `
    <div><i></i>${esc(t('legend.toll'))}</div>
    <div><i class="free"></i>${esc(t('legend.free'))}</div>
    <div><i class="gate"></i>${esc(t('legend.gate'))}</div>
    <div><i class="county"></i>${esc(t('legend.county'))}</div>`;
}

// ---------------------------------------------------------------- endpoints & search

function pinIcon(which) {
  return L.divIcon({ className: '', html: `<div class="pin pin-${which === 'from' ? 'a' : 'b'}">${which === 'from' ? 'A' : 'B'}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
}

function setInput(end, text) {
  const input = $(`#${end}-input`);
  input.value = text || '';
  input.closest('.input-row').querySelector('.clear').hidden = !text;
}

function drawMarkers() {
  layers.markers.clearLayers();
  for (const end of ['from', 'to']) {
    const e = state.ends[end];
    if (!e) continue;
    L.marker(e.latlng, { icon: pinIcon(end), draggable: true, keyboard: false, zIndexOffset: 1000 })
      .on('dragend', (ev) => {
        const ll = ev.target.getLatLng();
        setEnd(end, { latlng: [ll.lat, ll.lng], label: null });
      })
      .addTo(layers.markers);
  }
}

async function setEnd(end, value, { plan: doPlan = true } = {}) {
  state.ends[end] = value;
  if (value && !value.label) {
    setInput(end, `${value.latlng[0].toFixed(4)}, ${value.latlng[1].toFixed(4)}`);
    reverseGeocode(value.latlng).then((label) => {
      if (state.ends[end] === value) {
        value.label = label || state.t('mapPoint');
        setInput(end, value.label);
        writeHash();
      }
    });
  } else {
    setInput(end, value ? (value.mine ? state.t('myLocation') : value.label) : '');
  }
  drawMarkers();
  writeHash();
  if (doPlan) plan();
}

function initSearch(end) {
  const input = $(`#${end}-input`);
  const list = $(`#${end}-list`);
  const row = input.closest('.input-row');
  let items = [], active = -1, timer = null, ctrl = null;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const render = () => {
    if (!items.length) {
      list.innerHTML = `<li class="empty" role="option" aria-disabled="true">${esc(state.t('noResults'))}</li>`;
    } else {
      list.innerHTML = items.map((it, i) => `<li role="option" id="${end}-opt-${i}" aria-selected="${i === active}">${esc(it.label)}</li>`).join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${end}-opt-${active}`);
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    setEnd(end, { latlng: it.latlng, label: it.label });
    if (!state.ends[end === 'from' ? 'to' : 'from']) map.setView(it.latlng, Math.max(map.getZoom(), 10));
  };
  const search = async (q) => {
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const c = map.getCenter();
    try {
      items = await searchPlaces(q, [c.lat, c.lng], ctrl.signal);
      active = items.length ? 0 : -1;
      if (document.activeElement === input) render();
      return items;
    } catch (e) {
      if (e.name !== 'AbortError') { items = []; render(); }
      return [];
    }
  };

  input.addEventListener('input', () => {
    row.querySelector('.clear').hidden = !input.value;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { close(); return; }
    timer = setTimeout(() => search(q), 250);
  });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden || !items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!list.hidden && items.length) { choose(Math.max(active, 0)); return; }
      const q = input.value.trim();
      if (q.length >= 2) {
        clearTimeout(timer);
        const res = await search(q);
        if (res.length) choose(0);
      }
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('focus', () => { if (input.value && items.length && !state.ends[end]) render(); });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[id]');
    if (!li) return;
    e.preventDefault();
    choose(Number(li.id.split('-').pop()));
  });

  row.querySelector('.clear').addEventListener('click', () => {
    items = [];
    close();
    state.ends[end] = null;
    setInput(end, '');
    drawMarkers();
    clearResult();
    writeHash();
    input.focus();
  });

  const locate = row.querySelector('.locate');
  locate.addEventListener('click', () => {
    if (!navigator.geolocation) { showError(state.t('errGeo')); return; }
    locate.classList.add('busy');
    navigator.geolocation.getCurrentPosition((pos) => {
      locate.classList.remove('busy');
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      setEnd(end, { latlng, label: state.t('myLocation'), mine: true });
      if (!state.ends[end === 'from' ? 'to' : 'from']) map.setView(latlng, 11);
    }, () => {
      locate.classList.remove('busy');
      showError(state.t('errGeo'));
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 });
  });
}

// ---------------------------------------------------------------- planning

function clearResult() {
  if (state.routeAbort) state.routeAbort.abort();
  state.result = null;
  layers.route.clearLayers();
  layers.alt.clearLayers();
  $('#result').innerHTML = '';
  syncLabels();
}

function showError(msg) {
  $('#result').innerHTML = `<p class="error" role="alert">${esc(msg)}</p>`;
}

function analyse(r) {
  const runs = matchRoute(state.net, r.coords);
  // cumulative distances to locate strip segments on the route
  const cum = [0];
  for (let i = 1; i < r.coords.length; i++) cum.push(cum[i - 1] + distance(r.coords[i - 1], r.coords[i]));
  const at = (d) => {
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid + 1; else hi = mid; }
    return r.coords[lo];
  };
  const segs = stripSegments(runs).map((s) => ({
    ...s,
    abroad: !s.road && !countyAt(at((s.from + s.to) / 2)),
  }));
  return { ...r, runs, segs, summary: tollSummary(runs), cum };
}

async function plan() {
  const { from, to } = state.ends;
  if (!from || !to) { clearResult(); return; }
  if (state.routeAbort) state.routeAbort.abort();
  const ctrl = new AbortController();
  state.routeAbort = ctrl;
  layers.alt.clearLayers();
  $('#result').innerHTML = `<p class="loading">${esc(state.t('planning'))}</p>`;
  let r;
  try {
    r = await route(from.latlng, to.latlng, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') return;
    layers.route.clearLayers();
    state.result = null;
    syncLabels();
    showError(state.t(e instanceof RouteError && e.kind === 'noroute' ? 'errRoute' : 'errNetwork'));
    return;
  }
  if (ctrl.signal.aborted) return;
  state.result = analyse(r);
  state.result.alt = state.result.summary.tollLength > 0 ? 'loading' : null;
  renderResult();
  drawRoute();
  fitRoute();

  if (state.result.alt === 'loading') {
    const res = state.result;
    try {
      const alt = await route(from.latlng, to.latlng, { avoidTolls: true, signal: ctrl.signal });
      const a = analyse(alt);
      res.alt = a.summary.tollLength < 500 ? a : 'none';
    } catch (e) {
      if (e.name === 'AbortError') return;
      res.alt = 'none';
    }
    if (state.result === res) renderResult();
  }
}

function drawRoute() {
  layers.route.clearLayers();
  syncLabels();
  const r = state.result;
  if (!r) return;
  L.polyline(r.coords, { pane: 'route', color: '#262b30', weight: 10, opacity: 0.85, interactive: false }).addTo(layers.route);
  // colour the route by toll state
  let i = 0;
  for (const s of r.segs) {
    const pts = [];
    while (i < r.coords.length - 1 && r.cum[i + 1] <= s.from) i++;
    let j = i;
    while (j < r.coords.length && r.cum[j] <= s.to) { pts.push(r.coords[j]); j++; }
    if (j < r.coords.length) pts.push(r.coords[j]);
    if (pts.length < 2) continue;
    L.polyline(pts, {
      pane: 'route',
      color: s.toll ? cssVar('--toll') : cssVar('--sign'),
      weight: 6,
      opacity: 1,
      interactive: false,
    }).addTo(layers.route);
  }
}

function fitRoute() {
  const r = state.result;
  if (!r) return;
  map.fitBounds(L.latLngBounds(r.coords), { padding: [30, 30] });
}

function toggleAlt(btn) {
  const r = state.result;
  if (!r || !r.alt || typeof r.alt !== 'object') return;
  if (layers.alt.getLayers().length) {
    layers.alt.clearLayers();
    btn.textContent = state.t('altShow');
    fitRoute();
    return;
  }
  L.polyline(r.alt.coords, { pane: 'route', color: cssVar('--free'), weight: 5, dashArray: '2 8', lineCap: 'round', opacity: 0.95, interactive: false }).addTo(layers.alt);
  btn.textContent = state.t('altHide');
  map.fitBounds(L.latLngBounds(r.coords).extend(L.latLngBounds(r.alt.coords)), { padding: [30, 30] });
}

// ---------------------------------------------------------------- result rendering

function stripHtml(r) {
  const total = r.segs.reduce((s, x) => s + x.length, 0) || 1;
  const t = state.t;
  const pct = (m) => (m / total) * 100;
  const bar = r.segs.map((s) => {
    const cls = s.toll ? 's-toll' : s.abroad ? 's-abroad' : 's-free';
    return `<i class="${cls}" style="width:${pct(s.length).toFixed(3)}%"></i>`;
  });
  // plates: one per run of the same toll road; labels: one per run of the same county set
  const groups = (key) => {
    const out = [];
    for (const s of r.segs) {
      const k = key(s);
      const last = out[out.length - 1];
      if (last && last.k === k) { last.to = s.to; last.length += s.length; } else out.push({ k, from: s.from, to: s.to, length: s.length, s });
    }
    return out.filter((g) => g.k);
  };
  const at = (g) => `left:${pct((g.from + g.to) / 2).toFixed(2)}%`;
  const plates = groups((s) => (s.toll ? s.road : s.abroad ? '' : ''))
    .filter((g) => pct(g.length) >= 7)
    .map((g) => `<span class="plate" style="${at(g)}">${esc(g.k)}</span>`);
  // labels are dropped when they would collide with the previous one (approximate text width)
  const width = $('#result').clientWidth || 360;
  let lastRight = -Infinity;
  const labels = [];
  for (const g of groups((s) => (s.toll ? s.key : s.abroad ? '~abroad' : ''))) {
    const text = g.k === '~abroad' ? t('abroad') : g.s.counties.map((c) => state.net.counties[c]).join(' / ');
    const center = (pct((g.from + g.to) / 2) / 100) * width;
    const half = (text.length * 6.6) / 2 + 4;
    const pos = Math.min(Math.max(center, half), width - half);
    if (pct(g.length) < 6 || pos - half < lastRight) continue;
    lastRight = pos + half;
    labels.push(`<span style="left:${pos.toFixed(1)}px">${esc(text)}</span>`);
  }
  return `<div class="strip" aria-hidden="true">
    <div class="strip-plates">${plates.join('')}</div>
    <div class="strip-bar">${bar.join('')}</div>
    <div class="strip-labels">${labels.join('')}</div>
    <div class="strip-ends"><span>A</span><span>${esc(fmtKm(r.distance))}</span><span>B</span></div>
  </div>`;
}

function optRow(name, sub, price, best) {
  const eur = fmtEur(price);
  return `<div class="opt${best ? ' best' : ''}">
    <span class="name"${best ? ` data-best="${esc(state.t('cheapest'))}"` : ''}>${esc(name)}</span>
    <span class="price">${esc(fmtFt(price))}${eur ? `<small>${esc(eur)}</small>` : ''}</span>
    <span class="sub">${esc(sub)}</span>
  </div>`;
}

function buyUrl() {
  return `https://ematrica.nemzetiutdij.hu/${state.lang === 'hu' ? 'hu' : 'en'}`;
}

function renderResult() {
  const r = state.result;
  if (!r) return;
  const t = state.t;
  const s = r.summary;
  const need = s.tollLength > 0;
  const { from, to } = state.ends;
  const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${from.latlng.join(',')}&destination=${to.latlng.join(',')}&travelmode=driving`;
  let html = `<h2 class="verdict ${need ? 'need' : 'ok'}">${esc(need ? t('needVignette') : t('noVignette'))}</h2>
    <p class="facts">${esc(fmtKm(r.distance))}, ${esc(fmtTime(r.duration))}${need ? `; ${esc(t('tollPart', { km: fmtKm(s.tollLength) }))}` : ''}</p>`;
  if (need) {
    html += `<ul class="roads">${s.roads.filter((x) => x.length > 1500).map((x) => `<li>${plate(x.road)}</li>`).join('')}</ul>`;
  } else {
    html += `<p class="note">${esc(t('noVignetteSub'))}</p>`;
  }
  html += stripHtml(r);

  if (need) {
    const cat = state.cat;
    const opts = vignetteOptions(s, state.prices, cat, state.trailer);
    const yc = opts.yearCounty;
    let countyName = '', countySub = '';
    if (yc) {
      const list = countyList(yc.counties);
      countyName = yc.m1Regional ? (yc.counties.length ? t('opt.regionalPlus', { list }) : t('opt.regional')) : t('opt.county');
      countySub = yc.m1Regional ? t('opt.year.sub') : `${list}; ${t('opt.year.sub')}`;
    }
    html += `<div class="options">
      <h3>${esc(t('oneTrip'))}</h3>
      ${optRow(t('opt.day'), t('opt.day.sub'), opts.day)}
      ${optRow(t('opt.week'), t('opt.week.sub'), opts.week)}
      ${optRow(t('opt.month'), t('opt.month.sub'), opts.month)}
      <h3>${esc(t('wholeYear'))}</h3>
      ${yc ? optRow(countyName, countySub, yc.price, yc.price < opts.yearNational) : ''}
      ${optRow(t('opt.national'), t('opt.year.sub'), opts.yearNational)}
    </div>
    <a class="buy" href="${buyUrl()}" target="_blank" rel="noopener">${esc(t('buy'))}<small>${esc(t('buyHost'))}</small></a>`;
    if (cat === 'D1') html += `<p class="note">${esc(t('trailerIncluded'))}</p>`;

    if (r.alt === 'loading') {
      html += `<div class="alt"><h3>${esc(t('altTitle'))}</h3><p class="loading">…</p></div>`;
    } else if (r.alt === 'none') {
      html += `<div class="alt"><h3>${esc(t('altTitle'))}</h3><p>${esc(t('altNone'))}</p></div>`;
    } else if (r.alt) {
      const diff = Math.max(0, r.alt.duration - r.duration);
      html += `<div class="alt"><h3>${esc(t('altTitle'))}</h3>
        <p>${esc(t('altLonger', { time: fmtTime(r.alt.duration), dist: fmtKm(r.alt.distance), diff: fmtTime(diff) }))}</p>
        <button type="button" class="linkbtn" id="alt-toggle">${esc(layers.alt.getLayers().length ? t('altHide') : t('altShow'))}</button></div>`;
    }
  }
  html += `<a class="ext" href="${esc(gmaps)}" target="_blank" rel="noopener">${esc(t('gmaps'))}</a>`;
  $('#result').innerHTML = html;
  const btn = $('#alt-toggle');
  if (btn) btn.addEventListener('click', () => toggleAlt(btn));
}

// ---------------------------------------------------------------- prices & guide tabs

function renderPrices() {
  const t = state.t;
  const P = state.prices.categories;
  const cats = ['D1', 'D1M', 'D2', 'U'];
  const head = { D1: t('cat.D1'), D1M: t('cat.D1M'), D2: 'D2', U: t('prices.U').split(':')[0] };
  const rows = [
    ['day', t('prices.day')],
    ['week', t('prices.week')],
    ['month', t('prices.month')],
    ['year', t('prices.year')],
    ['county', t('prices.county')],
    ['countyBorsod', t('prices.borsod')],
    ['m1Regional', t('prices.regional'), t('prices.regionalSub')],
  ];
  const sur = state.prices.surcharge;
  $('#p-prices').innerHTML = `
    <table class="prices">
      <caption>${esc(t('prices.title'))} (Ft)</caption>
      <thead><tr><th scope="col">${esc(t('prices.cat'))}</th>${cats.map((c) => `<th scope="col"><b>${c}</b>${c === 'D2' || c === 'U' ? '' : esc(head[c])}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([k, label, sub]) => `<tr><th scope="row">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</th>${cats.map((c) => `<td>${nf().format(P[c][k])}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
    <p class="note">${esc(t('cat.D2.sub'))}. ${esc(t('prices.U'))}.</p>
    <div class="fine">
      <h3>${esc(t('fine.title'))}</h3>
      <p>${esc(t('fine.base', { price: fmtFt(sur.base) }))}</p>
      <p>${esc(t('fine.raised', { price: fmtFt(sur.raised) }))}</p>
    </div>
    <p class="note"><a href="${esc(state.prices.source)}" target="_blank" rel="noopener">nemzetiutdij.hu</a></p>`;
}

function renderGuide() {
  const t = state.t;
  const checkUrl = 'https://nemzetiutdij.hu/hu/e-matrica-lekerdezo';
  $('#p-guide').innerHTML = `
    <h2>${esc(t('guide.buy'))}</h2>
    <ol>${[1, 2, 3, 4, 5].map((i) => `<li>${esc(t(`guide.buy.${i}`))}</li>`).join('')}</ol>
    <a class="buy" href="${buyUrl()}" target="_blank" rel="noopener">${esc(t('buy'))}<small>${esc(t('buyHost'))}</small></a>

    <h2>${esc(t('guide.cats'))}</h2>
    <ul>${['D1', 'D1M', 'D2', 'U'].map((c) => `<li>${esc(t(`guide.cats.${c}`))}</li>`).join('')}</ul>

    <h2>${esc(t('guide.types'))}</h2>
    <ul>${['day', 'week', 'month', 'year', 'county', 'regional'].map((k) => `<li>${esc(t(`guide.types.${k}`))}</li>`).join('')}</ul>

    <h2>${esc(t('guide.where'))}</h2>
    <ul>
      <li>${esc(t('guide.where.online'))}</li>
      <li>${esc(t('guide.where.mobile'))} <a href="https://nemzetimobilfizetes.hu" target="_blank" rel="noopener">nemzetimobilfizetes.hu</a></li>
      <li>${esc(t('guide.where.shop'))}</li>
    </ul>
    <p style="margin-top:10px"><a href="${checkUrl}" target="_blank" rel="noopener">${esc(t('guide.check'))}</a></p>

    <h2>${esc(t('guide.control'))}</h2>
    <p>${esc(t('guide.control.text'))}</p>
    <div class="fine">
      <h3>${esc(t('fine.title'))}</h3>
      <p>${esc(t('fine.base', { price: fmtFt(state.prices.surcharge.base) }))}</p>
      <p>${esc(t('fine.raised', { price: fmtFt(state.prices.surcharge.raised) }))}</p>
    </div>

    <h2>${esc(t('guide.sources'))}</h2>
    <p class="small">${esc(t('guide.sources.text', { date: state.generated }))}
      <a href="https://nemzetiutdij.hu" target="_blank" rel="noopener">nemzetiutdij.hu</a>,
      <a href="https://njt.hu/jogszabaly/2020-45-20-7Q" target="_blank" rel="noopener">45/2020. ITM</a>,
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>,
      <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noopener">Valhalla</a> (<a href="https://fossgis.de" target="_blank" rel="noopener">FOSSGIS</a>),
      <a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a>,
      <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>.</p>`;
}

// ---------------------------------------------------------------- tabs, hash, init

function initTabs() {
  const tabs = $$('[role="tab"]');
  const select = (tab) => {
    tabs.forEach((x) => {
      const on = x === tab;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      $(`#${x.getAttribute('aria-controls')}`).hidden = !on;
    });
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });
}

function writeHash() {
  const p = new URLSearchParams();
  for (const [k, end] of [['a', 'from'], ['b', 'to']]) {
    const e = state.ends[end];
    if (e) p.set(k, `${e.latlng[0].toFixed(5)},${e.latlng[1].toFixed(5)}${e.label && !e.mine ? `,${e.label}` : ''}`);
  }
  if (state.cat !== 'D1') p.set('cat', state.cat);
  if (state.trailer) p.set('u', '1');
  p.set('lang', state.lang);
  history.replaceState(null, '', `#${p.toString()}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const parseEnd = (v) => {
    if (!v) return null;
    const [lat, lon, ...rest] = v.split(',');
    const latlng = [Number(lat), Number(lon)];
    if (!latlng.every(Number.isFinite)) return null;
    return { latlng, label: rest.join(',') || null };
  };
  return { from: parseEnd(p.get('a')), to: parseEnd(p.get('b')), cat: p.get('cat'), trailer: p.get('u') === '1', lang: p.get('lang') };
}

function initVehicle() {
  const sync = () => {
    $('#trailer-wrap').hidden = state.cat !== 'D2';
    $$('input[name="cat"]').forEach((x) => { x.checked = x.value === state.cat; });
    $('#trailer').checked = state.trailer;
  };
  $$('input[name="cat"]').forEach((x) => x.addEventListener('change', () => {
    state.cat = x.value;
    store.set('cat', state.cat);
    sync();
    writeHash();
    if (state.result) renderResult();
  }));
  $('#trailer').addEventListener('change', (e) => {
    state.trailer = e.target.checked;
    writeHash();
    if (state.result) renderResult();
  });
  sync();
}

async function init() {
  const hash = readHash();
  const [network, prices, counties] = await Promise.all([
    fetch('data/network.json').then((r) => r.json()),
    fetch('data/prices.json').then((r) => r.json()),
    fetch('data/counties.geojson').then((r) => r.json()),
  ]);
  state.net = buildNetwork(network);
  state.generated = network.generated;
  state.prices = prices;
  state.counties = counties;
  state.cat = ['D1', 'D1M', 'D2'].includes(hash.cat) ? hash.cat : (['D1', 'D1M', 'D2'].includes(store.get('cat')) ? store.get('cat') : 'D1');
  state.trailer = hash.trailer;

  const langSel = $('#lang');
  langSel.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  langSel.addEventListener('change', () => applyLang(langSel.value));

  initMap();
  initTabs();
  initSearch('from');
  initSearch('to');
  initVehicle();
  $('#plan').addEventListener('submit', (e) => e.preventDefault());
  $('#swap').addEventListener('click', () => {
    const { from, to } = state.ends;
    state.ends = { from: to, to: from };
    for (const end of ['from', 'to']) {
      const e = state.ends[end];
      setInput(end, e ? (e.mine ? state.t('myLocation') : e.label) : '');
    }
    drawMarkers();
    writeHash();
    plan();
  });

  // crawlers get the language of the URL (Hungarian without ?lang=), people get their browser language
  const isBot = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|lighthouse/i.test(navigator.userAgent);
  applyLang(pickLang(hash.lang || new URLSearchParams(location.search).get('lang') || store.get('lang'), !isBot));

  if (hash.from) await setEnd('from', hash.from, { plan: false });
  if (hash.to) await setEnd('to', hash.to, { plan: false });
  plan();

  eurRate().then((rate) => {
    state.rate = rate;
    if (state.result) renderResult();
  });
}

init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin', `<p class="error" role="alert" style="padding:16px">${esc(String(e))}</p>`);
});
