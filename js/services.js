// External services: geocoding (Photon), routing (Valhalla, OSRM fallback), EUR rate (ECB via Frankfurter).
import { decodePolyline } from './core.js';

const PHOTON = 'https://photon.komoot.io';
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const OSRM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving';
const RATE = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=HUF';

export class RouteError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // 'noroute' | 'network'
  }
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

function placeLabel(p) {
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const town = p.city || p.town || p.village || p.district || p.county;
  const parts = [];
  if (p.name && p.name !== town) parts.push(p.name);
  if (street && street !== p.name) parts.push(street);
  if (town) parts.push(town);
  if (p.countrycode && p.countrycode !== 'HU' && p.country) parts.push(p.country);
  return [...new Set(parts)].join(', ') || p.country || '';
}

/** Place search, biased towards the current map centre. */
export async function searchPlaces(query, bias, signal) {
  const params = new URLSearchParams({ q: query, limit: '6' });
  if (bias) {
    params.set('lat', bias[0].toFixed(3));
    params.set('lon', bias[1].toFixed(3));
  }
  const { ok, body } = await getJson(`${PHOTON}/api/?${params}`, signal);
  if (!ok || !body) throw new RouteError('network');
  const seen = new Set();
  return body.features
    .map((f) => ({ label: placeLabel(f.properties), latlng: [f.geometry.coordinates[1], f.geometry.coordinates[0]] }))
    .filter((r) => r.label && !seen.has(r.label) && seen.add(r.label));
}

export async function reverseGeocode(latlng) {
  try {
    const { ok, body } = await getJson(`${PHOTON}/reverse?lat=${latlng[0]}&lon=${latlng[1]}&limit=1`);
    if (ok && body.features.length) return placeLabel(body.features[0].properties);
  } catch { /* the coordinates are still usable without a name */ }
  return null;
}

/**
 * Car route between two points. Returns { coords, distance (m), duration (s) }.
 * avoidTolls asks Valhalla for a toll-free route (no fallback for that variant).
 */
export async function route(from, to, { avoidTolls = false, signal } = {}) {
  const req = {
    locations: [{ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }],
    costing: 'auto',
    costing_options: { auto: { use_tolls: avoidTolls ? 0 : 1 } },
    directions_type: 'none',
  };
  try {
    const { ok, body } = await getJson(`${VALHALLA}?json=${encodeURIComponent(JSON.stringify(req))}`, signal);
    if (ok && body.trip) {
      return {
        coords: body.trip.legs.flatMap((l) => decodePolyline(l.shape, 6)),
        distance: body.trip.summary.length * 1000,
        duration: body.trip.summary.time,
        engine: 'valhalla',
      };
    }
    if (avoidTolls) throw new RouteError(body && body.error_code === 442 ? 'noroute' : 'network');
  } catch (e) {
    if (e.name === 'AbortError' || avoidTolls) throw e;
  }
  // fallback: OSRM (no toll avoidance, but the toll analysis is done on our side anyway)
  let res;
  try {
    res = await getJson(`${OSRM}/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=polyline6`, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new RouteError('network');
  }
  if (res.ok && res.body.routes && res.body.routes.length) {
    const r = res.body.routes[0];
    return { coords: decodePolyline(r.geometry, 6), distance: r.distance, duration: r.duration, engine: 'osrm' };
  }
  throw new RouteError(res.body && res.body.code === 'NoRoute' ? 'noroute' : 'network');
}

export async function eurRate() {
  try {
    const { ok, body } = await getJson(RATE);
    if (ok && body.rates && body.rates.HUF) return body.rates.HUF;
  } catch { /* prices are shown in HUF only */ }
  return null;
}
