# Sigil (Apollyon fork of Excalidraw)

This repository is **Sigil**, a free, open-source drawing board by Apollyon (https://apollyoncorp.com). It is a fork of [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT). The sections after this one are the upstream guide and still describe the code.

- **Scope.** Apollyon hosts only the single-user editor at `sigil.apollyoncorp.com`. Collaboration, shareable links and the AI backend stay in the code, configurable by environment variables and **off by default**. Anyone self-hosting can turn them on. Excalidraw-only services (their Sentry DSN, Simple Analytics, Excalidraw+, banners, `*.excalidraw.com` hosts) are removed, not just disabled.
- **AI.** Sigil pays for no model. AI support comes from the user's own assistant through `sigil-mcp` and the `sigil-diagrams` skill, which only draw and never call an LLM.
- **Upstream.** `upstream` is `excalidraw/excalidraw` (push disabled), merged in periodically. Keep the brand in `excalidraw-app/` and keep the diff in `packages/` minimal so merges stay cheap. Sigil does not use Crowdin: locale files come from upstream merges, so change Sigil strings in `en.json` only through keys Sigil owns.
- **Compatibility.** Sigil saves `.sigil` files by default (same JSON as `.excalidraw`, so renaming works both ways), opens `.sigil` and `.excalidraw`, and offers "Save as .excalidraw" in the export dialog. The extension lives in `SIGIL_FILE_EXTENSION` (`packages/common/src/constants.ts`).
- **Licenses.** `LICENSE` (MIT, both copyrights) and `NOTICE` (bundled fonts) must stay accurate. Check a font's license before adding or converting one.
- **Toolchain.** Node 24 (same as the `Dockerfile`) and Yarn 1.22.
- **Commits** in English, author `c-Morette`, no co-author trailers. Push, deploy and DNS changes need the owner's explicit approval. UI changes go through an A/B round and the owner's approval before commit.
- **Memory and plan** live outside the repo (Apollyon's private notes), never in `.claude/` here.

---

# CLAUDE.md

## Project Structure

Excalidraw is a **monorepo** with a clear separation between the core library and the application:

- **`packages/excalidraw/`** - Main React component library published to npm as `@excalidraw/excalidraw`
- **`excalidraw-app/`** - Full-featured web application (excalidraw.com) that uses the library
- **`packages/`** - Core packages: `@excalidraw/common`, `@excalidraw/element`, `@excalidraw/math`, `@excalidraw/utils`
- **`examples/`** - Integration examples (NextJS, browser script)

## Development Workflow

1. **Package Development**: Work in `packages/*` for editor features
2. **App Development**: Work in `excalidraw-app/` for app-specific features
3. **Testing**: Always run `yarn test:update` before committing
4. **Type Safety**: Use `yarn test:typecheck` to verify TypeScript

## Development Commands

```bash
yarn test:typecheck  # TypeScript type checking
yarn test:update     # Run all tests (with snapshot updates)
yarn fix             # Auto-fix formatting and linting issues
```

## Architecture Notes

### Package System

- Uses Yarn workspaces for monorepo management
- Internal packages use path aliases (see `vitest.config.mts`)
- Build system uses esbuild for packages, Vite for the app
- TypeScript throughout with strict configuration
