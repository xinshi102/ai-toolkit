# Image-generation diagnosis matrix

Use a 1-5 score for comparison, then support it with visible evidence. Scores help compare candidates; they do not replace judgment.

| Dimension | Inspect | Usually a process problem when | Usually a model problem when |
|---|---|---|---|
| Brief alignment | story moment, mood, relationship, exclusions | the prompt omits or contradicts the brief | multiple structured attempts still miss simple relationships |
| Composition | framing, hierarchy, spacing, gaze, gesture | direction is vague or too many constraints compete | repeated seeds collapse complex blocking or multi-person interaction |
| Mood | light, palette, contrast, visual rhythm | emotional words were not translated into controls | the checkpoint strongly forces its house style despite controls |
| Anatomy | hands, limbs, face, overlaps | pose is unnecessarily complex or framing is poorly chosen | the same defect class persists across clear prompts and seeds |
| Identity | face, hair, clothing, marks, proportions | no reference/seed lock or denoise is too high | identity drifts even with a sound reference workflow |
| Detail | textures, edges, small objects, artifacts | generation is being judged before inpaint/upscale | native output has a stable detail ceiling after controlled finishing |
| Editability | can a local defect be repaired without losing accepted parts? | the workflow regenerates globally instead of inpainting | local correction repeatedly damages adjacent structure |
| Context fit | crop, text space, UI overlap, visual weight | target context was never included in the brief | model cannot reliably reserve or control required space |

## Attribution rule

Call the issue process-dominant if structured direction produces a meaningful improvement within the same model and seed. Call it model-dominant if two or more controlled seeds retain the same important defect after the process is corrected. Use `mixed` when process improvement is real but the remaining ceiling blocks acceptance.

## Minimum evidence

- Compare at least two seeds for claims about a model.
- Compare naive and structured prompts on the same seed for claims about process.
- Keep checkpoint, dimensions, sampler, scheduler, steps, and CFG recorded.
- Inspect original images rather than thumbnails only.
