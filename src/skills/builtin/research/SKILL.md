---
name: research
description: Research workflow. (A) Codebase — "how does this work", "investigate the behavior of X", "read this PR", or scoping impact before a large change. (B) External web — official facts such as cloud pricing, API specs, current model lists. Covers the static-fetch then browser-render ladder for dynamic pages (price tables etc.) and the rule to stop honestly rather than fill gaps from unofficial sources or memory.
---

# Research

## Sources of truth

Knowledge is split across code, design docs, and memory. Check in this order.

| Layer | Location | Yields |
|----|------|------------|
| 1. Code | `src/` | Current implementation and behavior (the only running truth) |
| 2. Design docs | `docs/*.md` | Intended design and the decisions behind it |
| 3. CLAUDE.md / README.md | root | User-facing description / work rules |
| 4. git log / blame | `.git` | History and intent of changes |
| 5. Persistent memory | `~/.claude/projects/.../memory/` | Facts learned earlier, user preferences |

When a design doc and the code disagree, the code is truth — docs lag the implementation.

## Entry-point docs

| Doc | Use |
|------|------|
| `docs/internal_design.md` | Architecture, modules, data flow (mermaid) |
| `docs/external_design.md` | External spec (REPL commands, tools, config) |
| `docs/config-reference.md` | Every config key |
| `docs/llm-profiles.md` | LLM profile mechanism |
| `docs/model-registry.md` | Model list management |
| `docs/workspace-separation.md` | src/dist/deploy/sandbox roles |
| `docs/<feature>-design.md` | One per feature |

Run `ls docs/ | sort`, pick 1-2 candidates, read them.

## Procedure

### Step 1: Read broadly before forming a hypothesis

1. `glob "src/**/*.ts"` to map relevant directories
2. `grep -r "<keyword>" src/ --include="*.ts" -l` for candidate files
3. Check for a matching design doc: `ls docs/ | grep -i <keyword>`
4. Narrow to 3-5 files, then read them fully

### Step 2: Verify, don't speculate

After forming a hypothesis, confirm it:

```bash
grep -rn "configKey" src/ --include="*.ts"
grep -rn "functionName(" src/ --include="*.ts"
git log -p --all -S "identifier" -- src/ | head -50
git blame src/path/to/file.ts | head -30
```

### Step 3: External info → web_search / web_fetch

Library specs (vitest, anthropic SDK, playwright) → web_search then web_fetch. For official numbers (pricing, API specs), follow §External web research.

## External web research

For official, current facts: cloud pricing, model lists, API specs. Priority is accuracy over appearance. Never present an unretrieved value as if it were retrieved.

### Primary path

1. `web_search` to locate the official domain
2. `web_fetch(url, prompt)` to extract the needed value

### Detect a failed fetch (dynamic page)

`web_fetch` converts static HTML to text and runs no JavaScript. Values rendered by JS (price tables) are absent; only the page shell returns. Treat the fetch as failed when:

- The body is long but the target number (unit price) appears zero times
- Every `$` is a currency selector or an unrelated amount
- Content is mostly navigation and footer link text

### Technique: render with the browser

The `browser_*` tools run real Chromium, so JS executes. State this path in the report: the static fetch returned no value, so the page was rendered.

1. `browser_navigate(url)`
2. For a value behind an anchor: `browser_navigate(url + "#anchor")` or `browser_click("a[href=\"#anchor\"]")`
3. `browser_snapshot()` to read the rendered DOM
4. If the target is still absent: find its section selector from the snapshot tree, `browser_click` to expand, snapshot again. Last resort: `browser_screenshot(path)` then `vision_analyze(path, prompt)`

### When the value stays unreachable

- Stop and report that the value could not be retrieved
- Do not fill it from unofficial articles or third-party blogs
- Do not answer pricing from memory
- Report: (1) the primary path tried (2) the technique tried and why it failed (3) the official URL the user can check

## Documenting results (on request)

| Kind | Location |
|------|------|
| New-feature design | `docs/<feature>-design.md` |
| One-off note / verification log | `sandbox/<topic>-YYYY-MM-DD.md` |
| Past review / retrospective | `sandbox/` or PR comment |
| Shareable result for the user | in conversation, plus `docs/` if needed |

## Report format

Reply to the user in Japanese. Template:

```
## 調査対象と目的
<what was investigated, and why>

## 発見した事実
- src/foo/bar.ts:42 — XXX が定義されている
- docs/foo-design.md §3 — 設計意図は YYY
- git log によれば 2026-03-15 の commit abc1234 で導入

## 結論と推奨
<direct answer to the user's question>

## 推測と事実の区別
- 事実: code / design doc / git log で確認したもの
- 推測: <unconfirmed hypotheses, marked explicitly — never blur with「おそらく」>

## 不明点・追加調査候補
<if any remain>
```

## Don't

- State a guess as fact — mark anything unconfirmed as such
- Conclude from design docs without reading code — docs can be stale
- Conclude from a single grep — the same concept may use snake_case, camelCase, or a Japanese name; try 2-3 patterns
- Trust stale memory — memory is a past snapshot; if it conflicts with current code, trust the code and update memory
- Fill an unretrievable official value (especially cloud pricing) from unofficial sources or memory — stop and report instead (see §External web research)

## Related skills

- `/code-review` — to turn findings into quality feedback
- `/refactoring` — to act on findings (impact analysis is also its core step)
- `/claude-code-driver` — to delegate scope too large to read alone
