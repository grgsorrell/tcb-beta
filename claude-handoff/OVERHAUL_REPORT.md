# Sam Overhaul — Execution Report

Branch: `sam-overhaul` (never merged/deployed by this job). One commit per phase.
Source baseline: git HEAD `eea93d0`.

---

## Phase 0 — Recon (read-only)

**0.1 — `sam_engine` distribution** (`SELECT sam_engine, COUNT(*) FROM users GROUP BY sam_engine`):

| sam_engine | users |
|---|---|
| `gemini` | 1 |
| `haiku` | 22 |

→ 22 of 23 users (96%) are on the stale `haiku` default. Since the live chat path always runs
Gemini regardless of this flag, **nearly every user is currently missing the prompt/reference blocks
that are gated to one engine or the other** — exactly the split-brain Phase 1 fixes.

**0.2 — Base system prompt word count** (worker.js 6906–7527): **8,696 words**.

No writes performed in Phase 0.

---
<!-- Phases appended below as completed. -->
