#!/usr/bin/env python3
"""Builds the static data files of the site from OpenStreetMap and the toll decree.

Inputs
  data/source/annex1.json   county validity ranges (45/2020 ITM decree, annex 1)
  OSM API                   motorway route relations (geometry, junction numbers, gantries)
  Nominatim                 county boundary polygons

Outputs
  data/network.json         road pieces with the counties whose vignette covers them, gates
  data/counties.geojson     simplified county polygons

Usage
  python3 tools/build_data.py fetch   # download raw data into tools/.cache
  python3 tools/build_data.py build   # build data/*.json from the cache
  python3 tools/build_data.py all

Only the Python standard library is used.
"""
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", ".cache")
DATA = os.path.join(ROOT, "data")
UA = "autopalya-data-build/1.0 (+https://github.com/barnabashub/autopalya)"

# OSM route relations of the Hungarian expressway network (from Wikidata P402).
ROADS = {
    "M0": 21750, "M1": 21313, "M2": 21741, "M3": 21316, "M4": 9758619, "M5": 23070,
    "M6": 23086, "M7": 21311, "M8": 23087, "M9": 21737, "M15": 21742, "M19": 21743,
    "M25": 9556422, "M30": 23060, "M31": 4179367, "M35": 23062, "M43": 23064,
    "M44": 9384418, "M49": 17997994, "M51": 9807893, "M60": 1028298, "M70": 21739,
    "M76": 12565567, "M80": 9557828, "M85": 8141488, "M86": 225681,
}

COUNTIES = {
    "bacs-kiskun": ("Bács-Kiskun", 22260),
    "baranya": ("Baranya", 22234),
    "bekes": ("Békés", 22266),
    "borsod": ("Borsod-Abaúj-Zemplén", 22271),
    "csongrad": ("Csongrád-Csanád", 22265),
    "fejer": ("Fejér", 22255),
    "gyor": ("Győr-Moson-Sopron", 22249),
    "hajdu": ("Hajdú-Bihar", 22267),
    "heves": ("Heves", 22273),
    "jasz": ("Jász-Nagykun-Szolnok", 26935),
    "komarom": ("Komárom-Esztergom", 22252),
    "nograd": ("Nógrád", 22274),
    "pest": ("Pest", 22259),
    "somogy": ("Somogy", 22225),
    "szabolcs": ("Szabolcs-Szatmár-Bereg", 22268),
    "tolna": ("Tolna", 22239),
    "vas": ("Vas", 22250),
    "veszprem": ("Veszprém", 22278),
    "zala": ("Zala", 22238),
    "budapest": ("Budapest", 1244004),
}


# ---------------------------------------------------------------- fetch

def http_get(url, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                body = r.read()
            if body.startswith(b"You have downloaded too much"):
                raise IOError("rate limited")
            return body
        except Exception as e:  # noqa: BLE001 - retry on any network error
            wait = 10 * (i + 1)
            print(f"  {e}; retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"failed: {url}")


def fetch():
    os.makedirs(os.path.join(CACHE, "osm"), exist_ok=True)
    for ref, rel in ROADS.items():
        path = os.path.join(CACHE, "osm", f"{ref}.xml")
        print(f"OSM {ref} r{rel}")
        body = http_get(f"https://api.openstreetmap.org/api/0.6/relation/{rel}/full")
        with open(path, "wb") as f:
            f.write(body)
        time.sleep(5)
    ids = ",".join(f"R{v[1]}" for v in COUNTIES.values())
    q = urllib.parse.urlencode({
        "osm_ids": ids, "format": "json", "polygon_geojson": 1, "polygon_threshold": 0.002,
    })
    print("Nominatim counties")
    body = http_get(f"https://nominatim.openstreetmap.org/lookup?{q}")
    with open(os.path.join(CACHE, "counties.json"), "wb") as f:
        f.write(body)


# ---------------------------------------------------------------- geometry helpers

def hav(a, b):
    """Distance in metres between (lat, lon) points."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def simplify(pts, tol_m):
    """Douglas-Peucker on (lat, lon) points with a tolerance in metres."""
    if len(pts) < 3:
        return pts
    lat0 = math.radians(pts[0][0])
    kx, ky = 111320 * math.cos(lat0), 110540
    xy = [(p[1] * kx, p[0] * ky) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = xy[i]
        bx, by = xy[j]
        dx, dy = bx - ax, by - ay
        ll = dx * dx + dy * dy
        best, bi = -1, -1
        for k in range(i + 1, j):
            px, py = xy[k]
            if ll == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / ll))
                d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if d > best:
                best, bi = d, k
        if best > tol_m:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [p for p, k in zip(pts, keep) if k]


def encode_polyline(pts, precision=5):
    """Google encoded polyline of (lat, lon) points."""
    f = 10 ** precision
    out, plat, plon = [], 0, 0
    for lat, lon in pts:
        ilat, ilon = round(lat * f), round(lon * f)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


# ---------------------------------------------------------------- OSM parsing

def parse_osm(path):
    root = ET.parse(path).getroot()
    nodes = {}
    for n in root.iter("node"):
        tags = {t.get("k"): t.get("v") for t in n.iter("tag")}
        nodes[int(n.get("id"))] = (float(n.get("lat")), float(n.get("lon")), tags)
    ways = {}
    for w in root.iter("way"):
        tags = {t.get("k"): t.get("v") for t in w.iter("tag")}
        ways[int(w.get("id"))] = {"nodes": [int(nd.get("ref")) for nd in w.iter("nd")], "tags": tags}
    rel = root.find("relation")
    members = [int(m.get("ref")) for m in rel.iter("member") if m.get("type") == "way"]
    return nodes, ways, members


def is_mainline(tags):
    hw = tags.get("highway", "")
    return hw in ("motorway", "trunk", "primary", "secondary", "tertiary", "unclassified") or (
        hw == "construction" and False)


def direction(tags):
    """+1 forward only, -1 backward only, 0 both ways."""
    ow = tags.get("oneway")
    if ow in ("yes", "1", "true"):
        return 1
    if ow == "-1":
        return -1
    if ow == "no":
        return 0
    if tags.get("highway") == "motorway" or tags.get("junction") == "roundabout":
        return 1
    return 0


def build_chains(nodes, ways, members):
    """Splits the mainline of a route relation into long continuous directed chains."""
    items = []  # (way_id, node list in travel direction)
    for wid in dict.fromkeys(members):
        w = ways.get(wid)
        if not w or not is_mainline(w["tags"]) or len(w["nodes"]) < 2:
            continue
        d = direction(w["tags"])
        if d >= 0:
            items.append((wid, w["nodes"]))
        if d <= 0:
            items.append((wid, w["nodes"][::-1]))
    length = [sum(hav(nodes[a][:2], nodes[b][:2]) for a, b in zip(n, n[1:])) for _, n in items]
    by_start = {}
    for i, (_, n) in enumerate(items):
        by_start.setdefault(n[0], []).append(i)

    used_ways = set()
    chains = []
    while True:
        memo = {}

        def best_from(i, stack):
            if i in memo:
                return memo[i]
            stack.add(i)
            best, nxt = 0.0, None
            for j in by_start.get(items[i][1][-1], []):
                if j in stack or items[j][0] in used_ways or items[j][0] == items[i][0]:
                    continue
                v = best_from(j, stack)[0]
                if v > best:
                    best, nxt = v, j
            stack.discard(i)
            res = (length[i] + best, nxt)
            memo[i] = res
            return res

        sys.setrecursionlimit(100000)
        cand = [(best_from(i, set())[0], i) for i in range(len(items)) if items[i][0] not in used_ways]
        if not cand:
            break
        total, start = max(cand)
        if total < 300:
            break
        seq, i = [], start
        while i is not None:
            seq.append(i)
            i = memo[i][1]
        node_seq = []
        for i in seq:
            n = items[i][1]
            node_seq += n if not node_seq else n[1:]
            used_ways.add(items[i][0])
        way_seq = []
        for i in seq:
            way_seq += [items[i][0]] * (len(items[i][1]) - 1)
        chains += split_u_turns(node_seq, way_seq, nodes, ways)
    return chains


def bearing(a, b):
    y = math.sin(math.radians(b[1] - a[1])) * math.cos(math.radians(b[0]))
    x = math.cos(math.radians(a[0])) * math.sin(math.radians(b[0])) - \
        math.sin(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.cos(math.radians(b[1] - a[1]))
    return math.degrees(math.atan2(y, x)) % 360


def split_u_turns(node_seq, way_seq, nodes, ways):
    """A chain may run to the end of a road, turn around and come back on the other
    carriageway. Cut it where it starts running alongside itself in the opposite direction
    and drop the turning loop."""
    pts = [nodes[n][:2] for n in node_seq]
    s = [0.0]
    for a, b in zip(pts, pts[1:]):
        s.append(s[-1] + hav(a, b))
    cell = 0.002  # ~200 m
    grid = {}
    kx = math.cos(math.radians(47.2))

    def seg_dist(p, a, b):
        ax, ay = a[1] * kx, a[0]
        bx, by = b[1] * kx, b[0]
        px, py = p[1] * kx, p[0]
        dx, dy = bx - ax, by - ay
        ll = dx * dx + dy * dy
        t = 0 if ll == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / ll))
        return math.hypot(px - ax - t * dx, py - ay - t * dy) * 111200

    cut_at = None
    for i in range(1, len(pts)):
        p = pts[i]
        cx, cy = int(p[1] / cell), int(p[0] / cell)
        hit = None
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                for j in grid.get((gx, gy), ()):
                    if s[j + 1] < s[i] - 1500 and seg_dist(p, pts[j], pts[j + 1]) < 100:
                        d = abs((bearing(pts[i - 1], p) - bearing(pts[j], pts[j + 1]) + 180) % 360 - 180)
                        if d > 150:
                            hit = j
                            break
                if hit is not None:
                    break
            if hit is not None:
                break
        if hit is not None:
            cut_at = (hit, i)
            break
        j = i - 1
        a, b = pts[j], pts[i]
        for gx in range(int(min(a[1], b[1]) / cell), int(max(a[1], b[1]) / cell) + 1):
            for gy in range(int(min(a[0], b[0]) / cell), int(max(a[0], b[0]) / cell) + 1):
                grid.setdefault((gx, gy), []).append(j)

    def make(ns, ws):
        return {"nodes": ns, "ways": list(dict.fromkeys(ws)), "seg_ways": ws,
                "oneway": all(direction(ways[w]["tags"]) != 0 for w in ws)}

    if cut_at is None:
        return [make(node_seq, way_seq)]
    j, i = cut_at
    # extend the outbound leg up to where it starts to turn, start the return leg where it stops turning
    out_b = bearing(pts[j], pts[j + 1])
    k = j + 1
    while k < i and abs((bearing(pts[k], pts[k + 1]) - out_b + 180) % 360 - 180) < 60:
        k += 1
    back_b = bearing(pts[i - 1], pts[i])
    m = i - 1
    while m > k and abs((bearing(pts[m - 1], pts[m]) - back_b + 180) % 360 - 180) < 60:
        m -= 1
    first = make(node_seq[: k + 1], way_seq[:k])
    rest = split_u_turns(node_seq[m:], way_seq[m:], nodes, ways)
    return ([first] if s[j] > 300 else []) + [c for c in rest if len(c["nodes"]) > 1]


# ---------------------------------------------------------------- chainage (km) calibration

def filter_calibration(cal):
    """Returns (points, sign) with points whose km values contradict their neighbours removed."""
    cal = list(cal)
    if len(cal) >= 2:
        votes = sum(1 if b[1] > a[1] else -1 for a, b in zip(cal, cal[1:]) if b[1] != a[1])
        sign = 1 if votes >= 0 else -1
    else:
        return cal, 0
    changed = True
    while changed and len(cal) >= 3:
        changed = False
        bad = []
        for k in range(len(cal)):
            viol = 0.0
            for m in (k - 1, k + 1):
                if 0 <= m < len(cal):
                    ds = (cal[max(k, m)][0] - cal[min(k, m)][0]) / 1000
                    dk = cal[max(k, m)][1] - cal[min(k, m)][1]
                    if ds < 0.2:
                        viol += 0 if abs(dk) < 1.5 else abs(dk)
                        continue
                    sl = dk / ds * sign
                    if not 0.8 <= sl <= 1.25:
                        viol += abs(sl - 1) * ds
            bad.append(viol)
        worst = max(range(len(cal)), key=lambda k: bad[k])
        if bad[worst] > 0:
            cal.pop(worst)
            changed = True
    if len(cal) == 2 and (cal[1][1] - cal[0][1]) * sign <= 0:
        return [], 0
    return cal, sign


def calibrate(chain, nodes):
    pts = [nodes[n][:2] for n in chain["nodes"]]
    s = [0.0]
    for a, b in zip(pts, pts[1:]):
        s.append(s[-1] + hav(a, b))
    chain["pts"], chain["s"] = pts, s
    junctions, milestones = [], []
    for idx, nid in enumerate(chain["nodes"]):
        tags = nodes[nid][2]
        if tags.get("highway") == "motorway_junction" and re.fullmatch(r"\d+", tags.get("ref", "")):
            junctions.append((s[idx], float(tags["ref"]), "j" + tags["ref"]))
        elif tags.get("highway") == "milestone" and re.fullmatch(r"\d+(\.\d+)?", tags.get("distance", "")):
            milestones.append((s[idx], float(tags["distance"]), "m"))
    # junction numbers are the primary reference; milestones only fill gaps where they agree
    cal, sign = filter_calibration(sorted(junctions))
    if len(cal) >= 2:
        tmp = {"cal": cal, "sign": sign}
        cal = sorted(cal + [m for m in milestones if abs(km_at(tmp, m[0]) - m[1]) < 1.0])
    else:
        cal, sign = filter_calibration(sorted(junctions + milestones))
    chain["cal"] = cal
    chain["sign"] = sign
    return chain


def borrow_calibration(chains):
    """A carriageway without junction numbers takes its km values from the parallel one."""
    good = [c for c in chains if len(c["cal"]) >= 2]
    kx = math.cos(math.radians(47.2))
    for ch in chains:
        if len(ch["cal"]) >= 2 or not good:
            continue
        cal, last = [], -1e9
        for idx, p in enumerate(ch["pts"]):
            if ch["s"][idx] - last < 500 and idx != len(ch["pts"]) - 1:
                continue
            best = None
            for g in good:
                for i in range(len(g["pts"]) - 1):
                    a, b = g["pts"][i], g["pts"][i + 1]
                    ax, ay, bx, by = a[1] * kx, a[0], b[1] * kx, b[0]
                    px, py = p[1] * kx, p[0]
                    dx, dy = bx - ax, by - ay
                    ll = dx * dx + dy * dy
                    tt = 0 if ll == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / ll))
                    d = math.hypot(px - ax - tt * dx, py - ay - tt * dy) * 111200
                    if best is None or d < best[0]:
                        best = (d, g, g["s"][i] + tt * (g["s"][i + 1] - g["s"][i]))
            if best and best[0] < 300:
                cal.append((ch["s"][idx], km_at(best[1], best[2]), "p"))
                last = ch["s"][idx]
        ch["cal"], ch["sign"] = filter_calibration(cal)


def km_at(chain, sv):
    cal, sign = chain["cal"], chain["sign"]
    if not cal:
        return None
    if len(cal) == 1:
        return None
    if sv <= cal[0][0]:
        return cal[0][1] + sign * (sv - cal[0][0]) / 1000
    if sv >= cal[-1][0]:
        return cal[-1][1] + sign * (sv - cal[-1][0]) / 1000
    for a, b in zip(cal, cal[1:]):
        if a[0] <= sv <= b[0]:
            if b[0] == a[0]:
                return a[1]
            return a[1] + (b[1] - a[1]) * (sv - a[0]) / (b[0] - a[0])
    return None


def s_for_km(chain, km):
    """Inverse of km_at (km is monotonic along the chain)."""
    lo, hi = 0.0, chain["s"][-1]
    k_lo, k_hi = km_at(chain, lo), km_at(chain, hi)
    if (km - k_lo) * (km - k_hi) > 0:
        return None
    for _ in range(60):
        mid = (lo + hi) / 2
        if (km_at(chain, mid) - km) * (k_lo - km) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def cut(chain, s_from, s_to):
    pts, s = chain["pts"], chain["s"]
    out = []

    def interp(sv):
        for i in range(1, len(s)):
            if s[i] >= sv:
                t = 0 if s[i] == s[i - 1] else (sv - s[i - 1]) / (s[i] - s[i - 1])
                a, b = pts[i - 1], pts[i]
                return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        return pts[-1]

    out.append(interp(s_from))
    for i in range(len(s)):
        if s_from < s[i] < s_to:
            out.append(pts[i])
    out.append(interp(s_to))
    return out


# ---------------------------------------------------------------- build

def build():
    annex = json.load(open(os.path.join(DATA, "source", "annex1.json"), encoding="utf-8"))
    ranges = {}
    for cid, road, k1, j1, n1, k2, j2, n2 in annex["rows"]:
        # a boundary at a numbered junction is placed at the junction (= its number in km)
        a = float(j1) if j1 is not None else k1
        b = float(j2) if j2 is not None else k2
        # ranges starting at the road's origin or ending at the state border run to the chain ends
        if k1 == 0:
            a = -50.0
        if "országhatár" in n2:
            b += 50.0
        ranges.setdefault(road, []).append({"c": cid, "a": min(a, b), "b": max(a, b),
                                            "from": n1, "to": n2, "j1": j1, "j2": j2, "k1": k1, "k2": k2})

    pieces, gates, report = [], {}, []
    for ref in ROADS:
        path = os.path.join(CACHE, "osm", f"{ref}.xml")
        nodes, ways, members = parse_osm(path)
        chains = [calibrate(c, nodes) for c in build_chains(nodes, ways, members)]
        borrow_calibration(chains)
        rr = ranges.get(ref, [])
        bounds = sorted({r["a"] for r in rr} | {r["b"] for r in rr})
        toll_len = mismatch = 0.0
        for ch in chains:
            total = ch["s"][-1]
            if ch["sign"] == 0 or len(ch["cal"]) < 2:
                # uncalibrated: inherit from OSM toll tagging, no county information
                report.append(f"  ! {ref}: chain {total/1000:.1f} km without calibration (ways {ch['ways'][:3]}…)")
                seg_cuts = [0.0, total]
            else:
                seg_cuts = sorted({0.0, total} | {sv for sv in (s_for_km(ch, k) for k in bounds) if sv is not None})
            way_at = ch["seg_ways"]  # way id for each segment of the chain
            for s1, s2 in zip(seg_cuts, seg_cuts[1:]):
                if s2 - s1 < 1:
                    continue
                if ch["sign"] != 0 and len(ch["cal"]) >= 2:
                    k1, k2 = km_at(ch, s1), km_at(ch, s2)
                    km_mid = (k1 + k2) / 2
                    cs = sorted({r["c"] for r in rr if r["a"] - 1e-6 <= km_mid <= r["b"] + 1e-6})
                else:
                    k1 = k2 = None
                    cs = []
                # OSM toll tag along this piece (length weighted), used for self-check / fallback
                osm_toll = 0.0
                for i in range(len(ch["s"]) - 1):
                    a, b = max(s1, ch["s"][i]), min(s2, ch["s"][i + 1])
                    if b > a and ways[way_at[i]]["tags"].get("toll") == "yes":
                        osm_toll += b - a
                toll = bool(cs)
                if (osm_toll / (s2 - s1) > 0.5) != toll:
                    mismatch += s2 - s1
                    if s2 - s1 > 500:
                        report.append(f"  ~ {ref} km {k1 if k1 is None else round(k1,1)}–{k2 if k2 is None else round(k2,1)}"
                                      f" ({(s2-s1)/1000:.1f} km): decree toll={toll}, OSM toll share={osm_toll/(s2-s1):.0%}")
                if toll:
                    toll_len += s2 - s1
                geom = simplify(cut(ch, s1, s2), 4)
                pieces.append({
                    "r": ref,
                    "c": cs,
                    "k": [None if k1 is None else round(min(k1, k2), 1), None if k2 is None else round(max(k1, k2), 1)],
                    "o": 1 if ch["oneway"] else 0,
                    "p": encode_polyline(geom),
                })
        for nid, (lat, lon, tags) in nodes.items():
            if tags.get("highway") == "toll_gantry":
                best = None
                for ch in chains:
                    if nid in ch["nodes"]:
                        idx = ch["nodes"].index(nid)
                        best = km_at(ch, ch["s"][idx])
                        break
                note = tags.get("note", "")
                m = re.match(r"(\d+)\+(\d+)", note)
                km = int(m.group(1)) + int(m.group(2)) / 1000 if m else best
                gates[nid] = {"id": nid, "lat": round(lat, 6), "lon": round(lon, 6), "r": ref,
                              "ref": tags.get("ref", ""), "km": None if km is None else round(km, 1)}
        report.append(f"{ref}: {len(chains)} chains, decree-toll {toll_len/1000:.1f} km (carriageway), "
                      f"toll mismatch vs OSM {mismatch/1000:.1f} km, cal points {[len(c['cal']) for c in chains]}")

    # every county range must have produced geometry
    for road, rr in ranges.items():
        for r in rr:
            got = sum(1 for p in pieces if p["r"] == road and r["c"] in p["c"])
            if not got:
                report.append(f"  !! no geometry for {r['c']} {road} {r['a']}–{r['b']}")

    county_names = {k: v[0] for k, v in COUNTIES.items()}
    network = {
        "generated": date.today().isoformat(),
        "attribution": "© OpenStreetMap contributors (ODbL); 45/2020. (XI. 28.) ITM rendelet 1. melléklet",
        "counties": county_names,
        "ranges": {road: [{k: r[k] for k in ("c", "from", "to", "k1", "k2")} for r in rr] for road, rr in ranges.items()},
        "pieces": pieces,
        "gates": sorted(gates.values(), key=lambda g: (g["r"], g["km"] or 0)),
    }
    with open(os.path.join(DATA, "network.json"), "w", encoding="utf-8") as f:
        json.dump(network, f, ensure_ascii=False, separators=(",", ":"))

    # counties
    raw = json.load(open(os.path.join(CACHE, "counties.json"), encoding="utf-8"))
    by_rel = {v[1]: k for k, v in COUNTIES.items()}
    feats = []
    for item in raw:
        cid = by_rel.get(int(item["osm_id"]))
        if not cid:
            continue
        geom = item["geojson"]

        def rnd(c):
            return [rnd(x) for x in c] if isinstance(c[0], list) else [round(c[0], 4), round(c[1], 4)]
        geom = {"type": geom["type"], "coordinates": rnd(geom["coordinates"])}
        feats.append({"type": "Feature", "properties": {"id": cid, "name": county_names[cid],
                      "vignette": "pest" if cid == "budapest" else cid}, "geometry": geom})
    missing = set(COUNTIES) - {f["properties"]["id"] for f in feats}
    if missing:
        report.append(f"  !! missing county polygons: {sorted(missing)}")
    with open(os.path.join(DATA, "counties.geojson"), "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f, ensure_ascii=False, separators=(",", ":"))

    print("\n".join(report))
    print(f"pieces: {len(pieces)}, gates: {len(gates)}, counties: {len(feats)}")
    print(f"network.json {os.path.getsize(os.path.join(DATA, 'network.json'))//1024} KiB, "
          f"counties.geojson {os.path.getsize(os.path.join(DATA, 'counties.geojson'))//1024} KiB")
    if any("!!" in line for line in report):
        sys.exit(1)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("fetch", "all"):
        fetch()
    if cmd in ("build", "all"):
        build()
