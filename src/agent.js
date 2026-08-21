// fethr agent panel backend — Claude Agent SDK as a peer process.
//
// Safety model (same tier-thinking as the rest of fethr):
//   - The agent can READ the workspace (Read/Grep/Glob, cwd-confined).
//   - It can NEVER write: every mutating built-in tool is disallowed.
//   - The only path to a change is propose_edit, which records a proposal
//     for the writer to review; the UI applies accepted proposals as
//     editor changes, and the writer saves. The agent never touches disk.
//
// Auth: the Agent SDK uses the machine's existing Claude Code login.

// Test comment added via the agent panel's propose_edit flow.
// Second test comment, same flow.

import path from "node:path";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const RULES = `
You are the agent panel inside fethr, a featherweight code editor.
The user is editing a project; their prompt may include the current file and selection.
You may read the workspace with Read/Grep/Glob.
You can NEVER modify files directly. To change a file, call the propose_edit tool with
the COMPLETE new content of that file — the writer reviews a diff and decides.
One proposal per file per reply. Keep answers short and concrete; this is a side panel,
not a chat site.`;

export function handleAgent(root, req, res) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c) => {
    body += c;
    if (body.length > 1024 * 1024) req.destroy();
  });
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad json" }));
    }
    run(root, parsed, req, res).catch((e) => {
      try {
        emit(res, { type: "error", message: String(e.message || e) });
        res.end();
      } catch { /* stream already gone */ }
    });
  });
}

function emit(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// Agent SDK model aliases pass straight through; "fable" isn't a standard
// alias so it's mapped to the full model ID. Availability isn't detected
// ahead of time — the panel shows it optimistically and folds gracefully
// on the first failure (see markFableUnavailable in web/editor.js).
const MODEL_MAP = { opus: "opus", sonnet: "sonnet", haiku: "haiku", fable: "claude-fable-5" };

async function run(root, { prompt, sessionId, context, model }, req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  const fethrServer = createSdkMcpServer({
    name: "fethr",
    tools: [
      tool(
        "propose_edit",
        "Propose replacing one file's content. The writer reviews the diff and accepts or rejects; nothing is written to disk by this tool.",
        {
          path: z.string().describe("Workspace-relative path of the file"),
          new_content: z.string().describe("The complete proposed content of the file"),
          note: z.string().optional().describe("One line on what changed and why"),
        },
        async ({ path: rel, new_content, note }) => {
          const abs = path.resolve(root, rel);
          if (abs !== root && !abs.startsWith(root + path.sep)) {
            return { content: [{ type: "text", text: "Rejected: path escapes the workspace." }] };
          }
          emit(res, { type: "proposal", path: rel, content: new_content, note: note || "" });
          return {
            content: [{ type: "text", text: `Proposal for ${rel} shown to the writer for review.` }],
          };
        }
      ),
    ],
  });

  let fullPrompt = prompt;
  if (context && context.path) {
    fullPrompt += `\n\n<current_file path="${context.path}">\n${context.content ?? ""}\n</current_file>`;
    if (context.selection) fullPrompt += `\n<selection>\n${context.selection}\n</selection>`;
  }

  const q = query({
    prompt: fullPrompt,
    options: {
      cwd: root,
      systemPrompt: { type: "preset", preset: "claude_code", append: RULES },
      mcpServers: { fethr: fethrServer },
      allowedTools: ["Read", "Grep", "Glob", "mcp__fethr__propose_edit"],
      disallowedTools: [
        "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash",
        "WebFetch", "WebSearch", "Task", "TodoWrite", "KillShell", "BashOutput",
      ],
      includePartialMessages: true,
      ...(sessionId ? { resume: sessionId } : {}),
      ...(model && MODEL_MAP[model] ? { model: MODEL_MAP[model] } : {}),
    },
  });

  req.on("close", () => {
    if (typeof q.interrupt === "function") q.interrupt().catch(() => {});
  });

  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") {
      emit(res, { type: "session", id: msg.session_id });
    } else if (msg.type === "stream_event") {
      const ev = msg.event || {};
      const d = ev.delta;
      if (d && d.type === "text_delta") emit(res, { type: "delta", text: d.text });
      else if (d && d.type === "thinking_delta" && d.thinking) {
        emit(res, { type: "thinking", text: d.thinking });
      } else if (ev.type === "content_block_start" && ev.content_block) {
        if (ev.content_block.type === "thinking") emit(res, { type: "phase", phase: "thinking" });
        else if (ev.content_block.type === "text") emit(res, { type: "phase", phase: "writing" });
      }
    } else if (msg.type === "assistant") {
      const blocks = (msg.message && msg.message.content) || msg.content || [];
      for (const b of blocks) {
        if (b.type === "tool_use") {
          const i = b.input || {};
          const detail =
            i.file_path || i.path || i.pattern || i.query ||
            (typeof i.command === "string" ? i.command.slice(0, 60) : "") || "";
          emit(res, { type: "tool", name: b.name.replace(/^mcp__fethr__/, ""), detail });
        }
      }
    } else if (msg.type === "result") {
      emit(res, {
        type: "done",
        ok: msg.subtype === "success",
        error: msg.subtype === "success" ? undefined : msg.subtype,
      });
    }
  }
  res.end();
}
