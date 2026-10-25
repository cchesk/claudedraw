---
name: model-routing
description: Token-efficient model routing. Use for any non-trivial coding task (features, refactors, multi-file bug fixes): delegates planning to Opus and implementation to Sonnet, escalating to Opus only for very complex work.
---

# Model routing

The main session runs on Sonnet. Spend Opus tokens only where reasoning quality matters most.

## Decide first

- **Trivial** (typo, one-line fix, a question, a small single-file edit, reading/explaining code): do it yourself directly. No delegation.
- **Non-trivial** (multi-file change, new feature, refactor, unclear bug, design choice): follow the workflow below.

## Workflow

1. **Plan** – spawn the `planner` subagent (Opus) with the task, relevant file paths and constraints. Don't pre-explore the whole repo yourself; give it a clear brief and let it explore. Skip this step if the approach is already obvious.
2. **Review the plan** briefly. If it is unclear or contradicts the user's request, fix that yourself or ask the user.
3. **Implement** – spawn the `coder` subagent (Sonnet) with the plan step(s) it should execute. Launch independent steps in parallel; give each subagent only the context it needs.
4. **Escalate only when warranted** – use `senior-coder` (Opus) only for steps the plan marks `hard`, or when `coder` has failed the same step twice. Never use it for routine work.
5. **Verify** – check the reports, run tests/linters, and summarize the result to the user concisely.

## Token-saving rules

- Subagent prompts: state the goal, exact files, and acceptance criteria. Don't paste large files; let them read what they need.
- Ask subagents for short reports; don't have them echo code back.
- Do not re-plan with Opus for follow-up tweaks; handle small follow-ups with `coder` or directly.
- Never run Opus for searching, formatting, boilerplate, test writing, or docs.
