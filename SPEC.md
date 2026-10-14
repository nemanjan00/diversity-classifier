# diversity-classifier: specification

An MCP server that watches log streams on behalf of an AI agent without
streaming every line into the model's context.

## 1. Problem

LLM agents cannot consume a live stream, and pasting logs into context is
expensive. Most logs, though, are a few templates repeated millions of times.
If the agent teaches the server those templates once, the server can do the
cheap work (matching, counting, aggregating, alerting) and the agent only
needs to see:

* lines that match **no known template** (deduplicated into clusters), and
* **aggregates and alarms** over lines that do match.

Over time the unclassified share of the stream drops toward zero, and so does
the token cost of watching it.

## 2. Concepts

| Term | Meaning |
|---|---|
| **Source** | Where lines come from: a tailed file, a spawned command, a TCP/Unix socket, or lines pushed through a tool. |
| **Record** | One logical log entry: one line, or several lines joined by a multiline rule (stack traces). |
| **Type** | A named value matcher with a regex and a converter, e.g. `int`, `duration`, `ipv4`. |
| **Parser** | A user-defined type. It is built from a regex or from a **template**, so it can yield nested fields. |
| **Template** | The pattern language for classifiers (section 4). |
| **Classifier** | A named template plus options. A record that matches becomes an **event** with typed fields. |
| **Sub-classifier** | A classifier attached to a parent classifier's field. It refines events further (section 5.3). |
| **Cluster** | A group of unclassified records that share a masked shape (section 6). |
| **Event** | A classified record: `{ id, t, source, classifier, path, fields, raw? }`. |
| **Alarm** | A rule over events that sends a notification when it fires (section 8). |

## 3. Architecture

```
 sources ──► line assembler ──► classifier engine ──┬─► event store ──► metrics / search / histograms
 (file,cmd,   (split, multiline,  (prefilter, regex,  │                   ▲
  tcp, unix,   max length)         sub-classifiers)   │                   │
  tool)                                               │               alarm engine ──► notifier
                                                      └─► clusterer ──────────────────► notifier (debounced)
                                                          (unclassified)

 definitions (parsers, classifiers, alarms, sources) ◄──► state file (JSON, persisted)
 MCP stdio server ◄──► tools / resources / notifications
```

All state lives in memory. Only **definitions** are persisted. Events and
clusters are bounded ring buffers and LRU maps, so memory stays flat however
long the server runs.

The MCP transport is stdio, so the server's own stdin is **not** a log source.
Diagnostics go to stderr only.

## 4. Template language

A template is literal text interleaved with **captures** in braces.

```
{name:type}                         typed capture
{name:type(arg, ...)}               parameterised type
{name:type|filter|filter(arg)}      converter pipeline applied after the match
{name?:type}                        optional capture (field may be absent)
{name:/regex/flags}                 inline regex capture (string value)
{_:type} / {*}                      match but do not keep (anonymous / skip-anything lazy)
{{  }}                              literal braces
```

Literal-text rules:

* A run of whitespace in a literal matches `\s+`.
* All other literal characters are regex-escaped. Templates never need
  escaping except for `{{` and `}}`.
* Matching is **unanchored** by default, so a template can match the middle of a
  line. A leading `^` or trailing `$` in the template anchors it.

Example:

```
{ts:iso8601} {level:level} [{svc:word}] client {client:uuid} failed to connect to {peer:hostport} after {elapsed:duration} (attempt {n:int}/{max:int})
```

When `hostport` is a template parser, this match yields fields `ts`, `level`,
`svc`, `client`, `peer.host`, `peer.port`, `elapsed` (ms), `n`, `max`.

### 4.1 Built-in types

| Type | Matches | Value |
|---|---|---|
| `word` | `\S+` | string |
| `text` | lazy `.*?` | string |
| `rest` | greedy `.*` to end | string |
| `int` | `[-+]?\d+` | number |
| `float` / `number` | decimal or scientific | number |
| `hex` | `(0x)?[0-9a-fA-F]+` | string |
| `bool` | true/false/yes/no/on/off | boolean |
| `uuid` | canonical UUID | string (lowercase) |
| `ipv4`, `ipv6`, `ip` | addresses | string |
| `host` | hostname or IP | string |
| `port` | 1-65535 | number |
| `email`, `url`, `path` | as named | string |
| `iso8601` | ISO-8601 timestamp | epoch ms |
| `timestamp` | ISO-8601, `YYYY-MM-DD HH:MM:SS[.fff]`, syslog `Mmm dd HH:MM:SS`, epoch s/ms | epoch ms |
| `duration` | `250ms`, `1.5s`, `2m`, `1h30m`, `µs`/`us`/`ns` | ms (number) |
| `bytes` | `512`, `12KB`, `3.4MiB`, `1G` | bytes (number) |
| `level` | trace/debug/info/notice/warn(ing)/err(or)/crit(ical)/fatal/panic, any case | normalised lowercase |
| `quoted` | `"..."` or `'...'` with escapes | unquoted string |
| `json` | balanced `{...}` or `[...]` | parsed object, flattened to `name.key` |
| `kv` | `k=v k2="v 2"` pairs | object, flattened to `name.k` |
| `enum(a,b,...)` | one of the literals | string |
| `regex(...)` | the given regex | string |

### 4.2 Filters (converter pipeline)

`lower`, `upper`, `trim`, `int`, `float`, `ms`, `s` (duration unit change),
`map(a=x,b=y)`, `default(v)`, `truncate(n)`.
Example: `{status:int}` vs `{status:word|int}`.

### 4.3 Custom parsers

```jsonc
// regex parser
{ "name": "reqid", "regex": "req-[0-9a-f]{8}", "convert": ["upper"] }

// template parser: composition, yields nested fields
{ "name": "hostport", "template": "{host:host}:{port:port}" }
```

Parsers can reference other parsers. Cycles are rejected. Template parsers are
inlined into the parent regex with prefixed capture names.

## 5. Classifiers

```jsonc
{
  "name": "conn_failed",              // unique, [a-z0-9_.-]
  "template": "...",                  // or "regex": "...(?<field>...)..."
  "description": "Client could not reach peer",
  "priority": 100,                    // higher is tried first; ties keep definition order
  "sources": ["api"],                 // optional; default is all sources
  "time_field": "ts",                 // optional; event time comes from this field, not ingest time
  "store": "full",                    // full | fields | count  (keep raw line + fields / fields only / counters only)
  "tags": ["network", "error"],
  "parent": null,                     // for sub-classifiers
  "on": null                          // field of the parent to match against (default: whole raw line)
}
```

### 5.1 Matching

1. Classifiers are sorted by `priority` desc. Each compiled classifier keeps its
   **longest literal**, and a record that does not contain that literal
   (`String.includes`) skips the regex entirely. This prefilter makes hundreds
   of classifiers cheap.
2. The first top-level classifier that matches wins. Each record is counted
   once.
3. Its sub-classifiers are then tried (section 5.3).

### 5.2 Store levels

* `full`: event with fields and raw line (default).
* `fields`: event without raw line.
* `count`: no event stored. Counters and all-time field aggregates still update.
  Use this for known noise ("ignore").

### 5.3 Sub-classifiers

A classifier with `parent` set only runs on records its parent matched. It
matches against the parent's field `on`, or the raw line when `on` is absent.
Fields merge into the event, and child fields override the parent's on name
clashes. The event's `path` is the chain, e.g. `["http", "http.slow_admin"]`.
Metrics are kept for every node in the path.

Example: `http` extracts `{method:word} {path:path} {status:int} {took:duration}`.
A child `http.admin` with `on: "path"` and template `^/admin/{section:word}`
refines it further.

### 5.4 Retroactive classification

Defining a classifier re-runs it over the retained unclassified buffer. Matched
records move out of their clusters and become events. The tool result reports
how many records were absorbed.

### 5.5 Dry run

`test_classifier` compiles a definition without saving it and runs it against
given sample lines, or against the unclassified buffer or a cluster. It returns
match count, sample extracted fields, and lines that *almost* matched (the
prefilter literal was present but the regex failed). Use it to debug a template.

## 6. Unclassified clustering

Each unclassified record is **masked**, replacing variable tokens with
placeholders in this order: quoted strings, UUIDs, ISO timestamps, IPs, URLs,
paths, hex ≥ 8 chars, numbers (including units like `12ms`), and finally long
alphanumeric tokens that contain digits. The masked string is the cluster key.

A cluster holds: `id` (short hash of key), `shape` (masked text), `count`,
`first_seen`, `last_seen`, `sources`, up to N example records (first + most
recent), and a `suggested_template`. The suggested template is the shape with
placeholders turned into typed captures (`{f1:int}`, `{f2:uuid}`, ...), so the
agent can rename fields and submit it.

Bounds: max clusters (LRU by `last_seen`) and a raw unclassified ring buffer
(for retroactive classification).

## 7. Metrics

Every classifier node keeps **incremental all-time aggregates**:

* total count, first/last seen
* per-second buckets for the last hour (rate, timeseries)
* per field:
  * numeric: count, min, max, sum, mean, and a log-scale bucket sketch for
    approximate percentiles (p50/p90/p99)
  * string: top-K value counts (capped map, Space-Saving algorithm), distinct
    estimate

The **event store** (ring buffer per classifier, configurable size) supports
exact queries over recent events.

### 7.1 Filter language (`where`)

Mongo-style, ANDed at top level:

```jsonc
{ "status": { "gte": 500 }, "svc": { "in": ["api", "auth"] }, "path": { "regex": "^/admin" },
  "or": [ { "level": "error" }, { "took": { "gt": 1000 } } ] }
```

Operators: `eq` (implicit), `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`,
`regex`, `exists`, plus `and`, `or`, `not`.

### 7.2 Queries

* **search_events**: classifier (prefix match allowed, `http` includes
  `http.admin`), `where`, `since`/`until` (ISO or relative `-15m`), `limit`,
  `fields` projection, `order`.
* **histogram**: classifier + field. String fields return top values with
  counts. Numeric fields return stats plus buckets (`buckets: n` equal width,
  or explicit `bounds: [...]`). Optional `group_by` adds a histogram per value
  of another field (top-K groups). With `where`/`since` it is computed exactly
  from the event store. Without them it comes from all-time aggregates.
* **timeseries**: count, or `agg` (`sum|avg|max|min|p90`) of a numeric field,
  per `interval` over a window, optionally `group_by`.
* **stats**: overview of totals, classified ratio, rate per classifier
  (1m/5m/1h), top clusters, alarm states, source health.

## 8. Alarms

```jsonc
{
  "name": "conn_fail_burst",
  "classifier": "conn_failed",       // prefix match as in search
  "where": { "peer.port": 5432 },    // optional
  "kind": "rate",
  "params": { "count": 50, "window": "1m" },
  "cooldown": "5m",                   // minimum gap between firings
  "message": "Postgres connection failures spiking", // optional, included in notification
  "enabled": true
}
```

| Kind | Params | Fires when |
|---|---|---|
| `every` | `n` | every n-th matching event (n = 1 means every one) |
| `rate` | `count`, `window` | ≥ count matching events within sliding window |
| `absence` | `window` | no matching event for window (heartbeat). Checked on a timer. |
| `threshold` | `field`, `agg`, `op`, `value`, `window` | aggregate of a field over window crosses value (e.g. p90 of `took` > 2000) |
| `new_value` | `field` | field takes a value never seen before by this alarm (seen set capped) |
| `unclassified` | `count`, `window` | unclassified records ≥ count in window (no `classifier`) |

States: `ok` → `firing` → (cooldown) → `ok`. Each firing records
`{ alarm, t, value, sample_event }` in a capped history and sends a
notification immediately (alarms are not debounced, only cooldown-limited).

## 9. Notifications

Delivered through **both** of these:

1. **Claude Code channel**: capability `experimental: { "claude/channel": {} }`,
   method `notifications/claude/channel`, `params: { content, meta }`. The agent
   receives the content as a `<channel source="...">` message without polling.
   Requires launching Claude Code with the server enabled as a channel.
2. **Standard MCP logging**: `notifications/message` (level `warning` for
   alarms, `info` for unclassified digests), for any MCP client.

Kinds:

* **unclassified digest**: debounced (`quiet` 5s, `max_wait` 60s, both
  configurable). Only *new clusters*, or clusters whose count grew by a factor
  (e.g. ×10) since the last digest, are reported. Each is one compact line:
  `id`, count, shape. Repeats of known clusters never re-notify on their own.
  The digest also states the classified ratio.
* **alarm**: immediate, one per firing.
* **source**: a source exited, errored, or restarted.

The `set_notifications` tool can mute kinds or change debounce timing.

## 10. Sources

```jsonc
{ "name": "api",  "type": "file",    "path": "/var/log/api.log", "from_start": false }
{ "name": "k8s",  "type": "command", "command": "kubectl logs -f deploy/api", "restart": true }
{ "name": "net",  "type": "tcp",     "port": 5170, "host": "127.0.0.1" }
{ "name": "sock", "type": "unix",    "path": "/tmp/logs.sock" }
```

Common options: `multiline` (`{ "start": "<regex>" }` means a line that does not
match `start` continues the previous record, or `{ "continue": "<regex>" }`
such as `^\s`), `flush_ms` (multiline flush, default 250), `max_line`
(truncate, default 16 KiB), `strip_ansi` (default true).

`file` uses `tail -F` semantics, so it survives rotation. `command` runs in
`sh -c` with stdout and stderr merged, and can auto-restart with backoff.
Sources can also be given at startup via CLI flags (`--file`, `--cmd`, `--tcp`)
and are persisted in the state file when added through tools.

The `ingest` tool pushes lines directly, for tests or pasted logs.

> **Security:** `command` sources run shell commands as the server user. A CLI
> flag `--allow-commands` (off by default) controls whether the agent may add
> them through tools. Startup flags are always allowed.

## 11. MCP surface

### Tools

| Tool | Purpose |
|---|---|
| `get_unclassified` | Clusters sorted by count or recency, with shape, count, examples, suggested template. Options: `limit`, `since`, `source`, `min_count`, `cluster` (one cluster with more examples). |
| `define_parser` / `remove_parser` / `list_parsers` | Custom types. `list_parsers` includes built-ins. |
| `test_classifier` | Dry run (section 5.5). |
| `define_classifier` | Create or replace. Returns absorbed count and sample fields. |
| `remove_classifier` | Removes it and its sub-classifiers. Events are dropped. |
| `list_classifiers` | Definitions with counts and rates. |
| `search_events` | Section 7.2. |
| `histogram` | Section 7.2. |
| `timeseries` | Section 7.2. |
| `stats` | Section 7.2. |
| `define_alarm` / `remove_alarm` / `list_alarms` | Section 8. `list_alarms` includes state and last firing. |
| `alarm_history` | Recent firings. |
| `add_source` / `remove_source` / `list_sources` | Section 10. |
| `ingest` | Push lines. |
| `set_notifications` | Mute, unmute, debounce timing. |
| `export_definitions` / `import_definitions` | Share classifier packs (JSON) between projects. |

Every tool result is compact JSON text. Large lists are paginated with `limit`
and a `cursor`.

### Resources

`classifier://stats`, `classifier://unclassified`, `classifier://alarms`.
These support `resources/subscribe`, and `notifications/resources/updated` is
sent (debounced) when they change.

### Server instructions

The MCP `instructions` field explains the recommended loop to the agent:

1. `get_unclassified` → pick the biggest clusters.
2. `test_classifier` with a suggested template → refine field names and types.
3. `define_classifier`. Use `store: "count"` for pure noise.
4. Add alarms for what matters.
5. Wait for notifications instead of polling.

## 12. Persistence

The state file (default `./.diversity-classifier.json`, overridable with
`--state`) stores parsers, classifiers, alarms, tool-added sources and
notification settings. It is written atomically (temp file + rename),
debounced. Events, clusters and metrics are not persisted.

## 13. Configuration

CLI flags override env vars, which override defaults. All of these are exposed
as constants in `src/config`:

| Setting | Default |
|---|---|
| `EVENTS_PER_CLASSIFIER` | 5000 |
| `UNCLASSIFIED_BUFFER` | 20000 |
| `MAX_CLUSTERS` | 2000 |
| `CLUSTER_EXAMPLES` | 5 |
| `TOPK_VALUES` | 100 |
| `DIGEST_QUIET_MS` | 5000 |
| `DIGEST_MAX_WAIT_MS` | 60000 |
| `ALARM_HISTORY` | 500 |
| `STATE_FILE` | `./.diversity-classifier.json` |

## 14. Non-goals (v1)

* Long-term storage and querying of historical logs (use Loki or Elastic).
* Arbitrary JS in parsers. Converters are a fixed, safe set.
* Multi-tenant or remote (HTTP) transport. It could be added later.

## 15. Project layout

```
bin/mcp.js                MCP stdio entrypoint (CLI flags)
src/config/               constants + env/CLI resolution
src/patterns/             template compiler, built-in types, filters, parser registry
src/classifier/           classifier registry, prefilter, matching, sub-classifiers
src/clusterer/            masking + unclassified clusters
src/metrics/              event store, aggregates, histogram, timeseries, search
src/alarms/               alarm engine
src/notifier/             debounced digests, channel + logging delivery
src/sources/              file / command / tcp / unix / tool sources
src/engine/               wiring: record → classify → metrics/alarms | clusterer
src/state/                persistence
src/mcp/                  tool + resource definitions and handlers
src/utils/                ring-buffer, debounce, filter (where), duration parsing, line assembler, top-k, sketch
```

Tests use Jest, in `__tests__/` inside each module.
