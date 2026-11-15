---
name: code-review
description: Reviews code against AGENTS.md rules and the active brief's acceptance criteria. Use when asked to review code, branches, or pull requests.
---

# Morning Pages Code Review Checklist

1. **Inspect Changes**: Run `git status` and `git diff` (or `git diff main...HEAD`) to view all modified and new files.
2. **Security & Privacy (AGENTS.md Rules 1–6)**:
   - Verify no plaintext journal content or raw tokens are logged (`pino` redaction must be present).
   - Verify AES-256-GCM encryption is used before storing entries/summaries.
   - Verify dates use `users.timezone` (IANA), never server UTC alone.
3. **Validation & Types**: Ensure TypeScript strict mode has no `any` leaks and every API endpoint validates inputs with Zod.
4. **Acceptance Criteria**: Check every bullet under the brief's Acceptance Criteria and verify automated tests exist and pass.
5. **Report**: List issues grouped by `[Critical]`, `[Warning]`, or `[Pass]`.
