# pi-venice-video

Venice video-generation extension for the [pi coding agent](https://github.com/earendil-works/pi).

Registers:

- **`venice_generate_video(prompt, ...)`** — live catalog + variant resolution, `POST /video/quote` cost gate, `POST /video/queue`, async polling, container magic verification, `/uploads/<uuid>.mp4` persistence + `ffmpeg` poster `.jpg`.
- **`venice_video_result(queue_id, ...)`** — collects a timed-out job (using saved metadata in `~/.config/acb/video-jobs.json`, including `download_url` for VPS-backed models).
- **`/videogen`** — slash command for direct generation without an LLM turn (`-m`, `-d`, `-a`, `-r`, `-i`, `-e`, `-c`, `-y`).
- **`/videomodel`** — live `/models?type=video` picker writing `~/.config/acb/video-model`.

## Cost & safety

- Every generation calls `POST /video/quote` first.
- Enforces `max_cost` (default `$1.00 USD`, overridable via `max_cost` param, `VENICE_VIDEO_MAX_USD`, or `-c`/`-y` on `/videogen`).
- `PI_VIDEO_MAX_BYTES` defaults to 200 MiB; respects `AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES`.
- Default model is `minimax-h3-chili-text-to-video` (uncensored, 768P, 4s–15s, native audio).

## Checks

```bash
npm install
npx tsc --noEmit
npx vitest run
```
