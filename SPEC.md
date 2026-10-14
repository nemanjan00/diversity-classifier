# diversity-classifier: specification

An MCP server that watches log streams on behalf of an AI agent without
streaming every line into the model's context.

## 1. Problem

> **Scope:** this is a developer tool. An AI agent (e.g. Claude Code) starts
> it as an MCP server and points it at streams, typically a command such as
> `ssh prod-1 journalctl -fu api` or `kubectl logs -f ...`. It is not meant to be
> embedded in or deployed alongside a production application.


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
| **Event** | A classified record: `{ id, t, $source, $labels, classifier, path, fields, raw? }`. |
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

### 4.4 Reusable heads (spread)

Most log formats share a line prefix: timestamp, verbosity, sometimes a
logger name or PID. Define it once as a template parser and **spread** it with
`{...name}`. The parser's fields then merge into the parent namespace without a
prefix:

```jsonc
{ "name": "head", "template": "^{ts:timestamp} {level:level} [{logger:word}]" }
```

```
{...head} client {client:uuid} failed to connect to {peer:hostport}
```

This yields `ts`, `level`, `logger`, `client`, `peer.host`, `peer.port`. The
non-spread form `{h:head}` would yield `h.ts`, `h.level`, `h.logger`.
Changing `head` recompiles every classifier that uses it.

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

### 5.4 Envelope classifiers

An alternative to spreading a head into every classifier: define the head once
as an **envelope** classifier that captures the message body, and attach the
real classifiers to it as sub-classifiers.

```jsonc
{ "name": "app", "template": "{...head} {msg:rest}", "envelope": true, "body": "msg" }
{ "name": "app.conn_failed", "parent": "app", "on": "msg",
  "template": "client {client:uuid} failed to connect to {peer:hostport}" }
```

With `envelope: true`:

* A record that matches the envelope but **none of its children** still counts
  as **unclassified**. It goes to the clusterer, and the clusterer only masks
  the `body` field. Timestamps and levels therefore never fragment clusters,
  and the suggested templates are written relative to the body, ready to use
  as children.
* The envelope's fields (`ts`, `level`, `logger`) are attached to every child
  event and to cluster examples, so `where: {level: "error"}` works on every
  child. `get_unclassified` can also filter by envelope fields, e.g. "unknown
  error-level lines only".
* Envelopes can nest. For example, a syslog envelope might wrap an app
  envelope, which wraps a leaf.
* Several envelopes may coexist, one per log format or source. The first
  matching envelope by priority wins, as with any top-level classifier.

### 5.5 Retroactive classification

Defining a classifier (or parser) immediately runs it over **every retained
unclassified record**, not only over new lines.

* **Buffer.** The unclassified ring buffer keeps the full record: the raw text,
  the original ingest time, `$source`/`$labels` and any envelope fields
  already extracted. Clusters keep counts beyond what the buffer retains.
* **What runs.** Only the new or changed classifier, plus its sub-classifiers,
  runs over the buffer. Existing classifiers have already rejected these
  records, so they are skipped. For a new child of an envelope, only records
  that sit unclassified *under that envelope* are tried, and they are matched
  against the stored body.
* **Priority.** If the new classifier has a lower priority than one that would
  also match a later line, the result is the same as for live data, because
  each record is still classified once.
* **Effects on matched records.**
  * They become events with their **original timestamps**, so histograms and
    timeseries show the past correctly.
  * They update metrics and all-time aggregates.
  * They leave the buffer.
  * Their clusters' counts go down, and a cluster that reaches 0 is deleted.
    The counts beyond the buffer that cannot be re-checked move into a
    `backlog` number on the classifier, so totals still add up.
* **Alarms do not fire** for retroactively absorbed records. They are past
  events, and firing on them would flood notifications on every definition.
  `define_alarm` takes `backfill: true` to evaluate a new alarm over the
  stored events once, and it reports what *would* have fired.
* **Parser and head changes.** Changing a parser recompiles every classifier
  that uses it, and each affected classifier is re-run over the buffer.
  Records that were already classified are **not** reclassified. Use
  `reclassify` for that.
* **Tool result.**
  ```jsonc
  { "absorbed": 1834, "from_clusters": [{ "id": "c7f2", "matched": 1834, "remaining": 0 }],
    "backlog": 42110, "sample": [{ "fields": { ... } }],
    "unclassified_ratio": { "before": 0.41, "after": 0.12 } }
  ```
  The agent sees at once how much of the noise the definition removed.
* **Size.** The buffer is bounded (`UNCLASSIFIED_BUFFER`). Re-runs execute in
  chunks off the ingest path, so live lines keep flowing during a long re-run.
  Re-runs are cheap anyway, since the prefilter rejects most records with a
  single `includes`.

`reclassify` (tool) rebuilds events from the retained raw records of a
classifier subtree, or of everything. It is used after re-ordering priorities
or editing a template, when existing events should follow the new definition.
Only records with `store: "full"` still have raw text, so only they can be
reclassified.

### 5.6 Dry run

`test_classifier` compiles a definition without saving it and runs it against
given sample lines, or against the unclassified buffer or a cluster. It returns
match count, sample extracted fields, and lines that *almost* matched (the
prefilter literal was present but the regex failed). Use it to debug a template.

## 6. Unclassified clustering

**Invariant:** the unclassified buffer and clusters contain **only records
that no current classifier matches**. Nothing is hidden, snoozed or kept "for
reference". The unclassified view is the agent's work queue, and the goal is
to drive it to zero. The following operations maintain this invariant:

* **Define or change a classifier or parser.** Matching records leave at once
  (section 5.5). A cluster whose buffered records were all absorbed is deleted
  entirely, including its count beyond the buffer, which moves to the
  classifier's `backlog`.
* **Remove a classifier.** Its stored raw records return to the buffer and
  their clusters, because they are unclassified again.
* **Noise.** The agent does not dismiss noise, it classifies it. Noise is a
  classifier with `store: "count"` (conventionally named `ignore.*`). This
  keeps noise counted, rate-alarmable and visible in `stats`, while the queue
  stays clean.
* **Envelope-only matches** stay in the queue, clustered by body (section 5.4).
  Only a leaf classification removes a record from the queue.
* **Eviction.** When the buffer or cluster cap is hit, the oldest records or
  clusters are evicted and counted in `stats.unclassified.evicted`, so the
  agent knows the queue overflowed. Records are never silently reclassified.

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
| `source_silent` | `source`, `window` | a source/label produced no records for window (section 10.1) |
| `sequence` | `first`, `then`, `within`, `key?` | event of `first` followed by `then` within window, optionally same `key` value (section 10.1) |

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

* **unclassified digest** (sent only while the queue is non-empty): debounced (`quiet` 5s, `max_wait` 60s, both
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

The `ingest` tool pushes lines directly, for tests or pasted logs. It takes an
optional `source` name, `ingest` by default.

### 10.1 Multistream

Any number of sources run concurrently, and each has its own line assembler,
so multiline records from different streams never interleave.

* **Identity**: every record carries `$source` (the source name) and
  `$labels` (a map from the source definition, e.g.
  `{ "labels": { "env": "prod", "service": "api" } }`). Both can be used in
  `where` (`{"$source": "api", "$labels.env": "prod"}`), `group_by` and alarm
  filters, just like regular fields.
* **Demultiplexing a single stream**: one source can carry many logical
  streams, as with `kubectl logs -l app=x --prefix`,
  `docker compose logs -f` or `journalctl -f`. A `demux` option splits them:
  ```jsonc
  { "name": "k8s", "type": "command",
    "command": "kubectl logs -f -l app=api --prefix --all-containers",
    "demux": { "regex": "^\\[(?<pod>[^\\]]+)\\]\\s", "label": "pod", "strip": true } }
  ```
  The captured value becomes a label, so each sub-stream gets its own multiline
  assembly. `strip` removes the prefix before classification, so one
  classifier works for every pod.
* **Scoping**: classifiers and alarms take an optional `sources` list (names,
  or `name:*` glob). By default they apply to all streams. The same template
  is therefore shared across streams, and per-stream breakdown is a
  `group_by: "$source"` query rather than a separate classifier.
* **Clusters**: the cluster key is the masked shape *without* the source, so
  the same unknown message from 20 pods appears as one cluster. Each cluster
  holds per-source and per-label counts, and `get_unclassified` can filter by
  `source`.
* **Per-stream health**: `list_sources` and `stats` report, per source and per
  demuxed label, lines/s, last line time, classified ratio, and
  restarts/errors. A built-in alarm kind `source_silent` (params: `source`,
  `window`) fires when a stream goes quiet.
* **Correlation (v1-light)**: `timeseries` with `group_by: "$source"` across
  a classifier prefix aligns streams on one time axis. A `sequence` alarm
  kind (params: `first`, `then`, `within`, `key`) fires when event A is
  followed by event B within a window. With `key`, both events must share the
  same field value (e.g. `request_id`), which lets one stream's event be
  matched to another's.

`command` is the primary source type. The agent typically adds sources like
`ssh host tail -F /var/log/app.log` itself through `add_source`.

> **Security:** `command` sources run shell commands as the user who started the
> server. That is the same trust level the agent already has in a coding
> session. `--no-commands` disables `command` sources added through tools
> (MCP or web), for setups where the agent should only see pre-configured
> streams.

## 11. MCP surface

### Tools

| Tool | Purpose |
|---|---|
| `get_unclassified` | Clusters sorted by count or recency, with shape, count, examples, suggested template. Options: `limit`, `since`, `source`, `min_count`, `cluster` (one cluster with more examples). |
| `define_parser` / `remove_parser` / `list_parsers` | Custom types. `list_parsers` includes built-ins. |
| `test_classifier` | Dry run (section 5.6). |
| `define_classifier` | Create or replace. Returns absorbed count and sample fields. |
| `remove_classifier` | Removes it and its sub-classifiers. Events with raw text go back to the unclassified buffer and clusters. |
| `reclassify` | Re-run classification over retained raw records (section 5.5). |
| `list_classifiers` | Definitions with counts and rates. |
| `search_events` | Section 7.2. |
| `histogram` | Section 7.2. |
| `timeseries` | Section 7.2. |
| `stats` | Section 7.2. |
| `define_alarm` / `remove_alarm` / `list_alarms` | Section 8. `list_alarms` includes state and last firing. |
| `alarm_history` | Recent firings. |
| `add_source` / `remove_source` / `list_sources` | Section 10. |
| `ingest` | Push lines. |
| `ignore_cluster` | Shortcut: turn a cluster's suggested template into an `ignore.<id>` classifier with `store: "count"`, which removes it from the queue (section 6). |
| `set_notifications` | Mute, unmute, debounce timing. |
| `web_ui` | Start the web UI on demand (if not started with `--http`) and return its URL. |
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

Everything the agent defines persists across runs. The next session starts
with the server already classifying and alarming, and does not need to relearn
the logs.

**Persisted:** parsers, classifiers, alarms, tool-added sources, notification
settings. Also persisted: the
`new_value` alarms' seen-sets (capped), so a restart does not re-fire on every
known value.

**Not persisted:** events, clusters, metrics, alarm history. These are runtime
data. Restarting gives a clean window.

**Layers**, loaded in order, with later layers overriding earlier ones by name:

1. **Global**: `$XDG_CONFIG_HOME/diversity-classifier/global.json`. This holds
   reusable parsers and heads (`head`, `hostport`, nginx/syslog envelopes) that
   are shared by every project.
2. **Project**: `./.diversity-classifier.json` (or `--state <path>`). This is
   the server's working directory, which is the project when launched by Claude
   Code.

Each definition tool takes `scope: "project" | "global"` (default `project`) to
choose which file it writes to. `list_*` tools show each definition's scope.

**Writes** happen on every definition change. They are debounced (200 ms) and
atomic (temp file + rename). The format is versioned JSON
(`{ "version": 1, "parsers": [...], ... }`) and is designed to be readable,
diffable and committable. The project file can be checked into a repo, so the
team shares the same classifier pack.

**Loading** at startup compiles every definition. An invalid definition (for
example, one that references a deleted parser) is loaded as `disabled` with an
`error`, not dropped. It is reported in `stats` and in the first notification,
so the agent can fix it.

**External edits**: the files are watched. A manual edit is reloaded live and
the change is announced through a `source`-kind notification.

## 13. Web UI (optional)

The engine can also be served over HTTP. The web server is off by default and
is enabled with `--http [host:]port`, or on demand with the `web_ui` tool.

### 13.1 Running

The agent launches the server over stdio as usual. Passing `--http [host:]port`
(or calling the `web_ui` tool, which starts the server on demand and returns the
URL) additionally serves the UI from the same process. The UI shows the same
engine, sources and state the agent is using, and it stops when the MCP
session ends.

### 13.2 Security

* Binds to `127.0.0.1` by default.
* A non-loopback bind requires `--token <secret>` (or the `HTTP_TOKEN` env
  var). The token is checked as a bearer token on `/api` and `/mcp`, and the UI
  asks for it once and keeps it in `sessionStorage`.
* `--read-only` disables every mutating endpoint. This is useful when the UI
  is shared with a team.
* `--no-commands` applies to HTTP the same way it applies to MCP tools.

### 13.3 REST API + live updates

* `POST /api/<tool>` mirrors every MCP tool one to one, with the same handlers
  and the same JSON arguments. The MCP and REST layers are both thin adapters
  over one handler table, so the two can never drift apart.
* `GET /api/events/stream` is **SSE**. It carries: `record` (sampled live tail;
  the client picks the sample rate and filters), `cluster` (new or grown),
  `alarm`, `source`, `stats` (every 2 s) and `definitions` (changed).

### 13.4 Pages

The UI is built on [qrp-shadcdn](https://github.com/nemanjan00/qrp-shadcdn)
(shadcn/ui components on the 5 KB qrp reactive core). There is no React and no
build step.

* `@nemanjan00/qrp` and `@nemanjan00/qrp-shadcdn` are npm dependencies.
  The server serves their `dist/` files under `/vendor/` and maps them with an
  `<script type="importmap">`, so the UI works **offline**, with no CDN.
  The prebuilt `qrp-shadcdn.css` is used, and custom layout CSS stays minimal.
* App code lives in `src/web/public/` as plain ES modules, one per page.
* The shell is a `Sidebar` layout. Components used: `DataTable` (events,
  clusters, alarms), `Chart` (histograms, timeseries, sparklines), `Dialog` and
  `Sheet` (editors), `Combobox` (classifier/field pickers), `Sonner` (alarm
  toasts), `Badge` (levels, alarm states) and `Tabs`.
* SSE updates write into qrp `state` proxies, so only the bound DOM nodes
  update. This is what lets the live tail and the counters keep up with
  high-rate streams.
* Dark mode follows `prefers-color-scheme`, toggled with `class="dark"` on
  `<html>`.

1. **Overview**: classified ratio over time, lines/s per source, firing
   alarms, top classifiers and top unclassified clusters.
2. **Live tail**: a merged multistream tail. Each line is coloured by
   classifier, unclassified lines are highlighted, and extracted fields are
   underlined (hover shows name, type and value). Filter by source, label,
   classifier, `where`, or "unclassified only". Pause and scrollback come from
   the ring buffers.
3. **Unclassified**: clusters with counts, sparklines and examples. **Classify**
   opens the suggested template in the editor, and **Ignore** creates a count-only
classifier. The page only ever lists records that nothing matches, so an empty
page means everything is understood.
4. **Classifier editor**: template input with live syntax highlighting of
   captures and a type picker. **Test** runs against the cluster or buffer and
   shows matched lines with highlighted fields, near-misses, and the absorbed
   count. Also includes parent/envelope selection, a priority and store level,
   and a scope (project/global).
5. **Explore**: histogram and timeseries builder (classifier, field, `where`,
   `group_by`, window), plus an event search table.
6. **Alarms**: list with state, a firing history, and create/edit forms per
   kind.
7. **Sources**: health per source and per demux label, add/remove, restart.
8. **Definitions**: tree of parsers, envelopes and classifiers with their
   scope, import/export of packs, and disabled definitions with errors.

Edits from the UI and edits from the agent go through the same handlers. The
agent gets a `definitions`-kind notification when a human changed something,
so it doesn't fight the user's edits.

## 14. Configuration

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
| `HTTP` | off |
| `HTTP_TOKEN` | none (required for non-loopback bind) |
| `STATE_FILE` | `./.diversity-classifier.json` |
| `GLOBAL_STATE_FILE` | `$XDG_CONFIG_HOME/diversity-classifier/global.json` |

## 15. Non-goals (v1)

* Long-term storage and querying of historical logs (use Loki or Elastic).
* Arbitrary JS in parsers. Converters are a fixed, safe set.
* Production deployment, daemon mode, or running inside an application.
* Multi-tenant (several isolated engines in one process).
* User accounts and roles in the web UI (single token only).

## 16. Project layout

```
bin/mcp.js                MCP stdio entrypoint (CLI flags, optional --http)
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
src/mcp/                  tool + resource definitions and handlers (shared by MCP and REST)
src/web/                  HTTP server, REST adapter, SSE, auth; public/ holds the static UI
src/utils/                ring-buffer, debounce, filter (where), duration parsing, line assembler, top-k, sketch
```

Tests use Jest, in `__tests__/` inside each module.
