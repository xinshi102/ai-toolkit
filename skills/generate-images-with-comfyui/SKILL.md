---
name: generate-images-with-comfyui
description: Generate and iterate images locally with the user's installed ComfyUI, Stable Diffusion 1.5, and Counterfeit-V2.5 workflows. Use when the user asks for local image generation, ComfyUI, Stable Diffusion, blog or project artwork, image variants, img2img, inpainting, upscaling, anime character design, or consistent character expressions. Can run directly for a small job or through the supervised Hermes worker for repetitive batches. Always inspect rendered images visually before acceptance; do not treat successful workflow execution as sufficient quality evidence.
---

# Generate Images with ComfyUI

Use the installed local ComfyUI stack from any workspace. Keep visual direction and final acceptance in Codex; delegate repetitive execution to Hermes when appropriate.

Read [local-environment.md](references/local-environment.md) before the first run in a task. Read the existing Hermes character reference only for consistent anime-character work:

`/Users/xinshi/.hermes/skills/creative/comfyui/references/counterfeit-character-consistency.md`

## Define the visual brief

Before generating, establish:

- intended use and target file path;
- aspect ratio and minimum dimensions;
- visual style, composition, palette, subject, and exclusions;
- whether consistency with an existing image matters;
- how many candidates are worth generating;
- observable acceptance criteria.

Inspect existing project visuals before deciding direction. Do not default to generic AI gradients or disconnected decorative art.

## Choose the workflow

- Use SD 1.5 text-to-image for fast general candidates.
- Use Counterfeit-V2.5 for anime or visual-novel characters.
- Use reference-image img2img with denoise `0.40–0.45` for character identity and expression variants.
- Use the dedicated inpaint or upscale workflows when changing a region or improving resolution.
- Prefer a small candidate batch followed by critique over one large blind batch.

For repeated variants, seed sweeps, or multi-stage production, use `$supervise-hermes`: Codex writes the visual brief and acceptance rubric; Hermes runs ComfyUI and records outputs; Codex views and selects the images.

## Start and verify the local service

Check `http://127.0.0.1:8188/system_stats`. If unavailable, start the installed ComfyUI with its virtual environment and the required Apple Silicon option `--cpu-vae`. Bind only to localhost.

Do not reinstall ComfyUI or download models when the existing installation satisfies the request. Network downloads and new custom nodes require explicit scope and a dependency check.

Before generation, verify the selected checkpoint exists and the workflow dependencies are satisfied. Use the existing health and dependency scripts listed in [local-environment.md](references/local-environment.md).

## Generate into the project

Use API-format workflow JSON with the existing execution scripts. The saved desktop `character_variants_workflow.json` is editor-format and is not directly executable; use the production character script or an API-format workflow instead.

Write outputs directly to an explicitly allowed project asset directory when possible. Use `/Users/xinshi/Desktop/ai_images/` only when the request has no project destination. Preserve seeds, prompts, checkpoint name, sampler, steps, CFG, denoise, and source-image provenance alongside important assets in the project's `ITERATIONS.md` or existing asset record.

Never overwrite an accepted source image. Create candidates with distinct names, then copy only selected results into final asset paths.

## Validate visually

After generation:

1. Confirm output files decode and meet required dimensions.
2. View every candidate with image inspection.
3. Judge composition, focal hierarchy, palette, anatomy, text artifacts, unwanted marks, edge defects, and fit with the project UI.
4. For character sets, compare face, hair, proportions, clothing, eye color, and distinctive marks across all variants.
5. Reject weak candidates and run a focused correction batch when needed.
6. Put the selected asset into the project and verify it in the rendered page or product context.

For UI work, show the user the rendered result or a directly viewable image. A path, generation log, or passing build alone is not acceptance.

## Stop cleanly

Leave ComfyUI running only when more generations are expected in the current task. Otherwise stop the process started by Codex after outputs are secured. Do not stop a pre-existing user-started ComfyUI process.
