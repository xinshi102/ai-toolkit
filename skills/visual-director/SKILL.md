---
name: visual-director
description: Translate feeling-based, story-based, or non-technical visual requests into a professional visual brief, controlled image-generation experiments, visual critique, and reproducible iteration records. Use when the user can describe the desired feeling but not prompt-engineering terms; when planning or generating illustrations, visual-novel art, character images, posters, or supporting visuals; or when diagnosing whether disappointing image results come from the brief, prompt, workflow, parameters, reference strategy, or model capability.
---

# Visual Director

Own the professional translation layer. Never require the user to know camera, composition, lighting, color, model, sampler, or prompt terminology.

Match the user's language in every user-visible direction, label, comparison sheet, brief, report, and choice. When the user communicates in Chinese, keep English prompts, node names, and model parameters internal unless they explicitly ask to inspect them; present all decisions and visual comparisons in Chinese.

Use `$generate-images-with-comfyui` for local execution. Use `$canvas-design` when a static-art task needs an explicit visual philosophy before generation. Keep visual direction and final acceptance in Codex.

## Start from human language

Extract what is already present in the user's words:

- intended use and delivery context;
- story moment and subject relationship;
- desired audience feeling;
- must-have details and protected identity traits;
- disliked tropes, moods, artifacts, and exclusions;
- references, including what to borrow and what not to copy.

Ask at most one blocking question. Supply reversible defaults for missing technical choices and state them briefly.

Convert emotional language into observable visual controls. Examples:

- closeness with distance -> near placement, mismatched gaze, interrupted sightline, negative space;
- quiet rather than sad -> restrained gesture, level camera, soft contrast, no tears or theatrical rain;
- memory without sepia nostalgia -> reduced local contrast, soft highlights, selective color memory;
- independent character agency -> visible personal task, off-axis attention, meaningful belongings, non-orbiting composition.

For SD 1.x-family checkpoints, compress the final generation prompt to the few highest-value controls. Treat the visual brief as the full reasoning record, not as text to paste wholesale into CLIP. Avoid negative phrases about people counts such as `more than two people`; they can suppress the subject instead of enforcing a count. Test a compact prompt before blaming the checkpoint.

## Create the job record

For a durable task, run `scripts/init_image_job.py --root <allowed-output-root> --slug <job-name>`.

Fill `brief.md` before generation. Record each candidate and decision in `ITERATIONS.md`. Never overwrite accepted sources or selected outputs.

## Propose directions before prompts

Offer 2-3 directions in plain language. For each direction, state:

- emotional promise;
- composition and focal hierarchy;
- light and palette;
- style and material character;
- main risk or likely failure mode.

Do not expose a long prompt as the primary decision surface. Let the user choose by feeling and visible consequences.

## Generate in gated stages

Before submission, verify API-format workflow objects contain only node entries at the top level. Remove editor metadata or string keys such as `_comment` from a task-local copy when the installed ComfyUI validator rejects them; preserve the original workflow.

1. **Composition gate**: make a small low-cost candidate batch. Judge framing, subject placement, gesture, gaze, light direction, and palette. Ignore minor face and hand defects unless they invalidate the pose.
2. **Identity gate**: lock a selected seed or reference. Use img2img for character consistency. Verify face, hair, proportions, clothing, eye color, and distinctive marks.
3. **Expression and detail gate**: change one major variable per round. Prefer inpainting for local defects instead of regenerating an accepted composition.
4. **Finish gate**: upscale only after composition and identity pass.
5. **Context gate**: place the image in its target UI, page, poster, or crop and inspect the real use state.

Prefer 2-4 candidates per direction. Avoid large blind batches.

## Diagnose instead of merely retrying

Before changing anything, label the visible failure using `references/diagnosis-matrix.md`.

Run controlled comparisons when the cause is unclear:

- hold model and seed constant to test brief/prompt changes;
- hold prompt and seed constant to compare models;
- hold model, prompt, and seed constant to test sampler, CFG, steps, or denoise;
- hold the selected image constant to test inpainting or upscaling.

Change one causal layer at a time. Do not attribute a semantic or compositional failure to the model until a structured brief and controlled prompt have failed on multiple seeds. Do not attribute anatomy, identity drift, or fine-detail ceilings to wording when controlled iterations show the same limitation.

## Inspect every candidate

View every generated image. Score the dimensions in `references/diagnosis-matrix.md` and record concrete evidence, not general impressions.

Reject a candidate when it violates a must-have, protected trait, composition gate, or target-context constraint even if it is attractive in isolation.

## Report honestly

Separate these states:

- workflow configured;
- service and dependencies verified;
- image generation executed;
- outputs visually inspected;
- result accepted in target context.

Report the dominant bottleneck as one of: input ambiguity, visual-direction translation, prompt/workflow design, parameter choice, reference strategy, model capability, or target-context mismatch. Include the cheapest next action that can falsify the diagnosis.
