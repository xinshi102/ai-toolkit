---
name: personal-note-capture
description: Capture reading excerpts, personal memories, old notes, transcript fragments, and reflections into an Obsidian vault without losing provenance or the user's voice. Use when the user shares a quote, book reaction, memory, old note, voice/video transcript, or asks to archive such material.
---

# Personal Note Capture

Resolve the vault path and read the destination note or local conventions before writing. Preserve the user's wording, uncertainty, original date, and source; never invent emotional interpretation or missing bibliographic facts.

## Choose a destination

- Reading excerpts and book reactions: the vault's reading/excerpts note or its existing equivalent.
- Old notes, memory fragments, voice transcripts, and video reflections: a dated memory archive note or its existing equivalent.
- If the vault has a project-specific convention, follow it rather than creating a parallel filing system.

## Reading excerpts

Extract, where supplied: book title, author, quoted text, and the user's reaction. Use the immediately preceding conversation only to carry forward an explicitly established book title. If provenance is unclear, record `未标注出处` rather than guessing.

Add entries under the current date, newest first:

```markdown
## YYYY-MM-DD
### 《书名》 — 作者（若已提供）
> 摘录原文

用户感想

——
```

## Memory archive

Use the archive date for the note filename and section heading. Keep a separate original date when supplied. Classify each item as `旧笔记`、`录音转写`、`视频感想` or `记忆`; retain an explicit user reflection but do not manufacture one.

```markdown
## 📝 旧笔记

内容：...
感受：...（若用户提供）
来源：...
原始时间：...（若已知）
归档时间：YYYY-MM-DD
```

## Interaction and verification

- Ask one concise question only when a missing detail materially affects filing, such as an ambiguous destination or requested original date.
- Respond naturally, not with mechanical “saved” confirmations.
- Re-read the edited portion to ensure the source text, date, and placement survived intact. State the note path and the fields that remain unknown.
