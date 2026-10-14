# diversity-classifier

**Let an AI agent watch your logs without reading them.**

LLM agents can't consume a stream, and pasting logs into context is slow and
expensive. But logs are mostly the same few templates repeated millions of
times. diversity-classifier is an [MCP](https://modelcontextprotocol.io)
server that sits on your log streams, lets the agent **teach it those
templates once**, and from then on does the cheap work itself: matching,
counting, aggregating and alerting.

The agent only ever sees:

- **lines nothing matches**, deduplicated into clusters such as
  `×4,812  client <uuid> failed to connect to <ip>:<num> after <dur>`, each with
  a ready-to-edit template, and
- **aggregates and alarms** over everything it already understands.

The unclassified queue is the agent's to-do list. Every classifier it defines
absorbs matching lines immediately, including the backlog, so the queue
shrinks toward zero and so does the cost of watching.

```
 ssh prod journalctl -f ─┐
 kubectl logs -f ... ────┼─► classifier engine ─┬─► events ─► search · histograms · timeseries · alarms ─► 🔔 agent
 tail -F app.log ────────┘   (templates,        │
                              envelopes)        └─► unclassified clusters ─► debounced digest ─► 🔔 agent
                                                     ▲                                │
                                                     └── define_classifier ◄──────────┘
```

A Kibana-style **web UI** lets humans explore the same data: Discover,
per-field histograms, timeseries, dashboards the agent can build for you.

## Quick start (Claude Code)

```sh
# in your project (Node >= 20):
claude mcp add logs -- npx -y @nemanjan00/diversity-streamer
```

Published on npm as [`@nemanjan00/diversity-streamer`](https://www.npmjs.com/package/@nemanjan00/diversity-streamer).
The state file is created in the directory Claude Code starts the server in,
i.e. your project.

Then ask: *"Watch the API logs on prod-1 (`ssh prod-1 journalctl -fu api -o short-iso`), classify what's there and alert me on anything unusual."*

**Push notifications.** The server pushes digests and alarm firings as
[Claude Code channel](https://docs.claude.com/en/docs/claude-code) messages,
so the agent reacts without polling. Enable it for this server with:

```sh
claude --dangerously-load-development-channels server:logs
```

Without channels everything still works. Notifications also go out as
standard MCP log messages, and the agent can poll `stats` and
`get_unclassified`.

## How the agent works with it

1. **Point it at streams**: `add_source { name: "api", type: "command", command: "ssh prod-1 journalctl -fu api -o short-iso" }`.
   Files (`tail -F`), TCP and Unix sockets, and pasted lines (`ingest`) work too.
2. **Look at the queue**: `get_unclassified` returns clusters sorted by count,
   each with a `suggested_template`.
3. **Factor out the line head once**:
   ```jsonc
   define_parser     { "name": "head", "template": "^{ts:timestamp} {level:level} [{logger:word}]" }
   define_classifier { "name": "app", "template": "{...head} {msg:rest}", "envelope": true, "time_field": "ts" }
   ```
   Lines matching only the envelope stay unclassified, but they are now
   clustered by message body, so timestamps never fragment clusters.
4. **Test, then define**:
   ```jsonc
   test_classifier   { "parent": "app", "template": "client {client:uuid} failed to connect to {peer:hostport} after {took:duration}" }
   define_classifier { "name": "app.conn_failed", "parent": "app", "template": "…" }
   // → { "retro": { "absorbed": 4812, "queue": { "before": {...}, "after": {...} } } }
   ```
   When a template doesn't match, `near_misses` say exactly where it fails:
   `"matched_up_to": "… {client:uuid} whitespace \"failed\" …", "failed_at": "{peer:hostport}"`.
5. **Ask questions** with a KQL-like query language:
   ```jsonc
   histogram  { "classifier": "app.http", "field": "status" }
   timeseries { "classifier": "app.http", "q": "took > 2s", "split_by": "$labels.pod", "interval": "1m" }
   search_events { "q": "status >= 500 and not path:/health* and $source:api" }
   ```
6. **Set alarms**: `rate`, `threshold` (e.g. p90 of `took` > 2s over 5m),
   `new_value` (a never-seen client id), `absence` (heartbeat stopped),
   `sequence` (A then B with the same `request_id`), `source_silent` and
   `unclassified`.
7. **Wait.** With channels, unclassified digests are pushed (debounced) and
   alarm firings immediately. Without channels, the agent calls `wait`, which
   blocks until a new cluster, an alarm or a source failure.

Everything the agent defines is **persisted** in `./.diversity-classifier.json`.
You can commit it to share the classifier pack with your team. Reusable heads
can go in a global file shared across projects. On the next run the server
starts with the same definitions.

## Template language

```
{name:type}                 typed capture             {status:int} {took:duration} {client:uuid}
{name:type(args)}           parameterised             {method:enum(GET,POST)} {id:regex([A-Z]{3}-\d+)}
{name:type|filter|...}      converter pipeline        {svc:word|lower|map(gw=gateway)}
{name?:type}                optional                  {name:/regex/flags}   inline regex
{_:type}  {*}               match, don't keep         {...parser}           spread a parser's fields
{{ }}                       literal braces            whitespace runs match \s+, ^ and $ anchor
```

**Built-in types:** `word text rest int float number hex bool uuid ip ipv4 ipv6 host port email url path iso8601 timestamp duration bytes level quoted json kv enum regex`.
`duration` → ms, `bytes` → bytes, `timestamp` handles ISO, syslog, CLF and epoch
→ epoch ms, and `level` normalises `WARNING`/`W`/`warn` → `warn`. `json` and `kv`
flatten into `name.key` fields.

**Custom parsers** are either a regex with converters, or a template, which
gives you composition: `{ "name": "hostport", "template": "{host:host}:{port:port}" }`
and then `{peer:hostport}` → `peer.host`, `peer.port`.

**Sub-classifiers** refine a parent's field: a `http` classifier with
`{path:path}`, plus a child `http.admin` with `on: "path"` and template
`^/admin/{section:word}`.

## Multistream

Run any number of sources at once. Every record carries `$source` and
`$labels`. `demux` splits one combined stream into many, e.g.
`kubectl logs --prefix` into one stream per pod:

```jsonc
{ "name": "k8s", "type": "command", "command": "kubectl logs -f -l app=api --prefix --all-containers",
  "demux": { "regex": "^\\[(?<pod>[^\\]]+)\\]\\s", "label": "pod", "strip": true },
  "multiline": { "continue": "^\\s" } }
```

The same unknown message from 20 pods appears as one cluster, with per-pod
counts.

## Web UI

```sh
npx -y @nemanjan00/diversity-streamer --http 7070      # or let the agent call the web_ui tool
```

- **Discover**: query bar, time picker, live mode, a hits histogram, a field
  sidebar with top values and +/− filters, and an expandable event table.
- **Classifiers**: an explorer tree and per-classifier pages with one
  histogram and one over-time panel per field. Panels cross-filter: click
  `status=503` to see which hosts and latencies go with it. Also includes an
  editor with live testing.
- **Visualize**, **Dashboards**: the agent can create dashboards with
  `define_dashboard`.
- **Unclassified** (Classify / Ignore), **Alarms**, **Sources**.

It binds to `127.0.0.1` by default. A non-loopback bind requires `--token`, and
`--read-only` disables edits. Built with
[qrp-shadcdn](https://github.com/nemanjan00/qrp-shadcdn), so there is no build
step and it works offline.

## CLI

```
npx -y @nemanjan00/diversity-streamer [options]
  --cmd "[name=]command"      --file "[name=]path"      --tcp "[name=][host:]port"      --unix "[name=]path"
  --state <path>              --global-state <path>     --no-global
  --http [host:]port          --token <secret>          --read-only
  --no-commands               forbid adding command sources through tools / UI
  --resume-sources            auto-start command sources saved in state files
```

Tuning goes through env vars (`DC_EVENTS_TOTAL`, `DC_UNCLASSIFIED_BUFFER`,
`DC_DIGEST_QUIET_MS`, …). See `--help`.

## Security notes

- `command` sources run shell commands as the user running the server, which
  is the same trust level the agent already has in a coding session.
  `--no-commands` limits the agent to sources given on the command line.
- Command sources saved in a state file **load paused**. A cloned repo with a
  malicious `.diversity-classifier.json` therefore cannot execute anything on
  startup. The agent (or you) resumes them with `start_source`, or you opt in
  with `--resume-sources`.

## Limits (by design)

This is a developer tool, not a log store. Events live in bounded ring buffers
(`DC_EVENTS_TOTAL`, default 200k). All-time counters and field aggregates are
kept beyond that, but there is no long-term retention. Use Loki or Elastic for
history.

## Development

```sh
git clone https://github.com/nemanjan00/diversity-classifier.git
cd diversity-classifier && yarn install   # dev tooling needs Node >= 22.18
claude mcp add logs-dev -- node "$PWD/bin/mcp.js"

yarn test        # jest
yarn lint        # eslint
yarn mcp-watch   # nodemon -q bin/mcp.js
```

See [SPEC.md](SPEC.md) for the full design.

## License

MIT
