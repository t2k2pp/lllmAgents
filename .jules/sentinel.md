## 2026-03-11 - Command Injection in Tool Definition

**Vulnerability:** Command injection vulnerability in `src/tools/definitions/grep.ts` due to the use of `execSync` with unsanitized user arguments constructed via `args.join(" ")`.

**Learning:** When passing user-provided input (like `pattern` and `path`) to a shell command, combining arguments with `join(" ")` allows attackers to inject arbitrary shell commands if `execSync` executes the command within a shell environment or parses the string as a shell command. Even if `rg` is the intended command, malicious input could break out of the intended argument list.

**Prevention:** Always use `execFileSync` or `spawn` without a shell context when executing system commands to prevent command injection vulnerabilities. Pass the command and an array of arguments separately, e.g., `execFileSync(args[0], args.slice(1))`. This ensures that each element is passed exactly as one argument to the executable, avoiding shell interpretation.
