# README demo recording script

One 30-second GIF at the top of the README, showing the two differentiators nothing else ships together: **lazy MCP activation** and **approvable semantic rename**. Record once, embed as `assets/demo.gif`.

## Preparation

- A small TypeScript repo with an obviously badly named exported function used across 3+ files (e.g. `doStuff` in `src/api.ts`).
- `omd preset enable context7` beforehand, so one inert server exists in the catalog.
- Fresh `omd` session, window sized 1280×800, light theme off (match the hero's dark tone).
- Rehearse; the take should not include typos or waiting on the model.

## Shot list

| Time   | On screen                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0–4s   | Prompt: “rename doStuff to submitOrder everywhere, and check the context7 docs for the fetch API we use.”                           |
| 4–10s  | `/omd-mcp` output: context7 listed as **inert** — no process, no schemas. Model prepares an activation proposal.                    |
| 10–15s | `proposal_control show`: exact command line, redacted env, source config path. One click approves; server starts.                   |
| 15–24s | `semantic_refactor` proposal: multi-file diff preview (3 files, exact before/after). One approval applies all.                      |
| 24–30s | Post-apply diagnostics come back clean; `git diff --stat` in the terminal confirms the three files. End card: `npm i -g oh-my-dsh`. |

## Recording notes

- macOS: `cmd+shift+5` screen recording → `ffmpeg -i demo.mov -vf "fps=12,scale=1280:-1" -f gif` piped through `gifski --quality 80` (better palette than ffmpeg's default).
- Keep the GIF under 4 MB so the README stays fast; if it lands larger, cut the 0–4s typing shot to a still.
- Embed after the hero image in both READMEs:

  ```md
  <p align="center"><img src="https://raw.githubusercontent.com/amplifthq/oh-my-dsh/main/assets/demo.gif" alt="lazy MCP activation and semantic rename" width="800"></p>
  ```

- Update the GIF whenever either flow's UI changes meaningfully — a stale demo is worse than none.
