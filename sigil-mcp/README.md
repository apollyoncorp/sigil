# sigil-mcp

An [MCP](https://modelcontextprotocol.io) server that lets your own AI assistant (Claude, Codex, Cursor, ...) draw diagrams for [Sigil](https://sigil.apollyoncorp.com), Apollyon's free drawing board (a fork of Excalidraw).

**Privacy.** sigil-mcp only draws. It never calls an LLM. Run locally (the default, below), it never makes a network request either: your assistant sends it shapes, it writes a `.excalidraw` file on your disk and builds a link; that is all. The link carries the diagram inside it (`https://sigil.apollyoncorp.com/#data=...`): the part after `#` is never sent to any server, and Sigil reads it in your browser. The [remote server](#remote) is different, and says so plainly.

## Install

Needs Node 20 or newer. Nothing to install by hand; `npx` fetches it.

**Claude Code**

```sh
claude mcp add sigil -- npx -y @apollyoncorp/sigil-mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and other MCP clients

```json
{
  "mcpServers": {
    "sigil": {
      "command": "npx",
      "args": ["-y", "@apollyoncorp/sigil-mcp"]
    }
  }
}
```

Self-hosting Sigil? Point the links at your own instance:

```json
{ "mcpServers": { "sigil": { "command": "npx", "args": ["-y", "@apollyoncorp/sigil-mcp"], "env": { "SIGIL_URL": "https://sigil.example.org" } } } }
```

Optional: copy `skill/sigil-diagrams/` into your assistant's skills folder (for Claude Code, `~/.claude/skills/`). It teaches layout rules that make diagrams look good.

**Claude Code plugin** (the local server and the skill in one step; see [Plugin](#plugin)):

```text
/plugin marketplace add apollyoncorp/sigil
/plugin install sigil@apollyon
```

## Remote

Nothing to install: Apollyon runs the same server over HTTP at

```text
https://mcp.apollyoncorp.com/mcp
```

Claude Code:

```sh
claude mcp add --transport http sigil https://mcp.apollyoncorp.com/mcp
```

Other clients that speak Streamable HTTP take the same URL (`"type": "http", "url": "https://mcp.apollyoncorp.com/mcp"` in an `.mcp.json`).

**Privacy, plainly.** On the remote server your diagram goes through Apollyon's server: your assistant sends the shapes, the server draws them and answers with the JSON and an `open_url`. It does not store the diagram and it does not log its content (a log line is the HTTP method, path, status, duration and a salted hash of your IP). It calls no LLM. What it does save is described in [What is saved](#what-is-saved): only counters and a hash of your IP, never the IP itself. It still is a server you do not control, so if the diagram must not pass through any server, use the local one (`npx`, above): that one never touches the network.

**Differences from local.**

- No diagram is written to disk. The `path` parameter is refused with an error; use the returned JSON (save it as `name.excalidraw`) or `open_url`.
- Free fair use, with limits per client IP: 30 requests per minute and 500 per day, plus a ceiling on the whole server. Over the limit you get `429` with a `Retry-After` header. The limits are kept on disk, so a restart or a redeploy does not reset them. A request body is capped at 1 MB and a request at 30 s.
- Stateless: no sessions, no accounts, no keys. `GET /healthz` is a health check (it also reports `"store":"ok"` or `"error"`); `GET /stats` exists only when the operator sets a token (below); every other route is 404.

### What is saved

The remote server keeps one SQLite file (`sigil-mcp.db`, WAL mode) in `SIGIL_MCP_DATA_DIR`. It holds:

- **A salt**, random, made once and kept in that file. The IP of a request is never written: only `HMAC-SHA256(salt, IP)` is (an IPv6 address counts as its /64). Without the file the hash cannot be turned back into an address.
- **Rate-limit counters** per hashed client: requests in the current minute window and in the current UTC day, plus the same for the whole server. Minute counters are dropped after 10 minutes, per-client day rows after 2 days.
- **Usage aggregates** per UTC day and tool (`create_diagram`, `mermaid_to_diagram`, `describe_format`, and `other` for everything else, like `tools/list`): how many calls, how many were answered `429`, how many failed, and how many distinct clients (a number: the hashes themselves go after 2 days). Kept for 90 days.

Never saved: the diagram or anything sent in the request, the IP address, headers, or timestamps finer than the day. A log line still has the HTTP method, path, status, duration and a short hash of the IP.

The windows are fixed: a minute is the wall-clock minute (UTC) and the day resets at 00:00 UTC, so a client can send up to twice the per-minute limit across a minute boundary. If the file cannot be written (disk full, file locked) the server answers `503` instead of serving without a limit, and logs the error class only.

**Volume.** Mount a persistent volume at the data folder, or a redeploy starts from empty counters and a new salt. The Docker image uses `/data` (`VOLUME /data`, owned by the `node` user): in Coolify add a Persistent Storage mounted at `/data`. Without Docker the default folder is `~/.sigil-mcp`. Needs Node 24 or later (`node:sqlite` is built in); stdio mode never loads it and runs on Node 20.

**`GET /stats`.** Set `SIGIL_MCP_STATS_TOKEN` (16 characters or more) and call it with `Authorization: Bearer <token>` to get the daily aggregates of the last 30 days as JSON (`days[]` with `distinct_ips` and, per tool, `calls`, `rate_limited`, `errors`, plus totals). Without a token the route is a `404`; a wrong or missing token is a `401`.

```sh
curl -H "Authorization: Bearer $SIGIL_MCP_STATS_TOKEN" https://mcp.apollyoncorp.com/stats   # Cloudflare adds the origin header
```

**Run your own remote server** (self-hosting): the same bundle serves HTTP when started with `--http` or `SIGIL_MCP_HTTP=1`.

```sh
npx -y @apollyoncorp/sigil-mcp --http          # listens on PORT (default 8080), POST /mcp
docker build -f sigil-mcp/Dockerfile.remote -t sigil-mcp-remote .   # from the repo root
docker run -v sigil-mcp-data:/data -p 8080:8080 sigil-mcp-remote    # keep /data on a volume
```

| env | default | what |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | where it listens |
| `SIGIL_MCP_RATE_PER_MINUTE` | `30` | per client IP (also the burst size) |
| `SIGIL_MCP_RATE_PER_DAY` | `500` | per client IP |
| `SIGIL_MCP_RATE_GLOBAL_PER_MINUTE` | `600` | all clients together |
| `SIGIL_MCP_MAX_BODY_BYTES` | `1048576` | request body cap (413 above) |
| `SIGIL_MCP_REQUEST_TIMEOUT_MS` | `30000` | per request (504 above) |
| `SIGIL_MCP_MAX_IN_FLIGHT` | `16` | requests handled at once (503 above) |
| `SIGIL_MCP_TRUST_CF_HEADER` | `1` | read the client IP from `CF-Connecting-IP` and refuse (`403`) a `/mcp` request without a valid one; set `0` when not behind Cloudflare (then the socket address is used) |
| `SIGIL_MCP_ORIGIN_SECRET` | unset | when set, `/mcp` and `/stats` need the header `X-Sigil-Origin-Auth: <secret>` or answer `403` (`/healthz` stays open) |
| `SIGIL_MCP_DATA_DIR` | `~/.sigil-mcp` (`/data` in the Docker image) | folder of the SQLite file: counters, salt, usage |
| `SIGIL_MCP_STATS_TOKEN` | unset | Bearer token (16+ characters) for `GET /stats`; unset means 404 |
| `SIGIL_URL` | `https://sigil.apollyoncorp.com` | where `open_url` points |

**Who can reach it, and why.** The limits are per client IP, so the server has to trust where the IP comes from.

- Behind Cloudflare (the default, `SIGIL_MCP_TRUST_CF_HEADER=1`) the client IP is `CF-Connecting-IP`, and a `/mcp` request without a single valid address in it is refused with `403`. It never falls back to the socket address: behind a proxy that is the proxy's own address (everyone in one bucket), and a request that did not come through Cloudflare could be anyone. `X-Forwarded-For` is never read (anyone can write it, and a reverse proxy rewrites it). Cloudflare refuses a client that sends `CF-Connecting-IP` itself, so through the edge the header cannot be forged.
- But a machine on the same network as the server (a LAN, a tailnet) can reach the reverse proxy directly and write `CF-Connecting-IP` as it likes, to dodge or poison the limits. That is what `SIGIL_MCP_ORIGIN_SECRET` is for: set a long random secret, and have Cloudflare add `X-Sigil-Origin-Auth: <secret>` to every request for the hostname (a Transform Rule, modify request header, on that host only). `/mcp` and `/stats` then answer `403` to anything without it, compared in constant time. Someone on the LAN does not have the secret. Without the variable nothing changes. The secret and the IP are never logged.
- Not behind Cloudflare: set `SIGIL_MCP_TRUST_CF_HEADER=0`. The client IP is then the socket address and `CF-Connecting-IP` is ignored.

IPv6 clients are counted per /64. Counters live in the SQLite file (see above); only the cap on simultaneous requests (`SIGIL_MCP_MAX_IN_FLIGHT`) is per process. Keep the port off the public internet (a Tunnel, no published port). No CORS headers are sent (MCP clients are not web pages, and a browser page therefore cannot use the endpoint); responses carry `X-Content-Type-Options: nosniff`.

## Plugin

`sigil-mcp/` is itself a Claude Code plugin (`.claude-plugin/plugin.json`): it bundles the local MCP server (`npx -y @apollyoncorp/sigil-mcp`) and the `sigil-diagrams` skill (the manifest points at `skill/`, so there is one copy of the skill). The repo root has the marketplace file `.claude-plugin/marketplace.json`:

```text
/plugin marketplace add apollyoncorp/sigil
/plugin install sigil@apollyon
```

(In a shell: `claude plugin marketplace add apollyoncorp/sigil` and `claude plugin install sigil@apollyon`.) The server appears in `/mcp` as `plugin:sigil:sigil`.

**Use the remote server instead of the local one.** The plugin always declares the local server. To go remote, turn that server off in `/mcp` and add the remote one (`claude mcp add --transport http sigil https://mcp.apollyoncorp.com/mcp`), or skip the plugin and copy `skill/sigil-diagrams/` next to the remote server. Do not keep both on: they expose the same tool names.

## Tools

| tool | what it does |
|---|---|
| `create_diagram` | `{ elements, path? }`. Draws rectangles, ellipses, diamonds, text, lines, frames and arrows attached by id, plus ready-made BPMN and flowchart shapes (`{"shape":"bpmn.task","id":"t1","x":0,"y":0,"label":"Review"}`, pools with `lanes`) joined by flows (`{"flow":"sequence"|"message"|"association","from":"t1","to":"t2"}`), in the same hand-drawn style as Sigil's shape libraries. Writes `path` (must end in `.excalidraw`) or returns the JSON. Replies with `open_url` and a layout report (overlaps, labels that do not fit, unattached arrows, arrows through shapes, and the BPMN rules: message flow inside one pool, sequence flow across pools, element outside every pool, element on a lane boundary). |
| `mermaid_to_diagram` | `{ mermaid, path? }`. Converts flowchart, sequence, class, ER and state Mermaid to an editable diagram, laid out automatically. Same reply. |
| `describe_format` | No input. A short cheat-sheet of the element fields, the BPMN and flowchart shape names, two examples and layout tips. |

`open_url` is left out when the link would be longer than about 200,000 characters; open the file instead (Sigil: menu, Open, or drop it on the canvas).

## Develop

From the Sigil repo (`sigil-mcp/`), with the root dependencies installed:

```sh
yarn install      # this package's dev dependencies
yarn build        # bundles to dist/sigil-mcp.mjs (also regenerates the font metrics)
yarn test         # vitest (includes a check that public/libraries is not stale)
yarn e2e          # SDK client over stdio against dist/
yarn e2e:http     # SDK client over HTTP against dist/ started with --http (SIGIL_MCP_URL=... to test a deployed one)
yarn start:http   # run the remote mode locally on :8080
npm pack          # tarball: one bundled file, no runtime dependencies
```

Release: bump `version` in `package.json`, commit, tag it `sigil-mcp-vX.Y.Z` (the same version) and push the tag. The `sigil-mcp-publish` workflow checks that the tag matches `package.json`, runs build, tests and e2e, and publishes to npm with trusted publishing (no token) and provenance. Run it from the Actions tab with `dry_run` on to rehearse without publishing.

The BPMN and flowchart shapes come from `src/shapes`, the same code that writes the `.excalidrawlib` files Sigil ships (`node scripts/build-libraries.mjs`, or `--check` to see whether the committed files are stale). Rebuilding reproduces them byte for byte.

Text is measured from the real advance widths of Excalifont, Nunito, Lilita One and Cascadia (precomputed from the fonts in `packages/excalidraw/fonts`), so labels are sized as the browser will draw them.

## License

MIT. Copyright (c) 2020 Excalidraw, (c) 2026 Apollyon Corporation (Sigil modifications). See `LICENSE`.
