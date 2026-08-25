# Codex repository workflow rules

## Communication and confirmation

- Read-only inspection, local validation, and other actions already inside the user's requested scope do not require a conversational confirmation.
- For this repository, commit and push the task's own changes at meaningful, validated boundaries by default, even when the individual request does not repeat that instruction. Do not include unrelated user changes. Do not push when the user says not to, the remote/branch is unsuitable, or a real blocker makes the operation unsafe.
- Treat this standing commit/push authorization as valid for correction commits in the same task. Batch staging, commit, push, and CI start where practical. A platform-enforced approval may still be required, but do not add a separate chat confirmation for the same action.
- Batch related approval-requiring commands into one narrowly scoped request. Do not request approval separately for each file, test, poll, or correction step.
- Do not report every tool call or unchanged CI poll. Report material state changes: a cause was identified, implementation or validation reached a boundary, a new failure requires another correction, or the task completed. For long-running work, send one consolidated update at the minimum required cadence instead of repeating unchanged status.
- A promise such as “next time I will…” is not an acceptable corrective action by itself. When the user identifies a reusable workflow failure and asks for persistence, encode it in the applicable `AGENTS.md`, skill, test, or automation before reporting completion, and name the persisted artifact.

## CI closure

- When push is part of the request, completion is determined by the latest pushed SHA, not by an earlier green commit or local tests alone.
- Monitor the latest workflow through all dependent jobs. A failed or skipped required job reopens the cycle; diagnose, fix, validate, push, and monitor again.
- Do not create an unmonitored documentation-only commit after declaring CI green. If a final record must be committed, that commit becomes the new completion candidate and its CI must also pass.
- Treat cross-OS, filesystem-time, ordering, TTY, and packaging failures as product findings. Make tests deterministic and repeat a formerly flaky test enough times to demonstrate stability.
