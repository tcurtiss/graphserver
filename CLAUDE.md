# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
# Start Neo4j (required before Flask)
docker run --name graphserver-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/your_password_here --detach neo4j:5

# Python environment
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Copy and configure credentials
cp .env.example .env  # set NEO4J_PASSWORD to match NEO4J_AUTH above

# Start Flask (http://localhost:5000)
python run.py
```

Seed sample data via the UI button or: `curl -X POST http://localhost:5000/api/seed`

## Architecture

Flask serves both the REST API and static frontend from a single process. There is no build step — all JS is loaded from pinned CDN URLs.

**Request flow:**
1. Browser loads `GET /` → `frontend_bp` serves `app/static/index.html`
2. JS fetches `GET /api/graph` → `api_bp` queries Neo4j, returns graphology-compatible JSON
3. Frontend renders the graph with Sigma.js (built on graphology)

**Backend (`app/`):**
- `__init__.py` — app factory; `load_dotenv()` must run before any other imports
- `config.py` — reads `.env` vars into a `Config` class
- `db.py` — Neo4j driver singleton (`_driver`); never create per-request. `run_query(cypher, params)` is the only query interface used throughout
- `routes/api.py` — three endpoints: `GET /api/graph`, `POST /api/seed`, `GET /api/node/<path:node_id>`
- `routes/frontend.py` — serves `index.html` at `/`

**Frontend (`app/static/`):**
- `index.html` — loads graphology before sigma (order matters); all scripts are synchronous (no `defer`)
- `js/app.js` — module-level `renderer` and `graph` globals; `renderer.kill()` must be called before re-rendering to avoid canvas leaks; `assignPositions()` runs random layout then ForceAtlas2 synchronously before Sigma renders

## Key constraints

**Neo4j 5 element IDs contain colons** (e.g. `4:abc123:0`). Two places handle this:
- Flask route uses `<path:node_id>` (not `<node_id>`)
- JS uses `encodeURIComponent(node)` when building the fetch URL

**Node colors** are determined by label in `_LABEL_COLORS` in `api.py`. Add new label→color mappings there when adding new node types.

**Graphology import format** expected by the frontend:
```json
{
  "nodes": [{"key": "<elementId>", "attributes": {"label": "...", "color": "..."}}],
  "edges": [{"key": "<elementId>", "source": "<elementId>", "target": "<elementId>", "attributes": {}}]
}
```
