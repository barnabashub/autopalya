// Pure logic: route ↔ toll network matching and vignette recommendation.
// No DOM access, so it runs in the browser and under `node --test`.

const R = 6371008.8;
const RAD = Math.PI / 180;

export function decodePolyline(str, precision = 5) {
  const f = 10 ** precision;
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lon += d;
    }
    out.push([lat / f, lon / f]);
  }
  return out;
}

export function distance(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const y = Math.sin((b[1] - a[1]) * RAD) * Math.cos(b[0] * RAD);
  const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) -
    Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos((b[1] - a[1]) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

const CELL = 0.005; // degrees, ~550 m north-south
const KX = Math.cos(47.2 * RAD);

/** Decodes the pieces of network.json and builds a grid index over their segments. */
export function buildNetwork(network) {
  const pieces = network.pieces.map((p, id) => ({
    id, road: p.r, counties: p.c, km: p.k, oneway: p.o === 1,
    toll: p.c.length > 0, pts: decodePolyline(p.p),
  }));
  const grid = new Map();
  for (const piece of pieces) {
    const pts = piece.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const seg = { piece, a, b, brg: bearing(a, b) };
      const x0 = Math.floor(Math.min(a[1], b[1]) / CELL), x1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      const y0 = Math.floor(Math.min(a[0], b[0]) / CELL), y1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const k = x + ':' + y;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(seg);
        }
      }
    }
  }
  return { pieces, grid, ranges: network.ranges, counties: network.counties, gates: network.gates };
}

function segDistance(p, a, b) {
  const ax = a[1] * KX, ay = a[0], bx = b[1] * KX, by = b[0], px = p[1] * KX, py = p[0];
  const dx = bx - ax, dy = by - ay;
  const ll = dx * dx + dy * dy;
  const t = ll === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / ll));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy) * 111200;
}

const MATCH_DIST = 22;   // m: route geometry vs. network geometry (simplified at 4 m)
const MATCH_ANGLE = 35;  // degrees
const STEP = 20;         // m: sampling distance along the route

function nearestPiece(net, p, brg) {
  const cx = Math.floor(p[1] / CELL), cy = Math.floor(p[0] / CELL);
  let best = null, bestD = MATCH_DIST;
  for (let x = cx - 1; x <= cx + 1; x++) {
    for (let y = cy - 1; y <= cy + 1; y++) {
      const segs = net.grid.get(x + ':' + y);
      if (!segs) continue;
      for (const s of segs) {
        const diff = angleDiff(brg, s.brg);
        const ok = s.piece.oneway ? diff < MATCH_ANGLE : Math.min(diff, 180 - diff) < MATCH_ANGLE;
        if (!ok) continue;
        const d = segDistance(p, s.a, s.b);
        if (d < bestD) { bestD = d; best = s.piece; }
      }
    }
  }
  return best;
}

/**
 * Walks along the route and returns runs of consecutive samples on the same network piece
 * (or off the network): [{piece|null, length, from, to}] where from/to are route distances in m.
 */
export function matchRoute(net, coords) {
  const runs = [];
  let along = 0;
  const push = (piece, len) => {
    const last = runs[runs.length - 1];
    if (last && last.piece === piece) { last.length += len; last.to += len; }
    else runs.push({ piece, length: len, from: along, to: along + len });
  };
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const d = distance(a, b);
    if (d === 0) continue;
    const brg = bearing(a, b);
    const n = Math.max(1, Math.ceil(d / STEP));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      push(nearestPiece(net, p, brg), d / n);
      along += d / n;
    }
  }
  return smoothRuns(runs);
}

const MIN_RUN = 150; // m: shorter network hits are crossings or ramps, not real use

function smoothRuns(runs) {
  const out = [];
  for (const r of runs) {
    const piece = r.piece && r.length < MIN_RUN ? null : r.piece;
    const last = out[out.length - 1];
    if (last && last.piece === piece) { last.length += r.length; last.to = r.to; }
    else out.push({ ...r, piece });
  }
  return out;
}

/** Groups matched runs into strip-map segments: consecutive runs with the same road, toll state and counties. */
export function stripSegments(runs) {
  const segs = [];
  for (const r of runs) {
    const road = r.piece ? r.piece.road : null;
    const toll = !!(r.piece && r.piece.toll);
    const counties = toll ? [...r.piece.counties].sort() : [];
    const key = counties.join(',');
    const last = segs[segs.length - 1];
    if (last && last.road === road && last.toll === toll && last.key === key) {
      last.length += r.length;
      last.to = r.to;
    } else {
      segs.push({ road, toll, key, counties, length: r.length, from: r.from, to: r.to });
    }
  }
  return segs;
}

/** Summary of toll usage: total toll length, roads used, and the coverage requirements. */
export function tollSummary(runs) {
  let tollLength = 0;
  const roads = new Map();
  const requirements = new Map(); // key -> county list; each must be covered by a chosen county
  for (const r of runs) {
    if (!r.piece || !r.piece.toll) continue;
    tollLength += r.length;
    roads.set(r.piece.road, (roads.get(r.piece.road) || 0) + r.length);
    const cs = [...r.piece.counties].sort();
    requirements.set(cs.join(','), cs);
  }
  return {
    tollLength,
    roads: [...roads.entries()].map(([road, length]) => ({ road, length })),
    requirements: [...requirements.values()],
  };
}

/**
 * Cheapest set of annual county vignettes (optionally with the M1 regional vignette) that covers
 * every requirement. Returns { counties: [...], m1Regional: bool, price } or null if none needed.
 */
export function cheapestAnnual(requirements, prices, category) {
  if (!requirements.length) return null;
  const p = prices.categories[category];
  const countyPrice = (c) => (c === 'borsod' ? p.countyBorsod : p.county);
  const involved = [...new Set(requirements.flat())].sort();
  const regional = new Set(prices.m1RegionalCounties);
  let best = null;
  const total = 1 << involved.length;
  for (const useRegional of [false, true]) {
    if (useRegional && !requirements.some((req) => req.some((c) => regional.has(c)))) continue;
    for (let mask = 0; mask < total; mask++) {
      const chosen = involved.filter((_, i) => mask & (1 << i));
      if (useRegional && chosen.some((c) => regional.has(c))) continue;
      const covered = (c) => chosen.includes(c) || (useRegional && regional.has(c));
      if (!requirements.every((req) => req.some(covered))) continue;
      const price = chosen.reduce((s, c) => s + countyPrice(c), 0) + (useRegional ? p.m1Regional : 0);
      const better = !best || price < best.price ||
        (price === best.price && chosen.length + useRegional < best.counties.length + best.m1Regional);
      if (better) best = { counties: chosen, m1Regional: useRegional, price };
    }
  }
  return best;
}

/** All purchase options for a route, cheapest first within each validity period. */
export function vignetteOptions(summary, prices, category, withTrailer = false) {
  const p = prices.categories[category];
  const u = withTrailer && category === 'D2' ? prices.categories.U : null;
  const add = (k) => p[k] + (u ? u[k] : 0);
  const annual = cheapestAnnual(summary.requirements, prices, category);
  let annualTrailer = null;
  if (u && annual) annualTrailer = cheapestAnnual(summary.requirements, prices, 'U');
  return {
    day: add('day'),
    week: add('week'),
    month: add('month'),
    yearNational: add('year'),
    yearCounty: annual && {
      ...annual,
      price: annual.price + (annualTrailer ? annualTrailer.price : 0),
    },
  };
}

/** Pieces covered by an annual vignette of the given county (for highlighting on the map). */
export function piecesForCounty(net, county) {
  return net.pieces.filter((p) => p.counties.includes(county));
}
