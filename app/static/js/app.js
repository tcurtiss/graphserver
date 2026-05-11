import Graph from "graphology";
import Sigma from "sigma";

const API = "/api";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let renderer       = null;
let fullGraph      = null; // complete graph, always fully laid out
let showDirectories = true;
let showObjects     = true;
let showSymbols     = true;
let showObjEdges    = true; // REFERENCES edges (obj → function, cross-obj deps)
let _resizeHandler = null;

// Pre-computed containment maps derived from fullGraph
let _objByName   = {}; // obj file name → node id
let _objToDir    = {}; // obj node id   → dir node id
let _dirObjs     = {}; // dir node id   → [obj node ids]
let _objSymCount = {}; // obj node id   → symbol count
let _objSymbols  = {}; // obj node id   → [sym node ids]
let _unrefSymbols = new Set(); // sym node IDs with no incoming REFERENCES edge

let hiddenNodes = new Set(); // individually hidden node IDs (tree toggles)
let hideUnrefSymbols = false;

// Symbol-click highlight state
let _highlightRefNodes = new Set(); // obj node IDs in active highlight
let _tempNodeIds       = [];        // node IDs injected into view graph temporarily
let _tempEdgeIds       = [];        // edge IDs injected into view graph temporarily
let _highlightedSym    = null;      // currently highlighted symbol node ID
let _activeNodeReducer = null;      // persists across hover so leaveNode can restore
let _activeEdgeReducer = null;

const EDGE_COLORS = {
  CONTAINS:   "#59a14f",  // green  — containment hierarchy
  DEFINES:    "#76b7b2",  // teal   — object → symbol definition
  REFERENCES: "#f28e2b",  // orange — cross-object reference
};

// Per-directory hull colors — fill/stroke pairs (dir hull, obj hull)
const _DIR_PALETTE = {
  app:    [" 78,121,167"],
  auth:   ["225, 87, 89"],
  crypto: ["237,201, 72"],
  db:     [" 89,161, 79"],
  http:   ["242,142, 43"],
  infra:  ["176,122,161"],
  net:    ["118,183,178"],
  parser: ["255,157,167"],
  thread: ["156,117, 95"],
  util:   ["186,176,172"],
};

const HULL_COLORS     = Object.fromEntries(
  Object.entries(_DIR_PALETTE).map(([k, [rgb]]) => [k, {
    fill:   `rgba(${rgb},0.10)`,
    stroke: `rgba(${rgb},0.55)`,
  }])
);
const OBJ_HULL_COLORS = Object.fromEntries(
  Object.entries(_DIR_PALETTE).map(([k, [rgb]]) => [k, {
    fill:   `rgba(${rgb},0.07)`,
    stroke: `rgba(${rgb},0.30)`,
  }])
);

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadGraph() {
  setStatus("Loading graph…");
  try {
    const res = await fetch(`${API}/graph`);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();

    fullGraph = new Graph({ multi: true });
    fullGraph.import(data);
    buildMappings(fullGraph);
    assignPositions(fullGraph);
    hiddenNodes.clear();
    buildTreePanel();

    applyView();
    setStatus(`Loaded ${fullGraph.order} nodes, ${fullGraph.size} edges.`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    console.error(err);
  }
}

// Rebuild the view graph and re-render whenever toggle state changes
function applyView() {
  if (!fullGraph) return;

  const viewGraph = buildViewGraph();

  // Reset highlight state — the old renderer/graph is being replaced
  _highlightRefNodes = new Set();
  _tempNodeIds = [];
  _tempEdgeIds = [];
  _highlightedSym = null;
  _activeNodeReducer = null;
  _activeEdgeReducer = null;

  if (renderer) { renderer.kill(); renderer = null; }

  const container = document.getElementById("graph-container");
  renderer = new Sigma(viewGraph, container, {
    renderEdgeLabels:        false,
    defaultNodeColor:        "#888",
    defaultEdgeColor:        "#888",
    defaultEdgeType:         "arrow",
    labelRenderedSizeThreshold: 1,
  });

  attachInteractivity(renderer, viewGraph);
  setupHulls(renderer);
}

// ---------------------------------------------------------------------------
// Graph coarsening — build visible-only graph with rerouted edges
// ---------------------------------------------------------------------------

function buildMappings(fg) {
  _objByName   = {};
  _objToDir    = {};
  _dirObjs     = {};
  _objSymCount = {};
  _objSymbols  = {};
  const nl = n => fg.getNodeAttribute(n, "nodeLabel");
  fg.nodes().filter(n => nl(n) === "ObjectFile")
    .forEach(n => { _objByName[fg.getNodeAttribute(n, "name")] = n; });
  fg.edges().forEach(edge => {
    const rel = fg.getEdgeAttribute(edge, "label");
    if (rel === "CONTAINS") {
      _objToDir[fg.target(edge)] = fg.source(edge);
      (_dirObjs[fg.source(edge)] ??= []).push(fg.target(edge));
    }
    if (rel === "DEFINES") {
      const obj = fg.source(edge), sym = fg.target(edge);
      _objSymCount[obj] = (_objSymCount[obj] ?? 0) + 1;
      (_objSymbols[obj] ??= []).push(sym);
    }
  });

  // Compute unreferenced symbols: all Function/Data nodes with no incoming REFERENCES
  _unrefSymbols = new Set(
    fg.nodes().filter(n => { const l = nl(n); return l === "Function" || l === "Data"; })
  );
  fg.edges().forEach(edge => {
    if (fg.getEdgeAttribute(edge, "label") === "REFERENCES")
      _unrefSymbols.delete(fg.target(edge));
  });
}

// Returns true if this node is hidden via a tree toggle (cascades to children)
function isHiddenByTree(nodeId) {
  if (hiddenNodes.has(nodeId)) return true;
  const nl = fullGraph.getNodeAttribute(nodeId, "nodeLabel");
  if (nl === "ObjectFile") {
    const dir = _objToDir[nodeId];
    return dir != null && hiddenNodes.has(dir);
  }
  if (nl === "Function" || nl === "Data") {
    const obj = _objByName[fullGraph.getNodeAttribute(nodeId, "defined_in")];
    if (!obj) return false;
    return hiddenNodes.has(obj) || hiddenNodes.has(_objToDir[obj]);
  }
  return false;
}

// Returns the nearest visible ancestor of a node given current toggle state
function visibleAncestor(nodeId) {
  if (isHiddenByTree(nodeId)) return null; // tree-hidden: drop, no rerouting
  const nl = fullGraph.getNodeAttribute(nodeId, "nodeLabel");
  if (nl === "Directory") {
    return showDirectories ? nodeId : null;
  }
  if (nl === "ObjectFile") {
    if (showObjects) return nodeId;
    const dir = _objToDir[nodeId];
    return dir ? visibleAncestor(dir) : null;
  }
  if (nl === "Function" || nl === "Data") {
    if (hideUnrefSymbols && _unrefSymbols.has(nodeId)) return null;
    if (showSymbols) return nodeId;
    const obj = _objByName[fullGraph.getNodeAttribute(nodeId, "defined_in")];
    return obj ? visibleAncestor(obj) : null;
  }
  return nodeId;
}

function buildViewGraph() {
  const view = new Graph({ multi: true });

  // Add visible nodes with their positions from fullGraph
  fullGraph.nodes().forEach(n => {
    if (visibleAncestor(n) === n)
      view.addNode(n, { ...fullGraph.getNodeAttributes(n) });
  });

  // Reroute edges to nearest visible ancestors, counting collapses per pair
  const edgeData = new Map(); // key → { src, tgt, count, label }
  fullGraph.edges().forEach(edge => {
    const label = fullGraph.getEdgeAttribute(edge, "label");
    if (label !== "REFERENCES") return;
    if (!showObjEdges) return;
    const src = visibleAncestor(fullGraph.source(edge));
    const tgt = visibleAncestor(fullGraph.target(edge));
    if (!src || !tgt || src === tgt) return;
    if (!view.hasNode(src) || !view.hasNode(tgt)) return;
    const key = `${src}~~${tgt}~~${label}`;
    if (!edgeData.has(key))
      edgeData.set(key, { src, tgt, count: 0, label });
    edgeData.get(key).count++;
  });

  const maxCount = Math.max(1, ...Array.from(edgeData.values()).map(d => d.count));
  edgeData.forEach(({ src, tgt, count, label }) => {
    view.addEdge(src, tgt, {
      label,
      weight: count,
      size:  1 + (count / maxCount) * 7,
      color: EDGE_COLORS[label] ?? "#888",
    });
  });

  return view;
}

// ---------------------------------------------------------------------------
// Layout — pure hierarchical, positions set on fullGraph
// ---------------------------------------------------------------------------

function assignPositions(g) {
  const R_DIR = 400;
  const R_OBJ = 160;
  const R_SYM = 65;

  const nl = n => g.getNodeAttribute(n, "nodeLabel");

  const dirNodes = g.nodes().filter(n => nl(n) === "Directory");
  const objNodes = g.nodes().filter(n => nl(n) === "ObjectFile");
  const symNodes = g.nodes().filter(n => nl(n) === "Function" || nl(n) === "Data");

  const dirPos = {};
  dirNodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / dirNodes.length - Math.PI / 2;
    dirPos[node] = { x: R_DIR * Math.cos(angle), y: R_DIR * Math.sin(angle) };
    g.setNodeAttribute(node, "x", dirPos[node].x);
    g.setNodeAttribute(node, "y", dirPos[node].y);
  });

  const objToDir = {};
  g.edges().forEach(edge => {
    if (g.getEdgeAttribute(edge, "label") === "CONTAINS")
      objToDir[g.target(edge)] = g.source(edge);
  });

  const dirObjLists = {};
  objNodes.forEach(n => {
    const d = objToDir[n];
    if (d) (dirObjLists[d] = dirObjLists[d] || []).push(n);
  });
  Object.entries(dirObjLists).forEach(([dir, objs]) => {
    const { x: dx, y: dy } = dirPos[dir];
    const baseAngle = Math.atan2(dy, dx);
    const spread    = Math.min(Math.PI * 1.2, (objs.length - 1) * 0.35);
    const start     = baseAngle - spread / 2;
    objs.forEach((node, i) => {
      const angle = objs.length === 1 ? baseAngle : start + (spread / (objs.length - 1)) * i;
      g.setNodeAttribute(node, "x", dx + R_OBJ * Math.cos(angle));
      g.setNodeAttribute(node, "y", dy + R_OBJ * Math.sin(angle));
    });
  });

  const objByName = {};
  objNodes.forEach(n => { objByName[g.getNodeAttribute(n, "name")] = n; });

  const objSymLists = {};
  symNodes.forEach(n => {
    const obj = objByName[g.getNodeAttribute(n, "defined_in")];
    if (obj) (objSymLists[obj] = objSymLists[obj] || []).push(n);
  });
  Object.entries(objSymLists).forEach(([obj, syms]) => {
    const ox  = g.getNodeAttribute(obj, "x");
    const oy  = g.getNodeAttribute(obj, "y");
    const dir = objToDir[obj];
    const dx  = dir ? g.getNodeAttribute(dir, "x") : 0;
    const dy  = dir ? g.getNodeAttribute(dir, "y") : 0;
    const baseAngle = Math.atan2(oy - dy, ox - dx);
    const spread    = Math.min(Math.PI * 1.1, (syms.length - 1) * 0.28);
    const start     = baseAngle - spread / 2;
    syms.forEach((node, i) => {
      const angle = syms.length === 1 ? baseAngle : start + (spread / (syms.length - 1)) * i;
      g.setNodeAttribute(node, "x", ox + R_SYM * Math.cos(angle));
      g.setNodeAttribute(node, "y", oy + R_SYM * Math.sin(angle));
    });
  });
}

// ---------------------------------------------------------------------------
// Tree panel
// ---------------------------------------------------------------------------

function buildTreePanel() {
  document.getElementById("tree-search").value = "";
  const root = document.getElementById("tree-root");
  root.innerHTML = "";

  const name = n => fullGraph.getNodeAttribute(n, "name");
  const dirNodes = fullGraph.nodes()
    .filter(n => fullGraph.getNodeAttribute(n, "nodeLabel") === "Directory")
    .sort((a, b) => name(a).localeCompare(name(b)));

  dirNodes.forEach(dirNode => {
    const objs = (_dirObjs[dirNode] ?? [])
      .slice()
      .sort((a, b) => name(a).localeCompare(name(b)));
    root.appendChild(makeDirItem(dirNode, objs, name));
  });
}

function buildFilteredTree(query) {
  const root = document.getElementById("tree-root");
  root.innerHTML = "";
  const q = query.toLowerCase();
  const nameOf = n => fullGraph.getNodeAttribute(n, "name");
  let found = 0;

  fullGraph.nodes()
    .filter(n => fullGraph.getNodeAttribute(n, "nodeLabel") === "Directory")
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
    .forEach(dirNode => {
      const dirName = nameOf(dirNode);
      const dirMatch = dirName.toLowerCase().includes(q);
      const allObjs = (_dirObjs[dirNode] ?? []).slice()
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

      // Each obj entry: the obj itself + which syms to show
      const objEntries = allObjs.flatMap(objNode => {
        const objMatch = dirMatch || nameOf(objNode).toLowerCase().includes(q);
        const syms = (objMatch
          ? (_objSymbols[objNode] ?? [])
          : (_objSymbols[objNode] ?? []).filter(s => nameOf(s).toLowerCase().includes(q))
        ).slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
        return (objMatch || syms.length) ? [{ objNode, syms }] : [];
      });

      if (!dirMatch && !objEntries.length) return;
      found++;

      const dirWrap = document.createElement("div");

      // Dir row
      const dirRow = document.createElement("div");
      dirRow.className = "tree-row";
      const dirArrow = document.createElement("span");
      dirArrow.className = "tree-arrow";
      dirArrow.textContent = "▼";
      const dirCb = document.createElement("input");
      dirCb.type = "checkbox";
      dirCb.checked = !hiddenNodes.has(dirNode);
      const dirLbl = document.createElement("span");
      dirLbl.className = "tree-label";
      dirLbl.textContent = dirName;
      const dirCnt = document.createElement("span");
      dirCnt.className = "tree-count";
      dirCnt.textContent = objEntries.length;
      dirRow.append(dirArrow, dirCb, dirLbl, dirCnt);
      dirWrap.appendChild(dirRow);

      // Obj children (always expanded in filtered view)
      const dirChildren = document.createElement("div");
      dirChildren.className = "tree-children";

      objEntries.forEach(({ objNode, syms }) => {
        const objWrap = document.createElement("div");
        const objRow = document.createElement("div");
        objRow.className = "tree-row";
        const objArrow = document.createElement("span");
        objArrow.className = "tree-arrow";
        objArrow.textContent = syms.length ? "▼" : "";
        const objCb = document.createElement("input");
        objCb.type = "checkbox";
        objCb.checked = !hiddenNodes.has(objNode);
        const objLbl = document.createElement("span");
        objLbl.className = "tree-label";
        objLbl.textContent = nameOf(objNode);
        const objCnt = document.createElement("span");
        objCnt.className = "tree-count";
        objCnt.textContent = syms.length || (_objSymCount[objNode] ?? 0);
        objRow.append(objArrow, objCb, objLbl, objCnt);
        objWrap.appendChild(objRow);

        if (syms.length) {
          const symChildren = document.createElement("div");
          symChildren.className = "tree-children";
          syms.forEach(s => symChildren.appendChild(makeSymItem(s)));
          objWrap.appendChild(symChildren);
        }

        objCb.addEventListener("change", () => {
          if (objCb.checked) {
            hiddenNodes.delete(objNode);
            (_objSymbols[objNode] ?? []).forEach(s => hiddenNodes.delete(s));
          } else {
            hiddenNodes.add(objNode);
          }
          objWrap.querySelectorAll("input[type=checkbox]").forEach(c => { c.checked = objCb.checked; });
          applyView();
        });

        dirChildren.appendChild(objWrap);
      });

      dirCb.addEventListener("change", () => {
        if (dirCb.checked) {
          hiddenNodes.delete(dirNode);
          allObjs.forEach(o => {
            hiddenNodes.delete(o);
            (_objSymbols[o] ?? []).forEach(s => hiddenNodes.delete(s));
          });
        } else {
          hiddenNodes.add(dirNode);
        }
        dirChildren.querySelectorAll("input[type=checkbox]").forEach(c => { c.checked = dirCb.checked; });
        applyView();
      });

      dirWrap.appendChild(dirChildren);
      root.appendChild(dirWrap);
    });

  if (!found) {
    const p = document.createElement("p");
    p.style.cssText = "font-size:0.8rem;color:#555;padding:6px 0;text-align:center";
    p.textContent = "No matches";
    root.appendChild(p);
  }
}

function makeDirItem(dirNode, objs, name) {
  const wrap = document.createElement("div");

  const row = document.createElement("div");
  row.className = "tree-row";

  const arrow = document.createElement("span");
  arrow.className = "tree-arrow";
  arrow.textContent = "▶";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = true;

  const lbl = document.createElement("span");
  lbl.className = "tree-label";
  lbl.textContent = name(dirNode);

  const cnt = document.createElement("span");
  cnt.className = "tree-count";
  cnt.textContent = objs.length;

  row.append(arrow, cb, lbl, cnt);
  wrap.appendChild(row);

  const children = document.createElement("div");
  children.className = "tree-children";
  children.hidden = true;
  objs.forEach(objNode => children.appendChild(makeObjItem(objNode, name)));

  arrow.addEventListener("click", () => {
    children.hidden = !children.hidden;
    arrow.textContent = children.hidden ? "▶" : "▼";
  });

  cb.addEventListener("change", () => {
    if (cb.checked) {
      hiddenNodes.delete(dirNode);
      objs.forEach(o => {
        hiddenNodes.delete(o);
        (_objSymbols[o] ?? []).forEach(s => hiddenNodes.delete(s));
      });
    } else {
      hiddenNodes.add(dirNode);
    }
    children.querySelectorAll("input[type=checkbox]").forEach(c => { c.checked = cb.checked; });
    applyView();
  });

  wrap.appendChild(children);
  return wrap;
}

function makeObjItem(objNode, name) {
  const wrap = document.createElement("div");
  const symCount = _objSymCount[objNode] ?? 0;

  const row = document.createElement("div");
  row.className = "tree-row";

  const arrow = document.createElement("span");
  arrow.className = "tree-arrow";
  arrow.textContent = symCount > 0 ? "▶" : "";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = true;

  const lbl = document.createElement("span");
  lbl.className = "tree-label";
  lbl.textContent = name(objNode);

  const cnt = document.createElement("span");
  cnt.className = "tree-count";
  cnt.textContent = symCount;

  row.append(arrow, cb, lbl, cnt);
  wrap.appendChild(row);

  if (symCount > 0) {
    const symChildren = document.createElement("div");
    symChildren.className = "tree-children";
    symChildren.hidden = true;
    let rendered = false;

    arrow.addEventListener("click", () => {
      if (!rendered) {
        (_objSymbols[objNode] ?? [])
          .slice()
          .sort((a, b) =>
            fullGraph.getNodeAttribute(a, "name")
              .localeCompare(fullGraph.getNodeAttribute(b, "name"))
          )
          .forEach(symNode => symChildren.appendChild(makeSymItem(symNode)));
        rendered = true;
      }
      symChildren.hidden = !symChildren.hidden;
      arrow.textContent = symChildren.hidden ? "▶" : "▼";
    });

    wrap.appendChild(symChildren);
  }

  cb.addEventListener("change", () => {
    if (cb.checked) {
      hiddenNodes.delete(objNode);
      (_objSymbols[objNode] ?? []).forEach(s => hiddenNodes.delete(s));
    } else {
      hiddenNodes.add(objNode);
    }
    wrap.querySelectorAll("input[type=checkbox]").forEach(c => { c.checked = cb.checked; });
    applyView();
  });

  return wrap;
}

function makeSymItem(symNode) {
  const row = document.createElement("div");
  row.className = "tree-row";

  const spacer = document.createElement("span");
  spacer.className = "tree-arrow";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !hiddenNodes.has(symNode);
  cb.addEventListener("change", () => {
    hiddenNodes[cb.checked ? "delete" : "add"](symNode);
    applyView();
  });

  const lbl = document.createElement("span");
  lbl.className = "tree-label";
  lbl.textContent = fullGraph.getNodeAttribute(symNode, "name");

  const cnt = document.createElement("span");
  cnt.className = "tree-count";
  cnt.textContent = formatBytes(fullGraph.getNodeAttribute(symNode, "symbolSize"));

  row.append(spacer, cb, lbl, cnt);
  return row;
}

function formatBytes(b) {
  if (b == null) return "";
  if (b < 1024) return `${b}B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)}K`;
  return `${(b / 1_048_576).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// Hull rendering
// ---------------------------------------------------------------------------

function setupHulls(r) {
  const hullCanvas = document.getElementById("hull-layer");
  const container  = document.getElementById("graph-container");
  const groups     = buildGroups();

  function sizeCanvas() {
    hullCanvas.width  = container.offsetWidth;
    hullCanvas.height = container.offsetHeight;
  }
  function redrawHulls() {
    sizeCanvas();
    drawHulls(hullCanvas, r, groups);
  }

  if (_resizeHandler) window.removeEventListener("resize", _resizeHandler);
  _resizeHandler = redrawHulls;
  window.addEventListener("resize", _resizeHandler);

  sizeCanvas();
  redrawHulls();
  r.getCamera().on("updated", redrawHulls);
}

// Build hull groups from fullGraph positions, filtered by current visibility
function buildGroups() {
  const nl = n => fullGraph.getNodeAttribute(n, "nodeLabel");

  // Directory-level: dir node + visible children (skip entirely when dirs are hidden)
  const dirGroups = {};
  if (showDirectories) {
    fullGraph.nodes().filter(n => nl(n) === "Directory").forEach(d => { dirGroups[d] = [d]; });
    if (showObjects) {
      fullGraph.nodes().filter(n => nl(n) === "ObjectFile").forEach(n => {
        const d = _objToDir[n];
        if (d) (dirGroups[d] = dirGroups[d] || []).push(n);
      });
    }
    if (showSymbols) {
      fullGraph.nodes().filter(n => nl(n) === "Function" || nl(n) === "Data").forEach(n => {
        const obj = _objByName[fullGraph.getNodeAttribute(n, "defined_in")];
        const d   = obj && _objToDir[obj];
        if (d) (dirGroups[d] = dirGroups[d] || []).push(n);
      });
    }
  }

  // Object-file-level: only draw when both obj files and symbols are visible
  // and the number of object files is small enough to render interactively
  const OBJ_HULL_LIMIT = 80;
  const objGroups = {};
  const visibleObjCount = fullGraph.nodes().filter(n => nl(n) === "ObjectFile").length;
  if (showObjects && showSymbols && visibleObjCount <= OBJ_HULL_LIMIT) {
    fullGraph.nodes().filter(n => nl(n) === "ObjectFile").forEach(obj => {
      objGroups[obj] = [obj];
    });
    fullGraph.nodes().filter(n => nl(n) === "Function" || nl(n) === "Data").forEach(n => {
      const obj = _objByName[fullGraph.getNodeAttribute(n, "defined_in")];
      if (obj) (objGroups[obj] = objGroups[obj] || []).push(n);
    });
  }

  return { dirGroups, objGroups };
}

function convexHull(points) {
  if (points.length <= 2) return points;
  const pts   = [...points].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower, ...upper];
}

function padHull(hull, pad) {
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  return hull.map(({ x, y }) => {
    const dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: x + (dx / len) * pad, y: y + (dy / len) * pad };
  });
}

function drawRoundedHull(ctx, pts) {
  const n = pts.length;
  if (n === 0) return;
  if (n === 1) { ctx.arc(pts[0].x, pts[0].y, 30, 0, Math.PI * 2); return; }
  if (n === 2) {
    const [a, b] = pts;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * 20, ny = dx / len * 20;
    ctx.moveTo(a.x + nx, a.y + ny);
    ctx.lineTo(b.x + nx, b.y + ny);
    ctx.arc(b.x, b.y, 20, Math.atan2(dy, dx) - Math.PI / 2, Math.atan2(dy, dx) + Math.PI / 2);
    ctx.lineTo(a.x - nx, a.y - ny);
    ctx.arc(a.x, a.y, 20, Math.atan2(-dy, -dx) - Math.PI / 2, Math.atan2(-dy, -dx) + Math.PI / 2);
    ctx.closePath();
    return;
  }
  ctx.moveTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
  for (let i = 0; i < n; i++) {
    const p1 = pts[(i + 1) % n];
    const p2 = pts[(i + 2) % n];
    ctx.quadraticCurveTo(p1.x, p1.y, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
  }
  ctx.closePath();
}

function drawHulls(canvas, r, { dirGroups, objGroups }) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const toViewport = nodes => nodes.map(n => r.graphToViewport({
    x: fullGraph.getNodeAttribute(n, "x"),
    y: fullGraph.getNodeAttribute(n, "y"),
  }));

  // Directory hulls (bottom layer, dashed)
  Object.entries(dirGroups).forEach(([dir, nodes]) => {
    const name   = fullGraph.getNodeAttribute(dir, "name");
    const colors = HULL_COLORS[name] || { fill: "rgba(128,128,128,0.10)", stroke: "rgba(128,128,128,0.50)" };
    const padded = padHull(convexHull(toViewport(nodes)), 32);
    ctx.beginPath();
    drawRoundedHull(ctx, padded);
    ctx.fillStyle = colors.fill;
    ctx.fill();
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth   = 2;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // Object-file hulls (top layer, solid)
  Object.entries(objGroups).forEach(([obj, nodes]) => {
    if (nodes.length < 2) return;
    const dir    = _objToDir[obj];
    const name   = dir ? fullGraph.getNodeAttribute(dir, "name") : null;
    const colors = OBJ_HULL_COLORS[name] || { fill: "rgba(200,200,200,0.07)", stroke: "rgba(200,200,200,0.30)" };
    const padded = padHull(convexHull(toViewport(nodes)), 16);
    ctx.beginPath();
    drawRoundedHull(ctx, padded);
    ctx.fillStyle   = colors.fill;
    ctx.fill();
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  });
}

// ---------------------------------------------------------------------------
// Interactivity
// ---------------------------------------------------------------------------

function attachInteractivity(r, g) {
  r.on("enterNode", ({ node }) => {
    r.setSetting("nodeReducer", (n, attrs) =>
      n === node
        ? { ...attrs, highlighted: true, size: (attrs.size || 5) * 1.4 }
        : { ...attrs, color: "#333" }
    );
    r.setSetting("edgeReducer", (edge, attrs) =>
      g.hasExtremity(edge, node)
        ? { ...attrs, color: "#fff" }
        : { ...attrs, color: "#222" }
    );
  });

  r.on("leaveNode", () => {
    // Restore click-highlight reducers (or null if no active highlight)
    r.setSetting("nodeReducer", _activeNodeReducer);
    r.setSetting("edgeReducer", _activeEdgeReducer);
  });

  r.on("clickNode", ({ node }) => {
    const nl = fullGraph?.getNodeAttribute(node, "nodeLabel");
    if (nl === "Function" || nl === "Data") {
      highlightSymbolRefs(node);
    } else {
      clearSymbolHighlight();
    }
    fetch(`${API}/node/${encodeURIComponent(node)}`)
      .then(res => res.json())
      .then(data => showInfoPanel(node, data))
      .catch(err => setStatus(`Error: ${err.message}`));
  });

  r.on("clickStage", () => hideInfoPanel());
}

// ---------------------------------------------------------------------------
// Info panel
// ---------------------------------------------------------------------------

function showInfoPanel(nodeId, data) {
  document.getElementById("info-title").textContent = data.properties?.name ?? nodeId;
  const dl = document.getElementById("info-body");
  dl.innerHTML = "";
  appendDlRow(dl, "Labels", data.labels.join(", "));
  for (const [k, v] of Object.entries(data.properties ?? {})) appendDlRow(dl, k, v);

  if (fullGraph && (data.labels.includes("Function") || data.labels.includes("Data"))) {
    const refs = [];
    fullGraph.edges().forEach(e => {
      if (fullGraph.getEdgeAttribute(e, "label") === "REFERENCES" &&
          fullGraph.target(e) === nodeId) {
        refs.push(fullGraph.getNodeAttribute(fullGraph.source(e), "name"));
      }
    });
    if (refs.length) {
      refs.sort();
      const MAX = 30;
      const text = refs.slice(0, MAX).join(", ") +
        (refs.length > MAX ? `, … +${refs.length - MAX} more` : "");
      appendDlRow(dl, `Referenced by (${refs.length})`, text);
    }
  }

  document.getElementById("info-panel").classList.remove("hidden");
}

function appendDlRow(dl, key, value) {
  const dt = document.createElement("dt"); dt.textContent = key;
  const dd = document.createElement("dd"); dd.textContent = value;
  dl.appendChild(dt); dl.appendChild(dd);
}

function highlightSymbolRefs(symNodeId) {
  clearSymbolHighlight();
  if (!renderer || !fullGraph) return;
  const vg = renderer.getGraph();
  if (!vg.hasNode(symNodeId)) return;

  _highlightedSym = symNodeId;

  fullGraph.edges().forEach(e => {
    if (fullGraph.getEdgeAttribute(e, "label") !== "REFERENCES") return;
    if (fullGraph.target(e) !== symNodeId) return;
    const objId = fullGraph.source(e);
    _highlightRefNodes.add(objId);
    if (!vg.hasNode(objId)) {
      vg.addNode(objId, { ...fullGraph.getNodeAttributes(objId) });
      _tempNodeIds.push(objId);
    }
    const eid = vg.addEdge(objId, symNodeId, {
      label: "REFERENCES",
      color: EDGE_COLORS.REFERENCES,
      size: 2.5,
    });
    _tempEdgeIds.push(eid);
  });

  const tempEdgeSet = new Set(_tempEdgeIds);

  _activeNodeReducer = (n, attrs) => {
    if (n === symNodeId) return { ...attrs, highlighted: true, size: (attrs.size || 5) * 1.5 };
    if (_highlightRefNodes.has(n)) return { ...attrs, highlighted: true };
    return { ...attrs, color: "#333" };
  };
  _activeEdgeReducer = (edge, attrs) =>
    tempEdgeSet.has(edge)
      ? { ...attrs, color: EDGE_COLORS.REFERENCES, size: 2.5 }
      : { ...attrs, color: "#222" };

  renderer.setSetting("nodeReducer", _activeNodeReducer);
  renderer.setSetting("edgeReducer", _activeEdgeReducer);
}

function clearSymbolHighlight() {
  if (renderer) {
    const vg = renderer.getGraph();
    _tempEdgeIds.forEach(eid => { try { vg.dropEdge(eid); } catch (_) {} });
    _tempNodeIds.forEach(nid => { try { vg.dropNode(nid); } catch (_) {} });
    renderer.setSetting("nodeReducer", null);
    renderer.setSetting("edgeReducer", null);
  }
  _highlightRefNodes = new Set();
  _tempNodeIds       = [];
  _tempEdgeIds       = [];
  _highlightedSym    = null;
  _activeNodeReducer = null;
  _activeEdgeReducer = null;
}

function hideInfoPanel() {
  clearSymbolHighlight();
  document.getElementById("info-panel").classList.add("hidden");
}

function setStatus(msg) {
  document.getElementById("status-msg").textContent = msg;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.getElementById("btn-seed").addEventListener("click", async () => {
  setStatus("Seeding…");
  try {
    const res  = await fetch(`${API}/seed`, { method: "POST" });
    const data = await res.json();
    setStatus(data.message);
    await loadGraph();
  } catch (err) {
    setStatus(`Seed error: ${err.message}`);
  }
});

document.getElementById("btn-reload").addEventListener("click", loadGraph);
document.getElementById("info-close").addEventListener("click", hideInfoPanel);

let _searchTimer = null;
document.getElementById("tree-search").addEventListener("input", e => {
  clearTimeout(_searchTimer);
  const q = e.target.value.trim();
  _searchTimer = setTimeout(() => {
    q ? buildFilteredTree(q) : buildTreePanel();
  }, 200);
});

document.getElementById("btn-select-all").addEventListener("click", () => {
  hiddenNodes.clear();
  document.querySelectorAll("#tree-root input[type=checkbox]").forEach(cb => { cb.checked = true; });
  applyView();
});

document.getElementById("btn-deselect-all").addEventListener("click", () => {
  fullGraph?.nodes().forEach(n => hiddenNodes.add(n));
  document.querySelectorAll("#tree-root input[type=checkbox]").forEach(cb => { cb.checked = false; });
  applyView();
});

document.getElementById("toggle-objects").addEventListener("change", e => {
  showObjects = e.target.checked;
  applyView();
});

document.getElementById("toggle-symbols").addEventListener("change", e => {
  showSymbols = e.target.checked;
  applyView();
});

document.getElementById("toggle-directories").addEventListener("change", e => {
  showDirectories = e.target.checked;
  applyView();
});

document.getElementById("toggle-obj-edges").addEventListener("change", e => {
  showObjEdges = e.target.checked;
  applyView();
});

document.getElementById("toggle-hide-unref").addEventListener("change", e => {
  hideUnrefSymbols = e.target.checked;
  applyView();
});

loadGraph();
