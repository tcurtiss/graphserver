import math
import random as _random
from flask import Blueprint, jsonify, current_app
from app.db import run_query

api_bp = Blueprint("api", __name__)

_LABEL_COLORS = {
    "Directory":  "#59a14f",
    "ObjectFile": "#4e79a7",
    "Function":   "#f28e2b",
    "Data":       "#76b7b2",
}

_LABEL_SIZES = {
    "Directory":  20,
    "ObjectFile": 14,
    "Function":   7,
    "Data":       5,
}


def label_color(labels):
    for label in labels:
        if label in _LABEL_COLORS:
            return _LABEL_COLORS[label]
    return "#888888"


def label_size(labels):
    for label in labels:
        if label in _LABEL_SIZES:
            return _LABEL_SIZES[label]
    return 6

def symbol_visual_size(byte_size):
    # log2 scale: 4 bytes → 4, 64 bytes → 8, 512 bytes → 11, capped at 13
    return round(max(3.0, min(13.0, 2.0 + math.log2(max(1, byte_size)))), 2)


@api_bp.route("/graph")
def get_graph():
    node_records = run_query(
        "MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props"
    )
    edge_records = run_query(
        """
        MATCH (a)-[r]->(b)
        RETURN elementId(r)  AS id,
               elementId(a)  AS source,
               elementId(b)  AS target,
               type(r)       AS rel_type,
               properties(r) AS props
        """
    )

    nodes = []
    for rec in node_records:
        props = dict(rec["props"])
        byte_size = props.pop("size", None)
        is_symbol = any(l in ("Function", "Data") for l in rec["labels"])
        if byte_size is not None:
            props["symbolSize"] = byte_size
        visual_size = (
            symbol_visual_size(byte_size) if (is_symbol and byte_size is not None)
            else label_size(rec["labels"])
        )
        nodes.append({
            "key": rec["id"],
            "attributes": {
                "label":     props.get("name", rec["id"]),
                "nodeLabel": rec["labels"][0] if rec["labels"] else "",
                "color":     label_color(rec["labels"]),
                "size":      visual_size,
                **props,
            },
        })

    edges = [
        {
            "key": rec["id"],
            "source": rec["source"],
            "target": rec["target"],
            "attributes": {
                "label": rec["rel_type"],
                **rec["props"],
            },
        }
        for rec in edge_records
    ]

    return jsonify({"nodes": nodes, "edges": edges})


@api_bp.route("/seed", methods=["POST"])
def seed():
    rng = _random.Random(42)
    BATCH = 500

    for idx_cypher in [
        "CREATE INDEX IF NOT EXISTS FOR (n:Directory)  ON (n.name)",
        "CREATE INDEX IF NOT EXISTS FOR (n:ObjectFile) ON (n.name)",
        "CREATE INDEX IF NOT EXISTS FOR (n:Function)   ON (n.name)",
        "CREATE INDEX IF NOT EXISTS FOR (n:Data)       ON (n.name)",
    ]:
        run_query(idx_cypher)

    run_query("MATCH (n) DETACH DELETE n")

    DIRS = ["app", "auth", "crypto", "db", "http", "infra", "net", "parser", "thread", "util"]

    dirs  = [{"name": d, "path": f"src/{d}"} for d in DIRS]
    objs  = []
    funcs = []
    datas = []
    global_funcs = []  # names of globally-visible functions (candidates for REFERENCES)

    for dir_name in DIRS:
        n_objs = rng.randint(10, 100)
        for oi in range(n_objs):
            obj_name = f"{dir_name}_{oi:03d}.o"
            objs.append({"name": obj_name, "path": f"src/{dir_name}/{obj_name}", "dir": dir_name})
            n_syms = rng.randint(10, 100)
            n_f    = max(1, round(n_syms * 0.7))
            n_d    = n_syms - n_f
            for fi in range(n_f):
                sym = f"{dir_name}_{oi:03d}_f{fi:03d}"
                vis = "global" if rng.random() < 0.6 else "static"
                sz  = int(2 ** rng.uniform(math.log2(4), math.log2(10_485_760)))
                funcs.append({"name": sym, "defined_in": obj_name, "visibility": vis, "size": sz})
                if vis == "global":
                    global_funcs.append(sym)
            for di in range(n_d):
                sym = f"{dir_name}_{oi:03d}_d{di:03d}"
                vis = "global" if rng.random() < 0.4 else "static"
                sz  = int(2 ** rng.uniform(math.log2(4), math.log2(10_485_760)))
                datas.append({"name": sym, "defined_in": obj_name, "visibility": vis, "size": sz})

    # --- Insert nodes ---
    run_query(
        "UNWIND $rows AS row CREATE (:Directory {name: row.name, path: row.path})",
        {"rows": dirs},
    )
    for i in range(0, len(objs), BATCH):
        batch = objs[i:i + BATCH]
        run_query(
            "UNWIND $rows AS row CREATE (:ObjectFile {name: row.name, path: row.path})",
            {"rows": [{"name": o["name"], "path": o["path"]} for o in batch]},
        )
    for i in range(0, len(funcs), BATCH):
        run_query(
            "UNWIND $rows AS row CREATE (:Function {name: row.name, defined_in: row.defined_in, visibility: row.visibility, size: row.size})",
            {"rows": funcs[i:i + BATCH]},
        )
    for i in range(0, len(datas), BATCH):
        run_query(
            "UNWIND $rows AS row CREATE (:Data {name: row.name, defined_in: row.defined_in, visibility: row.visibility, size: row.size})",
            {"rows": datas[i:i + BATCH]},
        )

    # --- CONTAINS edges (Directory → ObjectFile) ---
    contains = [{"dir": o["dir"], "obj": o["name"]} for o in objs]
    for i in range(0, len(contains), BATCH):
        run_query(
            "UNWIND $rows AS row MATCH (d:Directory {name: row.dir}), (o:ObjectFile {name: row.obj}) CREATE (d)-[:CONTAINS]->(o)",
            {"rows": contains[i:i + BATCH]},
        )

    # --- DEFINES edges (ObjectFile → symbols) ---
    df_rows = [{"obj": f["defined_in"], "sym": f["name"]} for f in funcs]
    for i in range(0, len(df_rows), BATCH):
        run_query(
            "UNWIND $rows AS row MATCH (o:ObjectFile {name: row.obj}), (s:Function {name: row.sym}) CREATE (o)-[:DEFINES]->(s)",
            {"rows": df_rows[i:i + BATCH]},
        )
    dd_rows = [{"obj": d["defined_in"], "sym": d["name"]} for d in datas]
    for i in range(0, len(dd_rows), BATCH):
        run_query(
            "UNWIND $rows AS row MATCH (o:ObjectFile {name: row.obj}), (s:Data {name: row.sym}) CREATE (o)-[:DEFINES]->(s)",
            {"rows": dd_rows[i:i + BATCH]},
        )

    # --- REFERENCES edges (ObjectFile → global Functions in other object files) ---
    refs = []
    n_candidates = len(global_funcs)
    for obj in objs:
        if n_candidates == 0:
            break
        n_refs = rng.randint(3, min(15, n_candidates))
        for sym in rng.sample(global_funcs, n_refs):
            refs.append({"obj": obj["name"], "sym": sym})
    for i in range(0, len(refs), BATCH):
        run_query(
            "UNWIND $rows AS row MATCH (o:ObjectFile {name: row.obj}), (s:Function {name: row.sym}) CREATE (o)-[:REFERENCES]->(s)",
            {"rows": refs[i:i + BATCH]},
        )

    return jsonify({
        "status": "ok",
        "message": (
            f"Seeded C project: {len(dirs)} directories, "
            f"{len(objs)} object files, "
            f"{len(funcs) + len(datas)} symbols."
        ),
    })


@api_bp.route("/node/<path:node_id>")
def get_node(node_id):
    records = run_query(
        """
        MATCH (n) WHERE elementId(n) = $id
        RETURN labels(n) AS labels, properties(n) AS props
        """,
        {"id": node_id},
    )
    if not records:
        return jsonify({"error": "Node not found"}), 404
    rec = records[0]
    return jsonify({"labels": rec["labels"], "properties": rec["props"]})


@api_bp.errorhandler(Exception)
def handle_error(e):
    current_app.logger.exception(e)
    return jsonify({"error": str(e)}), 500
