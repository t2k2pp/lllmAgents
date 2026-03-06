## 2024-05-15 - [CRITICAL] Command Injection via `execSync`

**Vulnerability:** The `grep` tool (`src/tools/definitions/grep.ts`) used `execSync` to run `rg` with user inputs directly concatenated into a string using `args.join(" ")`. This pattern is highly susceptible to command injection if malicious characters (like `;` or `|`) are passed in `pattern` or `path`.

**Learning:** When using `child_process` methods, executing a command via a shell environment (`exec`, `execSync`, or `spawn` with `shell: true`) introduces command injection risks when any part of the command string incorporates unvalidated user input.

**Prevention:** Always use functions that bypass the shell, such as `execFile`, `execFileSync`, or `spawn` (with `shell: false`). Pass arguments safely as a separate array of strings to prevent the underlying OS from interpreting shell metacharacters.
