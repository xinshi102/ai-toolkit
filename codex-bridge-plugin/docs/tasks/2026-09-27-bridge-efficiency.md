# Bridge protocol and conversation clarity

## Goal

Keep the collaboration window readable while reducing repeated prompt boilerplate, making test sessions visible, and linking DSH replies to their originating Codex message.

## Scope

- Preserve full structured message records and existing API compatibility.
- Keep the DSH prompt concise without shortening meaningful task content or boundary fields.
- Add optional work/test purpose to session authorization and show test sessions distinctly.
- Add optional `replyToMessageId` to replies and render the association.
- Make `delivered` visibly mean queue acceptance and surface delivery errors.

## Constraints

- Do not read or persist credentials.
- Do not remove or rewrite historical collaboration records.
- Do not make `replyToMessageId` mandatory for older clients.
- Do not change the queue mode or session prompt contract.

## Acceptance

- `npm test` covers prompt shape, purpose labels/defaulting, reply correlation, and both message directions.
- `node --check` passes for changed JavaScript; Swift source remains type-checkable if touched.
- Profile plugin files match source files.
- Runtime smoke check confirms a compact prompt is queued, status updates progress through `read`, `processing`, and `completed`, and a reply references its request.
- README documents the distinction between durable display records and the compact wire prompt.
