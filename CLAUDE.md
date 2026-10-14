# diversity-classifier: project guide for Claude

MCP stdio server that an AI agent launches to watch log streams cheaply.
SPEC.md is the source of truth for behaviour, and README.md is user-facing.
Repo: github.com/nemanjan00/diversity-classifier (public, MIT).

## Always use the implement-js skill

When writing JavaScript here, follow `/implement-js`. This project has two
approved deviations:

- **No forever / Procfile / herokuish / daemon mode.** This is a dev tool
  started by the agent. The entrypoint is `node bin/mcp.js`. `mcp-watch` uses
  `nodemon -q`, because anything on stdout breaks the MCP protocol.
- **Browser code** in `src/web/public/` is ES modules (qrp-shadcdn, no build).
  Server code is CommonJS.

## Rules that are not obvious from the code

- **stdout belongs to MCP.** Log only to stderr (`log()` in bin/mcp.js and the engine).
- **Unclassified invariant.** The queue (`src/clusterer`) only holds records no
  current classifier matches. Every definition change must go through
  `reclassifyQueue()` in `src/engine`. Removing a classifier sends its raw
  events back through classification.
- **Retro-absorbed records never fire alarms.** Only `ingest()` (live) calls
  `alarms.onEvent`/`onUnclassified`.
- **One tool table** (`src/mcp/tools.js`) serves both MCP and REST
  (`POST /api/<tool>`). Add tools there, not in the web server. `mutates: true`
  is what `--read-only` blocks.
- **Persisted command sources load paused** (security: a cloned state file
  must not run commands). `--resume-sources` opts in.
- **Templates compile to one regex.** Captures use generated group names
  (`g0`, `g1`…) and are mapped back to fields. Template parsers are inlined, and
  `{...p}` spreads without a prefix. `literal` (the longest required literal) is
  the `includes()` prefilter. Never take it from optional parts.
- Every event has `t` (event time: `time_field` if set, else ingest) and
  `ingest_t`. Queries filter on `t`.
- **Web UI** (`src/web/public/`): `main.js` → `lib/` (api, view = URL-synced hash state, live = SSE, charts = inline SVG, shell, editor, viz) and one module per page in `pages/`. Import everything from the single qrp-shadcdn bundle (one qrp core). No external URLs, so it works offline.
- Module layout: one folder per module with `index.js`, and tests in
  `__tests__/` beside it.

## Commands

```sh
yarn test                      # jest (all modules, includes MCP-in-memory + web + real processes)
yarn lint                      # eslint src/ bin/
node bin/mcp.js --http 7070 --state /tmp/x.json --no-global --cmd "gen=./gen.sh"
```

Commit on master and push on every commit (user preference).
