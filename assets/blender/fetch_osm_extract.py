#!/usr/bin/env python3
"""Fetch or rebuild the pinned OpenStreetMap extract used by build_troy_scene.py.

Map data (c) OpenStreetMap contributors, available under the Open Database
License (ODbL) 1.0: https://www.openstreetmap.org/copyright

The Blender recipe never touches the network: it reads the committed
troy_osm_extract.json. This script documents exactly how that file was made.

    # live fetch (two OSM API 0.6 requests)
    python3 assets/blender/fetch_osm_extract.py --retrieved 2026-11-07

    # rebuild from previously downloaded API responses
    python3 assets/blender/fetch_osm_extract.py --way-json way.json --map-json map.json --retrieved 2026-11-07

Standard library only. Output keys are written in a fixed order so the file is
byte-for-byte reproducible from the same API responses.
"""

import argparse
import json
import os
import urllib.request

WAY_URL = "https://api.openstreetmap.org/api/0.6/way/73141173/full.json"
BBOX = "-73.6800,42.7319,-73.6762,42.7339"  # min lon, min lat, max lon, max lat
MAP_URL = "https://api.openstreetmap.org/api/0.6/map.json?bbox=" + BBOX
USER_AGENT = "FlyFireFighter-scene-recipe/1 (local research; low volume)"

FOOTPRINT_WAY = 73141173
ENTRANCE_NODE = 12743734842

# OSM ways copied into the extract and the role each plays in the recipe.
WAYS = [
    (5626991, "peoples_avenue_centerline"),
    (5637663, "13th_street_centerline"),
    (5638062, "14th_street_centerline"),
    (946232027, "sidewalk_peoples_south_and_13th_east"),
    (947753441, "sidewalk_14th_west"),
    (1318242879, "sidewalk_peoples_north"),
    (1318154554, "sidewalk_14th_east"),
    (1376363931, "footway_main_entrance"),
    (1362771419, "crossing_13th_street"),
    (1318240544, "crossing_14th_street"),
    (104737328, "parking_j_lot"),
]
NODES = [
    (ENTRANCE_NODE, "main_entrance"),
    (12541056051, "fire_hydrant"),
]
KEEP_TAGS = (
    "name", "building", "building:levels", "addr:housenumber", "addr:street",
    "highway", "footway", "crossing", "crossing:markings", "lanes", "sidewalk",
    "surface", "amenity", "entrance", "emergency", "oneway", "maxspeed",
)


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def tags_of(element):
    tags = element.get("tags", {})
    return {key: tags[key] for key in KEEP_TAGS if key in tags}


def build_extract(way_doc, map_doc, retrieved):
    elements = way_doc["elements"] + map_doc["elements"]
    nodes = {e["id"]: e for e in elements if e["type"] == "node"}
    ways = {e["id"]: e for e in elements if e["type"] == "way"}

    def node_list(way):
        return [[n, nodes[n]["lat"], nodes[n]["lon"]] for n in way["nodes"]]

    footprint = ways[FOOTPRINT_WAY]
    return {
        "description": (
            "OpenStreetMap extract for the FlyFireFighter Troy training scene: the "
            "Heffner Alumni House footprint (exterior reference only) and nearby "
            "street, sidewalk and crossing centrelines."
        ),
        "attribution": "© OpenStreetMap contributors",
        "license": "Open Database License (ODbL) 1.0",
        "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
        "copyrightUrl": "https://www.openstreetmap.org/copyright",
        "retrieved": retrieved,
        "requests": [WAY_URL, MAP_URL],
        "footprint": {
            "wayId": FOOTPRINT_WAY,
            "version": footprint["version"],
            "timestamp": footprint["timestamp"],
            "tags": tags_of(footprint),
            "nodes": node_list(footprint),
        },
        "ways": [
            {
                "id": way_id,
                "role": role,
                "version": ways[way_id]["version"],
                "timestamp": ways[way_id]["timestamp"],
                "tags": tags_of(ways[way_id]),
                "nodes": node_list(ways[way_id]),
            }
            for way_id, role in WAYS
        ],
        "nodes": [
            {
                "id": node_id,
                "role": role,
                "version": nodes[node_id]["version"],
                "timestamp": nodes[node_id]["timestamp"],
                "lat": nodes[node_id]["lat"],
                "lon": nodes[node_id]["lon"],
                "tags": tags_of(nodes[node_id]),
            }
            for node_id, role in NODES
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--way-json", help="saved response of " + WAY_URL)
    parser.add_argument("--map-json", help="saved response of " + MAP_URL)
    parser.add_argument("--retrieved", required=True, help="retrieval date, YYYY-MM-DD")
    parser.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "troy_osm_extract.json"),
    )
    args = parser.parse_args()
    with_files = bool(args.way_json and args.map_json)
    way_doc = json.load(open(args.way_json)) if with_files else fetch(WAY_URL)
    map_doc = json.load(open(args.map_json)) if with_files else fetch(MAP_URL)
    extract = build_extract(way_doc, map_doc, args.retrieved)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(extract, handle, indent=1, ensure_ascii=False)
        handle.write("\n")
    print("wrote", args.out)


if __name__ == "__main__":
    main()
