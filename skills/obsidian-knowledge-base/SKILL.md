---
name: obsidian-knowledge-base
description: Maintain an Obsidian vault and its Markdown-based LLM Wiki. Use when Codex needs to locate a vault, read or edit notes, ingest sources into a structured knowledge base, answer from the wiki, repair its index or links, audit knowledge quality, or propose a vault reorganization.
---

# Obsidian Knowledge Base

Operate on a resolved vault path only. Never infer a vault location from obsolete configuration; if unknown, locate `.obsidian` or ask the user. Before writing, read the vault's own `AGENTS.md`, `schema.md`, or equivalent conventions if present.

## Boundaries

- Treat personal source areas as read-only unless the user explicitly asks to edit them. Write agent-maintained material under the vault's `wiki/` area, or another user-approved destination.
- Treat the schema, assistant identity files, and vault-wide rules as read-only. Propose changes in a dated proposal note and wait for approval.
- Do not delete notes during maintenance. Move superseded material to a dated `wiki/archive/` location and preserve links where practical.
- Before moving or renaming notes, present the proposed tree and warn about wikilinks that may break.

## Orient before working

For a structured wiki, read its index, schema, and the recent tail of its log. Use the index to locate relevant pages; do not blindly scan the entire vault. Then read the selected pages and expand wikilinks only as needed.

If the requested claim or topic is absent, say so. If it is old, time-sensitive, uncertain, or contradicted by another page, surface that explicitly instead of silently treating it as fact.

## Choose an operation

| User intent | Do this |
|---|---|
| Add a URL, file, transcript, or note | Ingest it. |
| Ask what the vault says | Query through the index. |
| Ask to check, clean, or lint the wiki | Run the audit checklist. |
| Ask to reorganize the vault | Map, propose, wait for approval, then make phased moves. |

### Ingest

1. Read the full source and identify its provenance and date.
2. Create or update a source summary with frontmatter containing title, date, tags, and source.
3. Update only relevant entity, concept, comparison, or project pages. Use `[[wikilinks]]`; record disagreement rather than overwriting it.
4. Update the appropriate index entry and append a dated log entry.
5. Report the pages created or changed and any unresolved ambiguity.

Use one page per significant entity or concept; add to an existing page for passing mentions. Prefer no page to a low-value, disconnected page. Keep source material immutable and preserve provenance.

### Query

1. Read the index and locate the narrowest relevant pages.
2. Answer from those pages, distinguishing sourced facts, the vault's prior interpretation, and new inference.
3. Cite the relevant `[[pages]]`. Offer to create a missing page only when it would have lasting value.

### Audit / lint

Check for broken index links, unindexed pages, orphan pages, missing or invalid frontmatter, stale claims, duplicate names, weak provenance, unresolved contradictions, and absent cross-links. Fix safe mechanical issues; list semantic decisions and schema changes for the user to approve.

## Knowledge-quality rules

- New maintained pages must name their sources and link to related pages.
- Record uncertainty with `confidence: low` or an explicit note; record unresolved disagreement rather than deciding it unilaterally.
- Update an index and log whenever a maintained wiki page is created, moved, archived, or materially changed.
- Keep public-facing drafts distinct from private wiki notes and mark AI-assisted public drafts for human review.
