# Safe mode design

Status: implemented

## 1. Purpose

`localllm --safe-mode` starts a temporary troubleshooting session without loading user- or
project-provided customizations. It gives users a known-good path when an instruction file,
skill, plugin, hook, MCP server, custom agent, rule, or auto memory prevents normal startup or
changes agent behavior unexpectedly.

Safe mode is an invocation-only diagnostic boundary. It never rewrites or deletes configuration.

## 2. Startup contract

Safe mode disables all of the following before any customization is parsed or executed:

- explicit plugin bundles, including plugin skills, agents, hooks, and MCP sources;
- user/project skills;
- project and user hooks;
- user/project MCP servers;
- project instruction files (`AGENTS.md`, `CLAUDE.md`, `LOCALLLM.md`, and compatible paths);
- persistent auto memory;
- user/project custom agents;
- user/project rules.

The following remain available so the application can still diagnose and repair itself:

- authentication, configured model selection, and model connection settings;
- built-in tools, built-in agents, and built-in safety/coding rules;
- permission checks and OS sandboxing;
- session storage, logging, `/doctor`, and normal CLI commands.

`--safe-mode` takes precedence over `--plugin-dir`, MCP/skill enablement in config, and input
compression. Ignored customizations are not validated, connected, or executed. This is essential:
a broken plugin path or hook must not prevent the recovery session from starting.

## 3. Implementation boundary

`src/cli/startup-mode.ts` is the single source of truth for the customization policy. Startup
consumers use that policy instead of independently interpreting the flag.

- `src/index.ts` skips plugin discovery and disables skills/MCP/hooks.
- `MCPManager` locks MCP off for the lifetime of the process; `/mcp on`, reload, and per-server
  enable operations cannot escape the startup policy or persist a contradictory setting.
- `AgentDefinitionLoader` limits discovery to built-in definitions.
- `AgentLoop` rebuilds every system prompt with project instructions and memory empty, and asks
  `RuleLoader` for built-in rules only. Resume, model changes, Room swaps, and input-compression
  toggles must preserve this invariant.

## 4. Security and compatibility

- Safe mode is more restrictive than a normal session and does not weaken permissions.
- Existing invocations are unchanged when the flag is absent.
- Built-in safety rules remain active.
- No customization file is modified, quarantined, or deleted.
- The welcome output states that safe mode is active so a reduced capability set is not mistaken
  for normal configuration loss.

## 5. Verification

Regression tests cover the centralized policy, plugin/MCP/skill/hook startup decisions, built-in
agent and rule retention, system-prompt exclusion across rebuild paths, and the packaged CLI flag.
The full unit, E2E, lint/typecheck, build, deploy, and cross-OS CI gates remain required.
