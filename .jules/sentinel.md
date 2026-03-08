## 2024-05-24 - [Command Injection in grep Tool]
**Vulnerability:** Command injection in `grep.ts` tool via `execSync(args.join(" "))`. Unsanitized user inputs (e.g., `pattern`, `glob`) could contain shell metacharacters resulting in arbitrary command execution.
**Learning:** `execSync` executes a string command within a shell environment. Concatenating user input directly into this string makes the application extremely vulnerable. Tools interacting with the host OS must bypass shell interpretation for user arguments.
**Prevention:** Use `execFileSync` instead of `execSync`, passing the executable name as the first argument and an array of arguments as the second. This bypasses the shell and treats arguments as literal strings, mitigating command injection risks.
