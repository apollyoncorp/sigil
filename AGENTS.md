# Sigil (Apollyon fork of Excalidraw)

This repository is **Sigil**, a free, open-source drawing board by Apollyon (https://apollyoncorp.com). It is a fork of [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT). The sections after this one are the upstream guide and still describe the code.

- **Scope.** Apollyon hosts only the single-user editor at `sigil.apollyoncorp.com`. Collaboration, shareable links and the AI backend stay in the code, configurable by environment variables and **off by default**. Anyone self-hosting can turn them on. Excalidraw-only services (their Sentry DSN, Simple Analytics, Excalidraw+, banners, `*.excalidraw.com` hosts) are removed, not just disabled.
- **AI.** Sigil pays for no model. AI support comes from the user's own assistant through `sigil-mcp` and the `sigil-diagrams` skill, which only draw and never call an LLM.
- **Upstream.** `upstream` is `excalidraw/excalidraw` (push disabled), merged in periodically. Keep the brand in `excalidraw-app/` and keep the diff in `packages/` minimal so merges stay cheap. Sigil does not use Crowdin: locale files come from upstream merges, so change Sigil strings in `en.json` only through keys Sigil owns.
- **Compatibility.** Sigil opens and saves `.excalidraw` files.
- **Licenses.** `LICENSE` (MIT, both copyrights) and `NOTICE` (bundled fonts) must stay accurate. Check a font's license before adding or converting one.
- **Toolchain.** Node 24 (same as the `Dockerfile`) and Yarn 1.22.
- **Commits** in English, author `c-Morette`, no co-author trailers. Push, deploy and DNS changes need the owner's explicit approval. UI changes go through an A/B round and the owner's approval before commit.
- **Memory and plan** live outside the repo (Apollyon's private notes), never in `.claude/` here.

---

# Guidelines

- For new DOM/browser API usage, use `app.ownerDocument` and `app.ownerWindow` instead of globals; without `app`, derive them from the mounted node's `ownerDocument` and its `defaultView`.
- When overriding properties of an existing type, prefer `Merge<Base, Overrides>` from `@excalidraw/common/utility-types` over `Omit<Base, keyof Overrides> & Overrides`.

# Crowdin (translations)

Crowdin is the source of truth for `packages/excalidraw/locales/*.json` (except `en.json`). The GitHub integration reads `en.json` from `master` (Crowdin branch `master`, hence `-b master` on every CLI command) and pushes translations to `l10n_master`; edits committed straight to locale files are overwritten on its next sync.

Workflow for changing translations:

1. Check out `l10n_master` and pull. Older locale files would be imported as extra translations and can override translators' newer fixes.
2. Edit the locale JSON files; keep `{{placeholders}}` and tags intact.
3. Upload each edited language: `crowdin upload translations -b master -l <lang> --import-eq-suggestions --preserve-hierarchy`.
   - `--preserve-hierarchy` is required: without it the CLI looks for `en.json` at the root of the Crowdin branch and fails ("Source file … does not exist"), even though `--dryrun` passes.
   - `-l` takes one language (repeated flags keep only the last); without it, every language is uploaded.
   - `--import-eq-suggestions` keeps translations identical to the English source (key names like `Ctrl`, `Tab`, product names); otherwise Crowdin skips them as untranslated.
   - Uploads land as unapproved suggestions. A string with an approved translation keeps exporting the approved one, so changing an approved translation also needs an approval (Crowdin editor, or the API: add the translation, then `POST /approvals`).
4. Sync back: `crowdin download -b master` in the same checkout. The output matches the integration's files byte for byte, so its next sync finds nothing to push.
5. Check `git diff`: the edited files should match your edits exactly (a mismatch means Crowdin still exports another translation). Commit and push to `l10n_master`; CI recomputes `percentages.json`.
