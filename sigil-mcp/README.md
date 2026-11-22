# sigil-mcp

An [MCP](https://modelcontextprotocol.io) server that lets your own AI assistant (Claude, Codex, Cursor, ...) draw diagrams for [Sigil](https://sigil.apollyoncorp.com), Apollyon's free drawing board (a fork of Excalidraw).

**Privacy.** sigil-mcp only draws. It never calls an LLM and never makes a network request. Your assistant sends it shapes, it writes a `.excalidraw` file on your disk and builds a link; that is all. The link carries the diagram inside it (`https://sigil.apollyoncorp.com/#data=...`): the part after `#` is never sent to any server, and Sigil reads it in your browser.

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

## Tools

| tool | what it does |
|---|---|
| `create_diagram` | `{ elements, path? }`. Draws rectangles, ellipses, diamonds, text, lines, frames and arrows attached by id. Writes `path` (must end in `.excalidraw`) or returns the JSON. Replies with `open_url` and a layout report (overlaps, labels that do not fit, unattached arrows, arrows through shapes). |
| `mermaid_to_diagram` | `{ mermaid, path? }`. Converts flowchart, sequence, class, ER and state Mermaid to an editable diagram, laid out automatically. Same reply. |
| `describe_format` | No input. A short cheat-sheet of the element fields, an example and layout tips. |

`open_url` is left out when the link would be longer than about 200,000 characters; open the file instead (Sigil: menu, Open, or drop it on the canvas).

## Develop

From the Sigil repo (`sigil-mcp/`), with the root dependencies installed:

```sh
yarn install      # this package's dev dependencies
yarn build        # bundles to dist/sigil-mcp.mjs (also regenerates the font metrics)
yarn test         # vitest
yarn e2e          # SDK client over stdio against dist/
npm pack          # tarball: one bundled file, no runtime dependencies
```

Text is measured from the real advance widths of Excalifont, Nunito, Lilita One and Cascadia (precomputed from the fonts in `packages/excalidraw/fonts`), so labels are sized as the browser will draw them.

## License

MIT. Copyright (c) 2020 Excalidraw, (c) 2026 Apollyon Corporation (Sigil modifications). See `LICENSE`.
