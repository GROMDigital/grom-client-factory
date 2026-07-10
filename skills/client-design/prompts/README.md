# Role prompts (content lands in Plan 3b)

One file per roster role: `prompts/<role-id>.md`. The workflow scripts do not
read these files; they hand each agent a bootstrap prompt containing the
ABSOLUTE path to its prompt file, which the agent Reads first.

Required sections in every prompt file (prompt-lint enforces):

- `# Role` who the agent is and its one-sentence mandate
- `## Inputs` the exact files to Read, in order (registry first for phase 3+)
- `## Deliverable` the exact output file path pattern and required doc sections
- `## Claims` reminder + shape of the claims sidecar it must write to
  `build/<runDate>/claims/<doc>.json` ({"defines": {...}, "references": {...}})
- `## Boundaries` role-specific rules on top of baseline/guardrails.md

Every prompt must also instruct: read `baseline/guardrails.md` verbatim first;
use the registry's exact spellings; unknowns become {{FILL_SNAKE_CASE}} tokens.
