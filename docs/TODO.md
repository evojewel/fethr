# fethr — TODO

**Date:** 2026-09-20
**Status:** Live. This is the single tracker; `CHANGELOG.md` says what shipped, `ARCHITECTURE.md` says why.
**Scope:** Every open item in the repo, in one place. If it is in a release note and not here, here is wrong.
**Last-verified:** 2026-09-20 against `src/`, `web/`, `src-tauri/`, npm and GitHub releases.

> A version number rises when a risk is retired, not when features accumulate.
> The alpha ends when the local API is authenticated and the agent's error text
> reaches the user. Everything else is a feature.

## Now

- [x] **Publish to npm** — 0.9.4-alpha published 2026-09-29 by the owner after `npm login` (the
      old token was dead; an unauthenticated PUT reads as E404). The registry took ~20 min to serve
      it. `version.json` npm line moved. Still no `NPM_TOKEN` secret, so each publish needs a login.
- [x] **Cut 0.10.0-alpha** — tagged and released 2026-10-02 with the DMG; npm publish pending the owner's login.
- [x] **Surface the agent's real error** — since 0.9.4 the child's stderr tail rides with a failed
      result and the panel shows it after "ended:".
- [x] **Local API auth** *(2026-09-29, unreleased)* — a token per launch in the URL fragment, required
      in `x-fethr-token` on every `/api` call; foreign Origin refused first. `test/server.test.js`
      covers no token, wrong token, foreign origin, own origin. Version bumped to 0.10.0-alpha.
- [ ] **`.fethr/chat.json` leaks into repos** that have no ignore rule. Write a `.fethr/.gitignore`
      containing `*` on first save.

## Next

- [ ] **Windows and Linux installers.** `bundle.targets` is already `all`; the blocker is
      `find_node()` in `src-tauri/src/lib.rs`, which only knows Homebrew and nvm paths. Add
      `/usr/bin/node`, `%ProgramFiles%\nodejs\node.exe` and nvm-windows, then a matrix job like the
      one in skript's CI (WebKitGTK 4.1 apt list for the Linux runner).
- [ ] **Signing identity.** The DMG is ad-hoc signed and not notarized, so macOS blocks the first
      launch. Notarizing needs a Developer ID: an individual enrolment prints the person's legal name
      in the signature, an organisation prints the company. Decide whose, then `build-shell.yml` gets
      `codesign` + `notarytool`. Tauri's updater, if wanted later, is minisign and carries no identity.
- [ ] **Voice input in the native app** is untested (WebKit view; verified only in Chromium).
- [ ] **A real Tauri CSP is set but unexercised:** the native window loads `http://127.0.0.1`, so the
      header the server sends is the one that applies. Confirm in the app with the web inspector.

## Release checklist

1. `npm test && npm run build && npm run test:ui` green, CI green on `main`.
2. Bump `package.json` and `src-tauri/tauri.conf.json`, add the `CHANGELOG.md` entry, tag `vX.Y.Z-alpha`.
3. `gh release create`, then run `build-shell.yml` for the tag; verify the DMG asset exists.
4. Publish npm (`publish-npm.yml` or by hand); verify `npm view @evojewel/fethr dist-tags`.
5. **Last:** update `version.json` (`app`, `npm`, `download`) and the DMG link plus version in
   `index.html`, then push `main`. The page and the manifest go live together; bumping the manifest
   before the assets exist sends every app to a 404.

## Not doing

| Item | Why |
|---|---|
| Usage telemetry | The editor's promise is one network call on its own, the daily version check. Counts would be a second, and the page would have to say so. |
| A Swift/WKWebView shell beside Tauri | One shell has agent parity; a second buys a parity checklist, not users. |
| Bundling the `claude` binary | 300 MB for something the user already has. `stage-sidecar.sh` guards against it. |
| Extension platform | The founding thesis. Language smarts arrive by LSP when they arrive. |
