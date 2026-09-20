# fethr — TODO

**Date:** 2026-09-20
**Status:** Live. This is the single tracker; `CHANGELOG.md` says what shipped, `ARCHITECTURE.md` says why.
**Scope:** Every open item in the repo, in one place. If it is in a release note and not here, here is wrong.
**Last-verified:** 2026-09-20 against `src/`, `web/`, `src-tauri/`, npm and GitHub releases.

> A version number rises when a risk is retired, not when features accumulate.
> The alpha ends when the local API is authenticated and the agent's error text
> reaches the user. Everything else is a feature.

## Now

- [ ] **Publish 0.9.3+ to npm.** The `alpha` dist-tag was still 0.9.2 on 2026-09-20, so `npx`
      users lack the XSS, replay-on-restore and autosave-boundary fixes of v0.9.3. Needs the owner's
      OTP or `NPM_TOKEN` for `publish-npm.yml`. Then bump `npm` in `version.json`.
- [ ] **Surface the agent's real error.** A 400 from the API ("Claude Code 2.1.236 does not support
      this model") reaches the panel as "process exited with code 1". Read the child's stderr and show
      the last line. Found 2026-09-18 with an outdated Homebrew `claude`.
- [ ] **Local API auth.** Any page on the machine can call `127.0.0.1:<port>/api/*`: no token, no
      Origin check. Tracked since v0.9.3. Mint a token per launch, put it in the page URL, require
      it on `/api/*`.
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
