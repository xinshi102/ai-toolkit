# Local ComfyUI Environment

## Installed resources

- ComfyUI root: `/Users/xinshi/Projects/engines/comfyui`
- Python: `/Users/xinshi/Projects/engines/comfyui/venv/bin/python`
- Local API: `http://127.0.0.1:8188`
- Required Apple Silicon flag: `--cpu-vae`
- Checkpoints:
  - `v1-5-pruned-emaonly.safetensors`
  - `Counterfeit-V2.5.safetensors`
- Default non-project output: `/Users/xinshi/Desktop/ai_images`

## Existing execution resources

- Hermes ComfyUI skill: `/Users/xinshi/.hermes/skills/creative/comfyui`
- Health check: `/Users/xinshi/.hermes/skills/creative/comfyui/scripts/health_check.py`
- Dependency check: `/Users/xinshi/.hermes/skills/creative/comfyui/scripts/check_deps.py`
- Workflow runner: `/Users/xinshi/.hermes/skills/creative/comfyui/scripts/run_workflow.py`
- Batch runner: `/Users/xinshi/.hermes/skills/creative/comfyui/scripts/run_batch.py`
- Character variants: `/Users/xinshi/.hermes/scripts/char_variants.py`

## API-format workflows

Directory: `/Users/xinshi/.hermes/skills/creative/comfyui/workflows`

- `sd15_txt2img.json`
- `sdxl_txt2img.json`
- `sdxl_img2img.json`
- `sdxl_inpaint.json`
- `upscale_4x.json`

Only SD 1.5 and Counterfeit-V2.5 checkpoints are currently confirmed locally. Check dependencies before selecting SDXL, Flux, video, or custom-node workflows.

## User-specific character workflow

- Desktop workflow: `/Users/xinshi/Desktop/ai_images/character_variants_workflow.json`
- Format: ComfyUI editor JSON, not directly executable through `/prompt`
- Production route: `char_variants.py`, which constructs API-format nodes internally
- Baseline: `dpmpp_2m`, `karras`, 30 steps, CFG 7, denoise 0.40–0.45
- Known limitations: monolids and small facial moles may require inpainting or post-processing

## Service lifecycle

Check health first. If Codex must start the service, run the virtual-environment Python against `main.py` from the ComfyUI root with `--cpu-vae`, and track the process ID. Do not expose it beyond `127.0.0.1`.

Stop only the process started for the current task. Never terminate an existing service merely because the task is finished.
