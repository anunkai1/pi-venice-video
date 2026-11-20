/**
 * pi-venice-video — Venice video-generation extension for the pi coding agent.
 *
 * Registers:
 *   - venice_generate_video(prompt, ...)   — quote + cap check + queue + poll → /uploads/<uuid>.mp4 (+ poster)
 *   - venice_video_result(queue_id, ...)   — collect a timed-out or restarted job
 *   - /videogen                            — model-free slash command with quote gate + chat note
 *   - /videomodel                          — live catalog picker writing ~/.config/acb/video-model
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import {
	CostCapExceededError,
	DEFAULT_VIDEO_MODEL,
	assertWithinCap,
	completeVideo,
	fetchVideoModels,
	getVeniceKey,
	getVideoJob,
	persistVideoModelOverride,
	persistVideoResponse,
	pollVideoJob,
	queueVideo,
	quoteVideo,
	readVideoModelOverride,
	resolveMaxCostUsd,
	resolveOutputDir,
	resolveVariantModel,
	resolveVideoInputImage,
	resolveVideoModel,
	saveVideoJob,
	validateAndBuildBodies,
	type PersistedVideo,
	type VeniceVideoModel,
} from "./lib.js";

// ── Schemas ────────────────────────────────────────────────────────

const VideoGenerateParams = Type.Object({
	prompt: Type.String({
		description:
			"Text description of the video to generate (motion, subject, camera, scene, audio cues).",
	}),
	model: Type.Optional(
		Type.String({
			description:
				"Venice video model ID override. Defaults to ~/.config/acb/video-model, $VENICE_VIDEO_MODEL, or minimax-h3-chili-text-to-video. Variant suffixes (-image-to-video / -reference-to-video) are resolved automatically from inputs.",
		}),
	),
	negative_prompt: Type.Optional(
		Type.String({
			description: "Elements to avoid in the generated video.",
		}),
	),
	duration: Type.Optional(
		Type.String({
			description: "Clip duration (model-dependent, e.g. '4s', '5s', '10s'). Default '5s'.",
		}),
	),
	aspect_ratio: Type.Optional(
		Type.String({
			description:
				"Output aspect ratio (e.g. '16:9', '9:16', '1:1', 'adaptive'). Omitted automatically for image-to-video models whose catalog aspect_ratios is empty.",
		}),
	),
	resolution: Type.Optional(
		Type.String({
			description:
				"Output resolution (e.g. '768P', '720p', '1080p'). Normalized against the model's live constraints.",
		}),
	),
	audio: Type.Optional(
		Type.Boolean({
			description:
				"Enable/disable native audio when the chosen model declares audio_configurable=true.",
		}),
	),
	image: Type.Optional(
		Type.String({
			description:
				"First-frame image (/uploads/<file>, local path, https:// URL, or data: URL). Automatically selects the image-to-video variant.",
		}),
	),
	end_image: Type.Optional(
		Type.String({
			description:
				"Optional end-frame image (/uploads/<file>, local path, https:// URL, or data: URL).",
		}),
	),
	reference_images: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Reference images for character/style consistency (/uploads/<file>, local path, URL). Automatically selects the reference-to-video variant.",
		}),
	),
	max_cost: Type.Optional(
		Type.Number({
			description:
				"Maximum allowed quote in USD before queueing (default $1.00 or $VENICE_VIDEO_MAX_USD).",
		}),
	),
});

const VideoResultParams = Type.Object({
	queue_id: Type.String({
		description: "The queue_id returned when a video generation job timed out.",
	}),
	model: Type.Optional(
		Type.String({
			description: "Optional model ID override for display/metadata.",
		}),
	),
	download_url: Type.Optional(
		Type.String({
			description:
				"Optional pre-signed download_url from /video/queue if the job isn't in local ~/.config/acb/video-jobs.json.",
		}),
	),
});

// ── Shared formatting ──────────────────────────────────────────────

function buildVideoMarkup(persisted: PersistedVideo): string {
	const attrs = [
		"controls",
		"playsinline",
		persisted.posterUrl ? `poster="${persisted.posterUrl}"` : null,
		`src="${persisted.videoUrl}"`,
	]
		.filter(Boolean)
		.join(" ");
	return `<video ${attrs}></video>`;
}

function escapeMarkdownText(text: string): string {
	return text.replace(/\s+/g, " ").trim().replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, "\\$&");
}

function formatCompletedLines(opts: {
	persisted: PersistedVideo;
	model: string;
	queueId: string;
	quoteUsd?: number;
	duration?: string;
	resolution?: string;
	aspectRatio?: string;
	elapsedMs: number;
}): string {
	const meta = [
		opts.model,
		opts.duration,
		opts.resolution,
		opts.aspectRatio,
		typeof opts.quoteUsd === "number" ? `$${opts.quoteUsd.toFixed(4)} USD` : null,
		`${Math.round(opts.elapsedMs / 100) / 10}s`,
	]
		.filter(Boolean)
		.join(" · ");

	const lines = [
		`Generated video (${meta}):`,
		"",
		buildVideoMarkup(opts.persisted),
		"",
		`URL: ${opts.persisted.videoUrl}`,
		`path: \`${opts.persisted.videoPath}\``,
	];
	if (opts.persisted.posterUrl && opts.persisted.posterPath) {
		lines.push(`poster: ${opts.persisted.posterUrl} (\`${opts.persisted.posterPath}\`)`);
	}
	lines.push(`queue_id: \`${opts.queueId}\``);
	return lines.join("\n");
}

// ── /videogen argument parser ──────────────────────────────────────

interface VideogenArgs {
	prompt: string;
	model?: string;
	duration?: string;
	aspect_ratio?: string;
	resolution?: string;
	image?: string;
	end_image?: string;
	max_cost?: number;
	yes: boolean;
}

export function parseVideogenArgs(raw: string): VideogenArgs {
	const out: VideogenArgs = { prompt: "", yes: false };
	const tokens = raw.match(/(?:"[^"]*"|'[^']*'|\S)+/g)?.map((t) => {
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
			return t.slice(1, -1);
		}
		return t;
	}) ?? [];
	const positional: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const next = tokens[i + 1];
		if ((t === "-m" || t === "--model") && next) out.model = tokens[++i];
		else if ((t === "-d" || t === "--duration") && next) out.duration = tokens[++i];
		else if ((t === "-a" || t === "--aspect") && next) out.aspect_ratio = tokens[++i];
		else if ((t === "-r" || t === "--resolution") && next) out.resolution = tokens[++i];
		else if ((t === "-i" || t === "--image") && next) out.image = tokens[++i];
		else if ((t === "-e" || t === "--end-image") && next) out.end_image = tokens[++i];
		else if ((t === "-c" || t === "--max-cost") && next) {
			const val = Number(tokens[++i]);
			if (!Number.isFinite(val) || val <= 0) {
				throw new Error(`Invalid -c/--max-cost value '${tokens[i]}'`);
			}
			out.max_cost = val;
		} else if (t === "-y" || t === "--yes") {
			out.yes = true;
		} else {
			positional.push(t);
		}
	}
	out.prompt = positional.join(" ").trim();
	return out;
}

function formatPickerOptions(models: readonly VeniceVideoModel[]): string[] {
	const sorted = [...models].sort((a, b) => {
		if (a.id === DEFAULT_VIDEO_MODEL) return -1;
		if (b.id === DEFAULT_VIDEO_MODEL) return 1;
		const aUnc = a.model_spec?.uncensored ? 0 : 1;
		const bUnc = b.model_spec?.uncensored ? 0 : 1;
		if (aUnc !== bUnc) return aUnc - bUnc;
		return a.id.localeCompare(b.id);
	});
	return sorted.map((m) => {
		const name = m.model_spec?.name || m.id;
		const res = m.model_spec?.constraints?.resolutions?.join("/") || "auto";
		const durs = m.model_spec?.constraints?.durations;
		const durSpan = durs && durs.length > 0 ? `${durs[0]}–${durs[durs.length - 1]}` : "var";
		const flags = [
			m.id === DEFAULT_VIDEO_MODEL ? "default" : null,
			m.model_spec?.uncensored ? "uncensored" : null,
			res,
			durSpan,
		]
			.filter(Boolean)
			.join(" · ");
		return `${name} (${m.id}) — ${flags}`;
	});
}

function modelIdFromOption(option: string): string | undefined {
	const label = option.split(" — ", 1)[0];
	const match = label.match(/\(([^()]*)\)\s*$/);
	return match?.[1]?.trim() || undefined;
}

// ── Extension entrypoint ───────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "venice_generate_video",
		label: "Venice: Generate Video",
		description:
			"Generate a short video clip via Venice API (quotes price and enforces max_cost cap before queueing, polls async job, validates MP4/WebM/MOV container, saves to /uploads/<uuid>.mp4 with an ffmpeg poster frame). Supports text-to-video, image-to-video, and reference-to-video variants automatically.",
		promptSnippet:
			"Use when the user asks for a video, clip, or animation via Venice. Returns /uploads/<uuid>.mp4 (+ poster .jpg). Include `<video controls playsinline poster=\"/uploads/...\" src=\"/uploads/...\"></video>` in your reply so it plays inline in the UI. If it times out and returns a queue_id, use `venice_video_result(queue_id)` to collect it.",
		parameters: VideoGenerateParams,
		async execute(_callId, params, signal, onUpdate, _ctx) {
			const apiKey = getVeniceKey();
			if (!apiKey) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Error: VENICE_API_KEY is not set. Configure it in /home/lepton/.secrets/llm/providers.env and restart.",
						},
					],
					details: { error: "VENICE_API_KEY missing" },
				};
			}

			const prompt = String(params.prompt ?? "").trim();
			if (!prompt) {
				return {
					isError: true,
					content: [{ type: "text", text: "Error: 'prompt' is required and must be non-empty." }],
					details: { error: "missing prompt" },
				};
			}

			try {
				const maxCostUsd = resolveMaxCostUsd(params.max_cost, false);
				const baseModelId = resolveVideoModel(params.model);
				const models = await fetchVideoModels(apiKey, { signal });
				const hasImage = typeof params.image === "string" && params.image.trim().length > 0;
				const hasEndImage = typeof params.end_image === "string" && params.end_image.trim().length > 0;
				const refInputs = Array.isArray(params.reference_images)
					? params.reference_images.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
					: [];
				const resolvedModel = resolveVariantModel(
					baseModelId,
					{
						hasImage,
						hasEndImage,
						hasReferenceImages: refInputs.length > 0,
					},
					models,
				);

				const imageUrl = hasImage ? await resolveVideoInputImage(params.image!) : undefined;
				const endImageUrl = hasEndImage ? await resolveVideoInputImage(params.end_image!) : undefined;
				const referenceImageUrls =
					refInputs.length > 0
						? await Promise.all(refInputs.map((r) => resolveVideoInputImage(r)))
						: undefined;

				const built = validateAndBuildBodies(resolvedModel, {
					prompt,
					negative_prompt: params.negative_prompt,
					duration: params.duration,
					aspect_ratio: params.aspect_ratio,
					resolution: params.resolution,
					audio: params.audio,
					image_url: imageUrl,
					end_image_url: endImageUrl,
					reference_image_urls: referenceImageUrls,
				});

				const quoteUsd = await quoteVideo(apiKey, built.quoteBody, { signal });
				assertWithinCap(quoteUsd, maxCostUsd, built);

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Quoted $${quoteUsd.toFixed(4)} USD for ${built.model} (${built.duration}${built.resolution ? `, ${built.resolution}` : ""}) — queueing job…`,
						},
					],
					details: {
						stage: "queueing",
						model: built.model,
						quote_usd: quoteUsd,
					},
				});

				const queued = await queueVideo(apiKey, built.queueBody, { signal });
				saveVideoJob({
					queue_id: queued.queue_id,
					model: queued.model,
					download_url: queued.download_url,
					prompt,
					quote_usd: quoteUsd,
					duration: built.duration,
					resolution: built.resolution,
					aspect_ratio: built.aspect_ratio,
					created_at: Date.now(),
				});

				const outcome = await pollVideoJob({
					apiKey,
					queueId: queued.queue_id,
					downloadUrl: queued.download_url,
					signal,
					onProgress: (p) => {
						const elapsedS = Math.round(p.elapsedMs / 1000);
						const estS = p.averageExecutionTimeMs
							? Math.round(p.averageExecutionTimeMs / 1000)
							: undefined;
						onUpdate?.({
							content: [
								{
									type: "text",
									text: estS
										? `Generating ${queued.model} (${elapsedS}s / ~${estS}s est, queue_id=${queued.queue_id})…`
										: `Generating ${queued.model} (${elapsedS}s elapsed, queue_id=${queued.queue_id})…`,
								},
							],
							details: {
								stage: "polling",
								model: queued.model,
								queue_id: queued.queue_id,
								quote_usd: quoteUsd,
								elapsed_s: elapsedS,
								estimated_s: estS,
							},
						});
					},
				});

				if (outcome.status === "timeout") {
					const elapsedS = Math.round(outcome.elapsedMs / 1000);
					return {
						content: [
							{
								type: "text",
								text:
									`Video generation timed out after ${elapsedS}s, but the Venice job is still running.\n` +
									`- model: \`${queued.model}\`\n` +
									`- quote: $${quoteUsd.toFixed(4)} USD\n` +
									`- queue_id: \`${queued.queue_id}\`\n\n` +
									`Call \`venice_video_result(queue_id: "${queued.queue_id}")\` to collect the video once ready.`,
							},
						],
						details: {
							status: "timeout",
							model: queued.model,
							queue_id: queued.queue_id,
							download_url: queued.download_url,
							quote_usd: quoteUsd,
							elapsed_s: elapsedS,
						},
					};
				}

				const persisted = await persistVideoResponse(outcome.response, resolveOutputDir());
				await completeVideo(apiKey, queued.queue_id);

				return {
					content: [
						{
							type: "text",
							text: formatCompletedLines({
								persisted,
								model: queued.model,
								queueId: queued.queue_id,
								quoteUsd,
								duration: built.duration,
								resolution: built.resolution,
								aspectRatio: built.aspect_ratio,
								elapsedMs: outcome.elapsedMs,
							}),
						},
					],
					details: {
						status: "completed",
						model: queued.model,
						queue_id: queued.queue_id,
						quote_usd: quoteUsd,
						video: persisted.videoUrl,
						poster: persisted.posterUrl,
						path: persisted.videoPath,
						poster_path: persisted.posterPath,
						mime: persisted.mime,
						bytes: persisted.bytes,
						duration: built.duration,
						resolution: built.resolution,
						aspect_ratio: built.aspect_ratio,
						elapsed_s: Math.round(outcome.elapsedMs / 100) / 10,
					},
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [{ type: "text", text: `Error generating video: ${msg}` }],
					details: {
						error: msg,
						over_cap: err instanceof CostCapExceededError,
					},
				};
			}
		},
	});

	pi.registerTool({
		name: "venice_video_result",
		label: "Venice: Collect Video Result",
		description:
			"Collect a previously queued Venice video job by queue_id (used after a timeout or pi restart).",
		parameters: VideoResultParams,
		async execute(_callId, params, signal, onUpdate, _ctx) {
			const apiKey = getVeniceKey();
			if (!apiKey) {
				return {
					isError: true,
					content: [{ type: "text", text: "Error: VENICE_API_KEY is not set." }],
					details: { error: "VENICE_API_KEY missing" },
				};
			}
			const queueId = String(params.queue_id ?? "").trim();
			if (!queueId) {
				return {
					isError: true,
					content: [{ type: "text", text: "Error: 'queue_id' is required." }],
					details: { error: "missing queue_id" },
				};
			}

			const saved = getVideoJob(queueId);
			const model = params.model?.trim() || saved?.model || "venice-video";
			const downloadUrl = params.download_url?.trim() || saved?.download_url;

			try {
				const outcome = await pollVideoJob({
					apiKey,
					queueId,
					downloadUrl,
					signal,
					onProgress: (p) => {
						const elapsedS = Math.round(p.elapsedMs / 1000);
						const estS = p.averageExecutionTimeMs
							? Math.round(p.averageExecutionTimeMs / 1000)
							: undefined;
						onUpdate?.({
							content: [
								{
									type: "text",
									text: estS
										? `Polling ${queueId} (${elapsedS}s / ~${estS}s est)…`
										: `Polling ${queueId} (${elapsedS}s elapsed)…`,
								},
							],
							details: { stage: "polling", queue_id: queueId, model, elapsed_s: elapsedS },
						});
					},
				});

				if (outcome.status === "timeout") {
					const elapsedS = Math.round(outcome.elapsedMs / 1000);
					return {
						content: [
							{
								type: "text",
								text: `Job \`${queueId}\` (${model}) is still processing after ${elapsedS}s. Call \`venice_video_result(queue_id: "${queueId}")\` again to continue waiting.`,
							},
						],
						details: { status: "timeout", queue_id: queueId, model, elapsed_s: elapsedS },
					};
				}

				const persisted = await persistVideoResponse(outcome.response, resolveOutputDir());
				await completeVideo(apiKey, queueId);

				return {
					content: [
						{
							type: "text",
							text: formatCompletedLines({
								persisted,
								model,
								queueId,
								quoteUsd: saved?.quote_usd,
								duration: saved?.duration,
								resolution: saved?.resolution,
								aspectRatio: saved?.aspect_ratio,
								elapsedMs: outcome.elapsedMs,
							}),
						},
					],
					details: {
						status: "completed",
						model,
						queue_id: queueId,
						quote_usd: saved?.quote_usd,
						video: persisted.videoUrl,
						poster: persisted.posterUrl,
						path: persisted.videoPath,
						poster_path: persisted.posterPath,
						mime: persisted.mime,
						bytes: persisted.bytes,
						elapsed_s: Math.round(outcome.elapsedMs / 100) / 10,
					},
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [{ type: "text", text: `Error collecting video ${queueId}: ${msg}` }],
					details: { error: msg, queue_id: queueId },
				};
			}
		},
	});

	pi.registerCommand("videomodel", {
		description: "Select the active Venice video-generation model from the live catalog",
		handler: async (_args, ctx) => {
			const apiKey = getVeniceKey();
			if (!apiKey) {
				ctx.ui.notify("VENICE_API_KEY is not set", "error");
				return;
			}
			let models: VeniceVideoModel[];
			try {
				models = await fetchVideoModels(apiKey, { forceRefresh: true });
			} catch (err) {
				ctx.ui.notify(
					`Failed to fetch Venice video models: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				return;
			}
			const current = readVideoModelOverride() || resolveVideoModel();
			const options = formatPickerOptions(models);
			const picked = await ctx.ui.select(`Video model (current: ${current})`, options);
			if (!picked) return;
			const id = modelIdFromOption(picked);
			if (!id) return;
			persistVideoModelOverride(id);
			ctx.ui.notify(`video model set to ${id}`, "info");
		},
	});

	pi.registerCommand("videogen", {
		description:
			"Generate a video directly via Venice (no LLM). Usage: /videogen [-m MODEL] [-d 5s] [-a 16:9] [-r 768P] [-i /uploads/x.png] [-c MAX_USD] [-y] \"prompt\"",
		handler: async (args, ctx) => {
			const apiKey = getVeniceKey();
			if (!apiKey) {
				ctx.ui.notify("VENICE_API_KEY is not set", "error");
				return;
			}
			let parsed: VideogenArgs;
			try {
				parsed = parseVideogenArgs(args ?? "");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
				return;
			}
			if (!parsed.prompt) {
				ctx.ui.notify(
					'usage: /videogen [-m MODEL] [-d 5s] [-a 16:9] [-r 768P] [-i /uploads/x.png] [-c MAX_USD] [-y] "prompt"',
					"warning",
				);
				return;
			}

			const displayedPrompt = escapeMarkdownText(parsed.prompt);
			try {
				const maxCostUsd = resolveMaxCostUsd(parsed.max_cost, parsed.yes);
				const baseModelId = resolveVideoModel(parsed.model);
				const models = await fetchVideoModels(apiKey);
				const resolvedModel = resolveVariantModel(
					baseModelId,
					{
						hasImage: Boolean(parsed.image),
						hasEndImage: Boolean(parsed.end_image),
						hasReferenceImages: false,
					},
					models,
				);
				const imageUrl = parsed.image ? await resolveVideoInputImage(parsed.image) : undefined;
				const endImageUrl = parsed.end_image
					? await resolveVideoInputImage(parsed.end_image)
					: undefined;
				const built = validateAndBuildBodies(resolvedModel, {
					prompt: parsed.prompt,
					duration: parsed.duration,
					aspect_ratio: parsed.aspect_ratio,
					resolution: parsed.resolution,
					image_url: imageUrl,
					end_image_url: endImageUrl,
				});

				const quoteUsd = await quoteVideo(apiKey, built.quoteBody);
				assertWithinCap(quoteUsd, maxCostUsd, built);

				ctx.ui.notify(
					`videogen: quoted $${quoteUsd.toFixed(4)} USD (${built.model}, ${built.duration}) — queueing…`,
					"info",
				);

				const queued = await queueVideo(apiKey, built.queueBody);
				saveVideoJob({
					queue_id: queued.queue_id,
					model: queued.model,
					download_url: queued.download_url,
					prompt: parsed.prompt,
					quote_usd: quoteUsd,
					duration: built.duration,
					resolution: built.resolution,
					aspect_ratio: built.aspect_ratio,
					created_at: Date.now(),
				});

				pi.sendMessage({
					customType: "note",
					content:
						`**🎬 /videogen** — ⏳ queued (${queued.model} · ${built.duration} · $${quoteUsd.toFixed(4)} USD · \`${queued.queue_id}\`)\n\n` +
						`**Prompt:** ${displayedPrompt}`,
					display: true,
					details: {
						source: "videogen",
						pending: true,
						queue_id: queued.queue_id,
						model: queued.model,
						quote_usd: quoteUsd,
						prompt: parsed.prompt,
					},
				});

				let lastNotify = 0;
				const outcome = await pollVideoJob({
					apiKey,
					queueId: queued.queue_id,
					downloadUrl: queued.download_url,
					onProgress: (p) => {
						const now = Date.now();
						if (now - lastNotify >= 10_000) {
							lastNotify = now;
							const elapsedS = Math.round(p.elapsedMs / 1000);
							const estS = p.averageExecutionTimeMs
								? Math.round(p.averageExecutionTimeMs / 1000)
								: undefined;
							ctx.ui.notify(
								estS
									? `videogen: ${elapsedS}s / ~${estS}s (${queued.model})…`
									: `videogen: ${elapsedS}s elapsed (${queued.model})…`,
								"info",
							);
						}
					},
				});

				if (outcome.status === "timeout") {
					const elapsedS = Math.round(outcome.elapsedMs / 1000);
					ctx.ui.notify(`videogen timed out after ${elapsedS}s (queue_id=${queued.queue_id})`, "warning");
					pi.sendMessage({
						customType: "note",
						content:
							`**🎬 /videogen** — ⏱ timed out after ${elapsedS}s\n\n` +
							`**queue_id:** \`${queued.queue_id}\` — ask the assistant to run \`venice_video_result(queue_id: "${queued.queue_id}")\``,
						display: true,
						details: {
							source: "videogen",
							status: "timeout",
							queue_id: queued.queue_id,
							model: queued.model,
							quote_usd: quoteUsd,
							prompt: parsed.prompt,
						},
					});
					return;
				}

				const persisted = await persistVideoResponse(outcome.response, resolveOutputDir());
				await completeVideo(apiKey, queued.queue_id);
				const meta = [
					queued.model,
					built.duration,
					built.resolution,
					built.aspect_ratio,
					`$${quoteUsd.toFixed(4)} USD`,
					`${Math.round(outcome.elapsedMs / 100) / 10}s`,
				]
					.filter(Boolean)
					.join(" · ");

				pi.sendMessage({
					customType: "note",
					content:
						`**🎬 /videogen** — ${meta}\n\n` +
						`**Prompt:** ${displayedPrompt}\n\n` +
						`${buildVideoMarkup(persisted)}\n\n` +
						`**path:** \`${persisted.videoPath}\``,
					display: true,
					details: {
						source: "videogen",
						status: "completed",
						queue_id: queued.queue_id,
						model: queued.model,
						quote_usd: quoteUsd,
						url: persisted.videoUrl,
						path: persisted.videoPath,
						poster: persisted.posterUrl,
						poster_path: persisted.posterPath,
						prompt: parsed.prompt,
					},
				});
				ctx.ui.notify(`videogen: saved ${persisted.videoPath}`, "info");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`videogen failed: ${msg}`, "error");
				pi.sendMessage({
					customType: "note",
					content: `**🎬 /videogen** — failed: ${msg}\n\n**Prompt:** ${displayedPrompt}`,
					display: true,
					details: { source: "videogen", prompt: parsed.prompt, error: msg },
				});
			}
		},
	});
}
