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
| `rest` | everything to the end, spanning lines in multiline records; whitespace written right before it matches exactly, so the remainder keeps its own indentation | string |
| `int` | `[-+]?\d+` | number |
| `float` / `number` | decimal or scientific | number |
| `hex` | `(0x)?[0-9a-fA-F]+` | string |
| `bool` | true/false/yes/no/on/off | boolean |
| `uuid` | canonical UUID | string (lowercase) |
| `ipv4`, `ipv6`, `ip` | addresses | string |
| `host` | hostname or IP | string |
| `port` | 1-65535 | number |
| `email`, `url`, `path` | as named (`path` includes any query string) | string |
| `pathname` | path without query string / fragment | string |
| `qs` | URL query string, leading `?` optional; URL-decoded, `&`-separated, repeated keys → list, numbers converted | object, flattened to `name.key` |
| `iso8601` | ISO-8601 timestamp; `iso8601(utc\|local\|±HH:MM)` sets the zone of zone-less values (default local) | epoch ms |
| `timestamp` | ISO-8601, `YYYY-MM-DD HH:MM:SS[.fff]`, syslog `Mmm dd HH:MM:SS`, CLF, epoch s/ms; same zone argument | epoch ms |
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

#### Envelope multiline

Prefixed streams (container/task/pod prefixes, syslog heads) break source-level
multiline rules, because the continuation marker is behind the prefix. An
envelope can therefore join continuation lines **by body**:

```jsonc
{ "name": "app", "template": "^[{worker:word}] {msg:rest}", "envelope": true,
  "multiline": { "continue": "^\\s+at |^\\s*}", "group_by": ["worker"], "flush_ms": 300 } }
```

* `start` (a body that does *not* match continues the record) or `continue`
  (a body that matches continues it).
* Pending records are keyed by envelope + source + labels + the `group_by`
  field values, so interleaved streams never mix.
* The joined record has `raw` = the joined lines, and `body` = the joined
  bodies. Children classify it as one record; `{x:rest}` spans the lines.
* Queue entries and events remember that they were assembled, so retroactive
  classification, `reclassify` and classifier removal continue them from
  the envelope instead of re-parsing the joined raw text.

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
* **Size.** The buffer is bounded (`UNCLASSIFIED_BUFFER`). Re-runs execute
  synchronously, so they are atomic with respect to live ingest: no line can
  slip between the re-run and the new definition. They are cheap, because the
  prefilter rejects most records with a single `includes`.

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

The **event store** supports exact queries over recent events. It is a ring
buffer per classifier, under a global cap that evicts oldest-first across
classifiers. Each classifier reports its **retained window** (oldest retained
event time). The UI shades time ranges older than that window, and the
aggregate counters still cover the full history. A query scans only the stores of the classifiers that match the `classifier`
glob. Events are filtered by time range and `where` in one linear pass, which
is fast at these sizes and correct even when event time comes from a
`time_field` and arrives out of order.

### 7.1 Filter language (`where`)

Mongo-style, ANDed at top level:

```jsonc
{ "status": { "gte": 500 }, "svc": { "in": ["api", "auth"] }, "path": { "regex": "^/admin" },
  "or": [ { "level": "error" }, { "took": { "gt": 1000 } } ] }
```

Operators: `eq` (implicit), `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`,
`regex`, `exists`, plus `and`, `or`, `not`.

### 7.2 Query string (KQL-like)

Every query tool and the UI search bar accept `q`, a text query that compiles
to the same `where` tree. When both `q` and `where` are given they are ANDed.
The text form is easier for both the agent and humans to type:

```
classifier:http.* and status >= 500 and not path:/health*
level:(error or fatal) and $source:k8s and $labels.pod:api-7f*
took > 2s and client:"9b1c..."          # typed literals: durations, bytes, timestamps
peer.host:db-* or exists:err.code
```

* `field:value` means equality. A `*` in the value is a glob, `/re/` is a
  regex, `(a or b)` is a set, `exists:field` tests for presence, and the
  comparison operators are `> >= < <=`.
* Comparisons use the field's declared type, so `took > 2s` compares in ms and
  `size > 1MB` in bytes.
* `classifier:` filters by classifier path and accepts globs. A bare term
  without `field:` is a substring search over the raw line, available for
  `store: "full"` events only.
* Parse errors return the error position, which the UI underlines.

### 7.3 Queries

All queries take `q`/`where`, `classifier` (glob) and a time range
(`since`/`until`, ISO or relative `-15m`, `now`).

* **search_events**: classifier (prefix match allowed, `http` includes
  `http.admin`), `where`, `since`/`until` (ISO or relative `-15m`), `limit`,
  `fields` projection, `order`.
* **histogram**: classifier + field. String fields return top values with
  counts. Numeric fields return stats plus buckets (`buckets: n` equal width,
  or explicit `bounds: [...]`). Optional `group_by` adds a histogram per value
  of another field (top-K groups). With `where`/`since` it is computed exactly
  from the event store. Without them it comes from all-time aggregates.
* **timeseries** (Kibana's date histogram): count, or `agg`
  (`sum|avg|min|max|p50|p90|p99|distinct`) of a field, per `interval`
  (default: auto, about 60 buckets). An optional `split_by` field gives one
  series per top-K value plus `other`. This is how "status over time" or
  "errors per pod over time" is drawn.
* **heatmap**: the distribution of a numeric field over time, i.e. time
  buckets × value buckets (log-scale by default) → count. For example, latency
  spread per minute.
* **field_summary** (Kibana's field sidebar): for a result set, list every
  field with its type, its presence %, and either the top 5 values with %
  (strings) or min/max/avg/p50/p90 (numbers). It is computed from up to
  `sample` (default 5000) matching events.
* **fields**: the field catalogue of a classifier subtree, i.e. name, type,
  where it comes from (head, parser, child) and presence. Used for
  autocomplete.
* **sequences**: ad-hoc counterpart of the `sequence` alarm. For each event
  of `first`, it finds the next event of `then` with the same `key` value and
  reports gap statistics overall and per key, unmatched counts and recent
  pairs.
* **count**: number of matching retained events.
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

### 10.2 Redaction

Every record is redacted **at ingest**, before classification, so secrets
never reach clusters, examples, events, notifications or the UI. It is on by
default, with builtins `bearer`, `basic_auth`, `url_credentials`,
`secret_kv` (`password=`, `token:`, `api_key=` …), `jwt` and
`private_key_block`. `set_redaction` chooses builtins, adds regexes or turns
redaction off; the settings persist.

Classifiers can additionally list `redact: ["field", …]`. Those field values
are masked in stored events, and their occurrences in the stored raw line are
masked too.

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
| `search_events` | Section 7.3. |
| `histogram` | Section 7.3. |
| `timeseries` | Section 7.3. |
| `stats` | Section 7.3. |
| `define_alarm` / `remove_alarm` / `list_alarms` | Section 8. `list_alarms` includes state and last firing. |
| `alarm_history` | Recent firings. |
| `add_source` / `remove_source` / `list_sources` / `start_source` / `restart_source` | Section 10. |
| `ingest` | Push lines. |
| `search_unclassified` | `q`/`where` search over raw buffered unclassified records (envelope fields included). |
| `ignore_cluster` | Shortcut: turn a cluster's suggested template into an `ignore.<id>` classifier with `store: "count"`, which removes it from the queue (section 6). |
| `set_notifications` | Mute, unmute, debounce timing. |
| `set_redaction` | Ingest-time redaction builtins/patterns, with a `test` preview (section 10.2). |
| `sequences` / `count` | Section 7.3. |
| `wait` | Block until a new cluster, alarm, N records/events or a source failure (for clients without channel notifications). |
| `fields` / `field_summary` / `heatmap` | Section 7.3. |
| `define_visualization` / `define_dashboard` / `remove_view` / `list_views` | Saved charts and dashboards for the web UI (section 13.4). Returns a UI link. |
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

**Persisted:** parsers, classifiers, alarms, tool-added sources (command
sources load **paused**: a cloned state file must never run commands on
startup. The agent resumes them with `start_source`, or `--resume-sources`
opts in), saved
visualizations and dashboards, notification settings. Also persisted: the
`new_value` alarms' seen-sets (capped), so a restart does not re-fire on every
known value.

**Not persisted:** events, clusters, metrics, alarm history. These are runtime
data. Restarting gives a clean window.

**Layers**, loaded in order, with later layers overriding earlier ones by name:

1. **Global**: `$XDG_CONFIG_HOME/diversity-classifier/global.json`. This holds
   reusable parsers and heads (`head`, `hostport`, nginx/syslog envelopes) that
   are shared by every project.
2. **Project**: `./.claude/diversity-classifier.json` (an existing
   `./.diversity-classifier.json` keeps being used; or `--state <path>`). This is
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

### 13.4 UI: Kibana for the classified stream

The web UI is how a **human** explores what the agent has taught the server:
search, metrics and charts over classified events. The agent works through
MCP, and the human works here. Both use the same engine and the same
definitions.

**Stack:** [qrp-shadcdn](https://github.com/nemanjan00/qrp-shadcdn) (shadcn/ui
on the 5 KB qrp reactive core). There is no React and no build step.
`@nemanjan00/qrp` and `@nemanjan00/qrp-shadcdn` are npm dependencies. The server
serves their `dist/` files under `/vendor/` and maps them with an importmap, so
the UI works offline. App code lives in `src/web/public/` as plain ES modules,
one per page. SSE updates write into qrp `state` proxies, so only the bound DOM
nodes update. Light and dark themes follow `prefers-color-scheme`.

**Global controls** (top bar, shared by all pages, and kept in the URL so views
are linkable):

* **Query bar**: the KQL-like `q` (section 7.2), with autocomplete for fields,
  values and classifiers taken from `fields`/`field_summary`. Errors are
  underlined at the parse position.
* **Filter pills**: structured filters added by clicking in charts and
  tables. Each pill can be toggled, negated or removed.
* **Time picker**: quick ranges (last 5m/15m/1h/24h), absolute ranges, and
  **live mode** with a refresh interval of 1s/5s/off. The part of the range
  older than the retained window is shaded and marked "aggregates only".

**Pages:**

1. **Discover** (the default page)
   * Hits-over-time bar chart for the current query. Drag across it to zoom
     the time range. It can be stacked by classifier or by any field.
   * **Field sidebar**: fields of the matched classifiers, grouped by
     classifier, with type icons. Clicking a field opens its `field_summary`:
     top values with % bars and **+ / −** buttons (filter for / against), or
     numeric stats with a mini histogram. Each field also has a **Visualize**
     button.
   * **Event table**: time, classifier badge and selected field columns (add
     them from the sidebar). Rows expand to the raw line, with extracted fields
     highlighted inline, plus a field/value table that has + / − on every value.
   * The **Unclassified** toggle switches the table to the queue (clusters),
     so unknown lines can be searched the same way.
2. **Classifiers** (explorer)
   * A tree of envelopes → classifiers → sub-classifiers. Each node shows a
     count, a rate sparkline, store level and scope, and has an error marker
     when disabled.
   * **Classifier detail**: definition (template with typed captures
     highlighted), rate over time, sample events, and **one panel per field**.
     A field panel shows the value histogram (top-K bars or numeric
     distribution) and the field **over time** (stacked top values, or a
     heatmap for numbers). Clicking a bar applies it as a filter to the whole
     page, so the other fields' panels re-render for that subset. This is
     cross-filtering: for example, click `status=503` and see which `peer.host`
     and which `took` distribution go with it.
   * **Editor** (`Sheet`): template with live highlighting, a type picker,
     parent/envelope/priority/store/scope settings, and **Test** against the
     queue (matches, near-misses, absorbed count) before saving.
3. **Visualize**: a chart builder over any query.
   * **Bar**: terms of a field (top-K), optionally split by a second field.
   * **Histogram**: buckets of a numeric field.
   * **Line/area over time**: count or aggregate (`avg/p90/max/sum/distinct`),
     split by a field. Buckets without data for a statistic are connected
     with a dashed line by default (`empty: "zero"` draws them as 0,
     `"gap"` leaves a gap); counts and sums are always 0 there.
   * **Heatmap**: numeric field over time.
   * **Metric tile**: a single aggregate, with a delta against the previous
     period.
   * **Table**: group by one or more fields with aggregate columns.

   Charts can be saved, which persists them to the state file.
4. **Dashboards**: a grid of saved visualizations that share the global query
   and time range. Clicking a chart adds a filter, and every panel then
   updates. Dashboards persist with the definitions, so they come back next
   run. The **agent can build them too** with the `define_dashboard` tool, e.g.
   "I classified the nginx logs and made you a dashboard: [link]".
5. **Unclassified**: the queue (section 6), with clusters, counts, sparklines
   and examples. **Classify** opens the editor prefilled with the suggested
   template, and **Ignore** creates a count-only classifier. An empty page
   means everything is understood.
6. **Alarms & Sources** (secondary): alarm states, firing history (each
   firing links to Discover with its filter and time applied), and per-source
   and per-label health. Mostly read-only, since the agent manages these.

Edits from the UI and edits from the agent go through the same handlers. The
agent gets a `definitions`-kind notification when a human changed something,
so it doesn't fight the user's edits.

## 14. Configuration

CLI flags override env vars, which override defaults. All of these are exposed
as constants in `src/config`:

| Setting | Default |
|---|---|
| `EVENTS_PER_CLASSIFIER` | 20000 |
| `EVENTS_TOTAL` | 200000 |
| `UNCLASSIFIED_BUFFER` | 20000 |
| `MAX_CLUSTERS` | 2000 |
| `CLUSTER_EXAMPLES` | 5 |
| `TOPK_VALUES` | 100 |
| `DIGEST_QUIET_MS` | 5000 |
| `DIGEST_MAX_WAIT_MS` | 60000 |
| `ALARM_HISTORY` | 500 |
| `HTTP` | off |
| `HTTP_TOKEN` | none (required for non-loopback bind) |
| `STATE_FILE` | `./.claude/diversity-classifier.json` (legacy `./.diversity-classifier.json` if present) |
| `GLOBAL_STATE_FILE` | `$XDG_CONFIG_HOME/diversity-classifier/global.json` |

## 15. Non-goals (v1)

(See also the README section "Where the agent can get hurt": ambiguities that
are documented rather than fixed, e.g. silence vs. health, filtered vs. absent,
retention and restarts. The same list is part of the MCP server instructions.)


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
