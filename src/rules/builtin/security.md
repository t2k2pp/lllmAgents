# Security Rules
- Never hardcode credentials, API keys, or secrets in code
- Validate all user inputs at system boundaries
- Use parameterized queries for database operations
- Avoid command injection (never pass unsanitized input to shell)
- Don't use eval() or similar dynamic code execution
- Check for OWASP Top 10 vulnerabilities in web code
