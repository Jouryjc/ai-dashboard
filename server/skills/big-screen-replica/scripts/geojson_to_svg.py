#!/usr/bin/env python3
"""Project a GeoJSON (Polygon/MultiPolygon, WGS84) into compact SVG path JSON.

Usage:
  python geojson_to_svg.py input.geojson out.json --width 640 --height 520 [--decimate 2]

Output JSON: { "<name>": {"d": "<svg path>", "cx": x, "cy": y}, ... }
  - name  : feature properties.name (override with --name-field)
  - d     : path in a <width>x<height> viewBox, y-flipped for screen coords
  - cx/cy : projected label anchor (properties.center if present, else ring centroid)
"""
import argparse, json, sys


def walk_coords(coords, acc):
    if isinstance(coords[0], (int, float)):
        acc.append(coords)
    else:
        for c in coords:
            walk_coords(c, acc)


def polygons(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    raise ValueError("unsupported geometry: %s" % geom["type"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--width", type=float, default=640)
    ap.add_argument("--height", type=float, default=520)
    ap.add_argument("--decimate", type=int, default=2, help="keep every n-th ring point")
    ap.add_argument("--name-field", default="name")
    ap.add_argument("--pad", type=float, default=0.96, help="fraction of box to fill")
    a = ap.parse_args()

    data = json.load(open(a.src, encoding="utf-8"))
    feats = data["features"]
    pts = []
    for f in feats:
        walk_coords(f["geometry"]["coordinates"], pts)
    minx = min(p[0] for p in pts); maxx = max(p[0] for p in pts)
    miny = min(p[1] for p in pts); maxy = max(p[1] for p in pts)

    s = min(a.width / (maxx - minx), a.height / (maxy - miny)) * a.pad
    ox = (a.width - (maxx - minx) * s) / 2
    oy = (a.height - (maxy - miny) * s) / 2

    def proj(p):
        return (ox + (p[0] - minx) * s, oy + (maxy - p[1]) * s)

    out = {}
    for f in feats:
        name = f["properties"].get(a.name_field) or f["properties"].get("NAME") or "unknown"
        ds = []
        all_proj = []
        for poly in polygons(f["geometry"]):
            for ring in poly:
                rp = [proj(p) for p in ring[:: max(1, a.decimate)]]
                all_proj.extend(rp)
                ds.append("M" + "L".join("%.1f,%.1f" % (x, y) for x, y in rp) + "Z")
        c = f["properties"].get("center")
        if c:
            cx, cy = proj(c)
        else:
            cx = sum(p[0] for p in all_proj) / len(all_proj)
            cy = sum(p[1] for p in all_proj) / len(all_proj)
        out[name] = {"d": "".join(ds), "cx": round(cx, 1), "cy": round(cy, 1)}

    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)
    print("wrote %s (%d features)" % (a.out, len(out)), file=sys.stderr)


if __name__ == "__main__":
    main()
