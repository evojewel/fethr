# fethr

**A featherweight code editor with first-class agent integration.**

> Status: **pre-alpha, under construction.** This package currently reserves the name and
> ships a placeholder CLI. There is no editor to run yet.

## The idea

Editors got heavy; agents got good. fethr starts from the opposite corner: a minimal, fast
editor shell where an AI coding agent (designed around [Claude Code](https://claude.com/claude-code)'s
front-end/runtime split — fethr is an independent project, unaffiliated with Anthropic) is
the first-class citizen rather than a bolted-on extension — a context pipe in, a renderer
out, and as little between you and the buffer as possible.

Principles, subject to change while we build:

- **Featherweight is the feature.** Startup, memory, and input latency are budgets, not wishes.
- **The agent is a peer process, not a plugin.** The editor forwards context (selection,
  files, project) and renders results (streams, diffs); intelligence lives in the agent runtime.
- **No extension platform.** Language smarts via LSP, syntax via tree-sitter, agent via its
  own protocol. The moat we skip is the weight we skip.

## Try the placeholder

```bash
npx fethr
```

## License

MIT — see [LICENSE](LICENSE).
