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
- [x] **Cut 0.10.0-alpha** — tagged and released 2026-10-02 with the DMG; npm 0.10.0-alpha published the same day.
- [x] **Surface the agent's real error** — since 0.9.4 the child's stderr tail rides with a failed
      result and the panel shows it after "ended:".
- [x] **Local API auth** *(2026-09-29, unreleased)* — a token per launch in the URL fragment, required
      in `x-fethr-token` on every `/api` call; foreign Origin refused first. `test/server.test.js`
      covers no token, wrong token, foreign origin, own origin. Version bumped to 0.10.0-alpha.
- [ ] **`.fethr/chat.json` leaks into repos** that have no ignore rule. Write a `.fethr/.gitignore`
      containing `*` on first save.

## Next

- [x] **Windows installer** *(2026-10-02, unreleased)* — `build-windows.yml` builds the NSIS
      installer and smoke-tests it on a Windows runner (install, launch, node found, page 200, `/api`
      401 without token, clean exit on force-kill). CI also runs the node tests on Windows.
- [ ] **Agent panel on a real Windows machine.** No runner has a Claude Code login. One person, one
      prompt: does `claude.exe` get found and does a reply arrive.
- [ ] **Linux installer.** Same shape as Windows: `find_node()` already checks `/usr/bin/node` and
      PATH; needs a runner job with the WebKitGTK 4.1 packages and a smoke test.
- [ ] **Windows code signing.** The installer is unsigned, so SmartScreen warns. Same identity
      question as macOS below.
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
