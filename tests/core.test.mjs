import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  decodePolyline, buildNetwork, matchRoute, tollSummary, stripSegments, cheapestAnnual, vignetteOptions,
} from '../js/core.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url)));
const network = read('../data/network.json');
const prices = read('../data/prices.json');
const annex = read('../data/source/annex1.json');
const net = buildNetwork(network);

function analyse(fixture) {
  const d = read(`./fixtures/${fixture}.json`);
  const coords = d.trip.legs.flatMap((l) => decodePolyline(l.shape, 6));
  const runs = matchRoute(net, coords);
  return { runs, summary: tollSummary(runs), segs: stripSegments(runs) };
}

test('decodes Google encoded polylines', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('every county range of the decree has map geometry', () => {
  for (const [cid, road] of annex.rows) {
    assert.ok(net.pieces.some((p) => p.road === road && p.counties.includes(cid)), `${cid} ${road}`);
  }
});

test('network has control gates and toll pieces', () => {
  assert.ok(net.gates.length >= 50);
  assert.ok(net.pieces.filter((p) => p.toll).length > 50);
});

test('prices are complete for every category', () => {
  for (const cat of ['D1', 'D1M', 'D2', 'U']) {
    for (const k of ['day', 'week', 'month', 'year', 'county', 'countyBorsod', 'm1Regional']) {
      assert.ok(Number.isInteger(prices.categories[cat][k]) && prices.categories[cat][k] > 0, `${cat}.${k}`);
    }
  }
});

test('Budapest – Győr: M1, cheapest annual is the M1 regional vignette', () => {
  const { summary } = analyse('bp-gyor');
  assert.ok(summary.tollLength > 95000 && summary.tollLength < 115000, String(summary.tollLength));
  assert.ok(summary.roads.some((r) => r.road === 'M1' && r.length > 80000));
  const best = cheapestAnnual(summary.requirements, prices, 'D1');
  assert.deepEqual(best, { counties: [], m1Regional: true, price: 15000 });
});

test('Budapest – Siófok: Pest + Fejér + Somogy (or Veszprém)', () => {
  const { summary } = analyse('bp-siofok');
  const best = cheapestAnnual(summary.requirements, prices, 'D1');
  assert.equal(best.price, 3 * 7190);
  assert.ok(best.counties.includes('pest') && best.counties.includes('fejer'));
  assert.ok(best.counties.includes('somogy') || best.counties.includes('veszprem'));
});

test('Budapest – Szeged: Pest + Bács-Kiskun + Csongrád-Csanád', () => {
  const { summary } = analyse('bp-szeged');
  const best = cheapestAnnual(summary.requirements, prices, 'D1');
  assert.deepEqual(best.counties, ['bacs-kiskun', 'csongrad', 'pest']);
  assert.equal(best.m1Regional, false);
});

test('Miskolc – Debrecen uses the discounted Borsod vignette', () => {
  const { summary } = analyse('miskolc-debrecen');
  const best = cheapestAnnual(summary.requirements, prices, 'D1');
  assert.deepEqual(best, { counties: ['borsod', 'hajdu'], m1Regional: false, price: 2500 + 7190 });
});

test('Vienna – Budapest: the Austrian part is off the network', () => {
  const { summary, segs } = analyse('wien-bp');
  assert.equal(segs[0].road, null);
  assert.ok(segs[0].length > 50000);
  assert.equal(cheapestAnnual(summary.requirements, prices, 'D1').m1Regional, true);
});

test('city trip inside Budapest needs no vignette', () => {
  const { summary } = analyse('bp-city');
  assert.equal(summary.tollLength, 0);
  assert.equal(cheapestAnnual(summary.requirements, prices, 'D1'), null);
});

test('D2 with trailer adds the U price to every option', () => {
  const { summary } = analyse('bp-szeged');
  const plain = vignetteOptions(summary, prices, 'D2', false);
  const withU = vignetteOptions(summary, prices, 'D2', true);
  assert.equal(withU.week, plain.week + prices.categories.U.week);
  assert.equal(withU.yearCounty.price, plain.yearCounty.price + 3 * prices.categories.U.county);
  // a trailer behind a D1 car is included
  assert.equal(vignetteOptions(summary, prices, 'D1', true).week, prices.categories.D1.week);
});

test('i18n: every language has every key', async () => {
  globalThis.navigator ??= { languages: ['hu'] };
  const { missingKeys } = await import('../js/i18n.js');
  assert.deepEqual(missingKeys(), {});
});
