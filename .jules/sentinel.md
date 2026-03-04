## 2025-03-04 - Command Injection in Grep Tool
**Vulnerability:** The `grep` tool constructed a shell command by joining an array of arguments and passing it to `execSync`. A malicious or improperly sanitized `glob` or `path` input could inject arbitrary shell commands.
**Learning:** Using `execSync` with a joined array of arguments allows shell metacharacters to execute code. This happens even if the initial intent was to run a single binary like `rg`.
**Prevention:** Always use `execFileSync` (or `spawnSync`) instead of `execSync` when running external binaries with user-controlled arguments, ensuring the shell does not evaluate them.
