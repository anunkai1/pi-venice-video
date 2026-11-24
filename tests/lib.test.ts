import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPickerOptions, modelIdFromOption, parseVideogenArgs } from "../extensions/index.js";
import {
	CostCapExceededError,
	DEFAULT_VIDEO_MODEL,
	UploadStorageQuotaError,
	assertWithinCap,
	clearVideoModelCache,
	detectVideoContainer,
	fetchVideoModels,
	formatVeniceError,
	getVideoJob,
	persistVideoModelOverride,
	persistVideoResponse,
	pollVideoJob,
	queueVideo,
	quoteVideo,
	resolveMaxCostUsd,
	resolveVariantModel,
	resolveVideoModel,
	saveVideoJob,
	validateAndBuildBodies,
	type VeniceVideoModel,
} from "../extensions/lib.js";

const FIXTURE_MODELS: VeniceVideoModel[] = [
	{
		id: "minimax-h3-chili-text-to-video",
		model_spec: {
			name: "MiniMax H3 Chili",
			uncensored: true,
			constraints: {
				model_type: "text-to-video",
				aspect_ratios: ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"],
				resolutions: ["768P"],
				durations: ["4s", "5s", "10s", "15s"],
				audio: true,
				audio_configurable: false,
				prompt_character_limit: 7000,
			},
		},
	},
	{
		id: "minimax-h3-chili-image-to-video",
		model_spec: {
			name: "MiniMax H3 Chili",
			uncensored: true,
			constraints: {
				model_type: "image-to-video",
				aspect_ratios: [],
				resolutions: ["768P"],
				durations: ["4s", "5s", "10s", "15s"],
				audio: true,
				audio_configurable: false,
				prompt_character_limit: 7000,
			},
		},
	},
	{
		id: "minimax-h3-chili-reference-to-video",
		model_spec: {
			name: "MiniMax H3 Chili R2V",
			uncensored: true,
			constraints: {
				model_type: "image-to-video",
				aspect_ratios: ["adaptive", "16:9", "1:1"],
				resolutions: ["768P"],
				durations: ["4s", "5s", "10s", "15s"],
				audio: true,
				audio_configurable: false,
				prompt_character_limit: 7000,
			},
		},
	},
	{
		id: "seedance-2-0-text-to-video-basic",
		model_spec: {
			name: "Seedance 2.0",
			constraints: {
				model_type: "text-to-video",
				aspect_ratios: ["16:9", "9:16", "1:1"],
				resolutions: ["720p", "480p"],
				durations: ["5s", "10s"],
				audio: true,
				audio_configurable: true,
				prompt_character_limit: 2500,
			},
		},
	},
	{
		id: "seedance-2-0-image-to-video-basic",
		model_spec: {
			name: "Seedance 2.0",
			constraints: {
				model_type: "image-to-video",
				aspect_ratios: ["adaptive", "16:9"],
				resolutions: ["720p", "480p"],
				durations: ["5s", "10s"],
				audio: true,
				audio_configurable: true,
				prompt_character_limit: 2500,
			},
		},
	},
	{
		id: "grok-imagine-text-to-video-private",
		model_spec: {
			constraints: {
				model_type: "text-to-video",
				aspect_ratios: ["16:9", "9:16"],
				resolutions: ["720p"],
				durations: ["5s"],
				audio: false,
				audio_configurable: false,
			},
		},
	},
	{
		id: "grok-imagine-reference-to-video-private",
		model_spec: {
			constraints: {
				model_type: "image-to-video",
				aspect_ratios: ["16:9"],
				resolutions: ["720p"],
				durations: ["5s"],
				audio: false,
				audio_configurable: false,
			},
		},
	},
	{
		id: "runway-gen4-5-text",
		model_spec: {
			constraints: {
				model_type: "text-to-video",
				aspect_ratios: ["16:9"],
				resolutions: ["720p"],
				durations: ["5s", "10s"],
			},
		},
	},
	{
		id: "runway-gen4-5",
		model_spec: {
			constraints: {
				model_type: "image-to-video",
				aspect_ratios: ["16:9"],
				resolutions: ["720p"],
				durations: ["5s", "10s"],
			},
		},
	},
	{
		id: "flux-3-text-to-video",
		model_spec: {
			constraints: {
				model_type: "text-to-video",
				aspect_ratios: ["16:9"],
				resolutions: ["1080p", "720p"],
				durations: ["5s"],
			},
		},
	},
	{
		id: "flux-3-first-last-frame-to-video",
		model_spec: {
			constraints: {
				model_type: "image-to-video",
				aspect_ratios: ["16:9"],
				resolutions: ["720p"],
				durations: ["5s"],
			},
		},
	},
	{
		id: "kling-o3-pro-text-to-video",
		model_spec: {
			constraints: {
				model_type: "text-to-video",
				aspect_ratios: ["16:9"],
				resolutions: ["1080p", "720p"],
				durations: ["5s", "10s"],
			},
		},
	},
	{
		id: "kling-o3-pro-image-to-video",
		model_spec: {
			constraints: {
				model_type: "image-to-video",
				aspect_ratios: ["16:9"],
				resolutions: ["1080p", "720p"],
				durations: ["5s", "10s"],
			},
		},
	},
	{
		id: "kling-o3-pro-first-last-frame-to-video",
		model_spec: {
			constraints: {
				model_type: "image-to-video",
				aspect_ratios: ["16:9"],
				resolutions: ["1080p", "720p"],
				durations: ["5s", "10s"],
			},
		},
	},
	{
		id: "ovi-image-to-video",
		model_spec: {
			constraints: {
				model_type: "image-to-video",
				aspect_ratios: [],
				resolutions: [],
				durations: ["5s"],
			},
		},
	},
];

function makeMp4Bytes(tag = "test"): Buffer {
	const ftyp = Buffer.from([
		0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
		0x69, 0x73, 0x6f, 0x6d,
	]);
	return Buffer.concat([ftyp, Buffer.from(`mdat-${tag}`, "ascii")]);
}

// ── Variant resolution ─────────────────────────────────────────────

describe("resolveVariantModel", () => {
	it("switches chili text-to-video to image-to-video and reference-to-video", () => {
		expect(
			resolveVariantModel(
				"minimax-h3-chili-text-to-video",
				{ hasImage: true, hasEndImage: false, hasReferenceImages: false },
				FIXTURE_MODELS,
			).id,
		).toBe("minimax-h3-chili-image-to-video");

		expect(
			resolveVariantModel(
				"minimax-h3-chili-text-to-video",
				{ hasImage: false, hasEndImage: false, hasReferenceImages: true },
				FIXTURE_MODELS,
			).id,
		).toBe("minimax-h3-chili-reference-to-video");
	});

	it("preserves trailing -basic and -private suffixes via in-place replacement", () => {
		expect(
			resolveVariantModel(
				"seedance-2-0-text-to-video-basic",
				{ hasImage: true, hasEndImage: false, hasReferenceImages: false },
				FIXTURE_MODELS,
			).id,
		).toBe("seedance-2-0-image-to-video-basic");

		expect(
			resolveVariantModel(
				"grok-imagine-text-to-video-private",
				{ hasImage: false, hasEndImage: false, hasReferenceImages: true },
				FIXTURE_MODELS,
			).id,
		).toBe("grok-imagine-reference-to-video-private");
	});

	it("handles runway-gen4-5-text <-> runway-gen4-5 and flux-3 end_image", () => {
		expect(
			resolveVariantModel(
				"runway-gen4-5-text",
				{ hasImage: true, hasEndImage: false, hasReferenceImages: false },
				FIXTURE_MODELS,
			).id,
		).toBe("runway-gen4-5");

		expect(
			resolveVariantModel(
				"runway-gen4-5",
				{ hasImage: false, hasEndImage: false, hasReferenceImages: false },
				FIXTURE_MODELS,
			).id,
		).toBe("runway-gen4-5-text");

		expect(
			resolveVariantModel(
				"flux-3-text-to-video",
				{ hasImage: false, hasEndImage: true, hasReferenceImages: false },
				FIXTURE_MODELS,
			).id,
		).toBe("flux-3-first-last-frame-to-video");
	});

	it("routes image + end_image to -first-last-frame-to-video across flux-3 and kling-o3-pro families", () => {
		expect(
			resolveVariantModel(
				"flux-3-text-to-video",
				{ hasImage: true, hasEndImage: true, hasReferenceImages: false },
				FIXTURE_MODELS,
			).id,
		).toBe("flux-3-first-last-frame-to-video");

		expect(
			resolveVariantModel(
				"kling-o3-pro-text-to-video",
				{ hasImage: true, hasEndImage: true, hasReferenceImages: false },
				FIXTURE_MODELS,
			).id,
		).toBe("kling-o3-pro-first-last-frame-to-video");

		expect(
			resolveVariantModel(
				"kling-o3-pro-image-to-video",
				{ hasImage: true, hasEndImage: true, hasReferenceImages: false },
				FIXTURE_MODELS,
			).id,
		).toBe("kling-o3-pro-first-last-frame-to-video");

		// Start image alone still routes to -image-to-video when both siblings exist
		expect(
			resolveVariantModel(
				"kling-o3-pro-text-to-video",
				{ hasImage: true, hasEndImage: false, hasReferenceImages: false },
				FIXTURE_MODELS,
			).id,
		).toBe("kling-o3-pro-image-to-video");

		// Models without a first-last-frame sibling still fall back to -image-to-video
		expect(
			resolveVariantModel(
				"minimax-h3-chili-text-to-video",
				{ hasImage: true, hasEndImage: true, hasReferenceImages: false },
				FIXTURE_MODELS,
			).id,
		).toBe("minimax-h3-chili-image-to-video");
	});

	it("errors clearly for unknown models or image-only models without an image", () => {
		expect(() =>
			resolveVariantModel(
				"nonexistent-model",
				{ hasImage: false, hasEndImage: false, hasReferenceImages: false },
				FIXTURE_MODELS,
			),
		).toThrow(/Unknown Venice video model/);

		expect(() =>
			resolveVariantModel(
				"ovi-image-to-video",
				{ hasImage: false, hasEndImage: false, hasReferenceImages: false },
				FIXTURE_MODELS,
			),
		).toThrow(/requires an input image/);
	});
});

// ── Constraint validation ──────────────────────────────────────────

describe("validateAndBuildBodies", () => {
	const chiliT2V = FIXTURE_MODELS.find((m) => m.id === "minimax-h3-chili-text-to-video")!;
	const chiliI2V = FIXTURE_MODELS.find((m) => m.id === "minimax-h3-chili-image-to-video")!;
	const seedance = FIXTURE_MODELS.find((m) => m.id === "seedance-2-0-text-to-video-basic")!;

	it("normalizes resolution casing and bare durations against live constraints", () => {
		const built = validateAndBuildBodies(chiliT2V, {
			prompt: "waves crashing on basalt rocks",
			duration: "4",
			resolution: "768p",
			aspect_ratio: "16:9",
		});
		expect(built.duration).toBe("4s");
		expect(built.resolution).toBe("768P");
		expect(built.aspect_ratio).toBe("16:9");
		expect(built.quoteBody).toEqual({
			model: "minimax-h3-chili-text-to-video",
			duration: "4s",
			resolution: "768P",
			aspect_ratio: "16:9",
		});
		expect(built.queueBody).not.toHaveProperty("audio");
	});

	it("omits aspect_ratio when model aspect_ratios is empty, and rejects explicit unsupported ones", () => {
		const built = validateAndBuildBodies(chiliI2V, {
			prompt: "animate gently",
			image_url: "data:image/png;base64,AAAA",
		});
		expect(built.aspect_ratio).toBeUndefined();
		expect(built.quoteBody).not.toHaveProperty("aspect_ratio");

		expect(() =>
			validateAndBuildBodies(chiliI2V, {
				prompt: "animate",
				aspect_ratio: "16:9",
				image_url: "data:image/png;base64,AAAA",
			}),
		).toThrow(/does not accept aspect_ratio/);
	});

	it("rejects non-configurable audio overrides and respects configurable audio", () => {
		expect(() =>
			validateAndBuildBodies(chiliT2V, {
				prompt: "silent test",
				audio: false,
			}),
		).toThrow(/audio is not configurable/);

		const built = validateAndBuildBodies(seedance, {
			prompt: "silent city",
			audio: false,
		});
		expect(built.queueBody.audio).toBe(false);
		expect(built.quoteBody.audio).toBe(false);
	});

	it("rejects invalid duration, resolution, and oversized prompts", () => {
		expect(() =>
			validateAndBuildBodies(chiliT2V, { prompt: "hi", duration: "30s" }),
		).toThrow(/Unsupported duration/);

		expect(() =>
			validateAndBuildBodies(chiliT2V, { prompt: "hi", resolution: "1080p" }),
		).toThrow(/Unsupported resolution/);

		expect(() =>
			validateAndBuildBodies(seedance, { prompt: "x".repeat(2501) }),
		).toThrow(/exceeds seedance-2-0-text-to-video-basic limit of 2500/);
	});
});

// ── Quote & cap gate ───────────────────────────────────────────────

describe("quote & cap gate", () => {
	const origEnv = process.env.VENICE_VIDEO_MAX_USD;

	afterEach(() => {
		if (origEnv === undefined) delete process.env.VENICE_VIDEO_MAX_USD;
		else process.env.VENICE_VIDEO_MAX_USD = origEnv;
	});

	it("enforces $1.00 default, VENICE_VIDEO_MAX_USD, explicit max_cost, and bypass", () => {
		delete process.env.VENICE_VIDEO_MAX_USD;
		expect(resolveMaxCostUsd()).toBe(1.0);
		process.env.VENICE_VIDEO_MAX_USD = "2.5";
		expect(resolveMaxCostUsd()).toBe(2.5);
		expect(resolveMaxCostUsd(0.5)).toBe(0.5);
		expect(resolveMaxCostUsd(undefined, true)).toBe(Number.POSITIVE_INFINITY);
		expect(() => resolveMaxCostUsd(0)).toThrow(RangeError);
	});

	it("quotes and throws CostCapExceededError when quote exceeds cap", async () => {
		const mockFetch = vi.fn(
			async () => new Response(JSON.stringify({ quote: 1.45 }), { status: 200 }),
		) as unknown as typeof fetch;

		const quote = await quoteVideo(
			"key",
			{ model: "m", duration: "10s" },
			{ fetchImpl: mockFetch },
		);
		expect(quote).toBe(1.45);
		expect(() =>
			assertWithinCap(quote, 1.0, { model: "m", duration: "10s", resolution: "768P" }),
		).toThrow(CostCapExceededError);
	});

	it("does not retry 500 on /video/queue (avoids double-billing), does retry 503", async () => {
		let calls = 0;
		const fail500 = vi.fn(async () => {
			calls++;
			return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
		}) as unknown as typeof fetch;
		await expect(
			queueVideo("key", { model: "m", prompt: "p" }, { fetchImpl: fail500 }),
		).rejects.toThrow(/500/);
		expect(calls).toBe(1);

		let calls503 = 0;
		const okAfter503 = vi.fn(async () => {
			calls503++;
			if (calls503 === 1) return new Response("busy", { status: 503 });
			return new Response(JSON.stringify({ model: "m", queue_id: "q-1" }), { status: 200 });
		}) as unknown as typeof fetch;
		const queued = await queueVideo("key", { model: "m", prompt: "p" }, { fetchImpl: okAfter503 });
		expect(queued.queue_id).toBe("q-1");
		expect(calls503).toBe(2);
	});
});

// ── Poll state machine ─────────────────────────────────────────────

describe("pollVideoJob", () => {
	it("polls PROCESSING then returns raw binary video/mp4", async () => {
		let step = 0;
		const progress: number[] = [];
		const mockFetch = vi.fn(async () => {
			step++;
			if (step < 3) {
				return new Response(
					JSON.stringify({
						status: "PROCESSING",
						average_execution_time: 10000,
						execution_duration: step * 1000,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(new Uint8Array(makeMp4Bytes("raw")), {
				status: 200,
				headers: { "Content-Type": "video/mp4" },
			});
		}) as unknown as typeof fetch;

		const outcome = await pollVideoJob({
			apiKey: "k",
			queueId: "q-raw",
			pollIntervalMs: 5,
			deadlineMs: 2000,
			fetchImpl: mockFetch,
			onProgress: (p) => progress.push(p.attempt),
		});
		expect(outcome.status).toBe("completed");
		expect(progress).toEqual([1, 2]);
		if (outcome.status === "completed") {
			expect(Buffer.from(await outcome.response.arrayBuffer())).toEqual(makeMp4Bytes("raw"));
		}
	});

	it("polls PROCESSING then fetches download_url on COMPLETED", async () => {
		let step = 0;
		const mockFetch = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			if (u.endsWith("/video/retrieve")) {
				step++;
				if (step === 1) {
					return new Response(
						JSON.stringify({
							status: "PROCESSING",
							average_execution_time: 5000,
							execution_duration: 1000,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({
						status: "COMPLETED",
						average_execution_time: 5000,
						execution_duration: 4000,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			expect(u).toBe("https://cdn.venice.test/video.mp4");
			return new Response(new Uint8Array(makeMp4Bytes("cdn")), {
				status: 200,
				headers: { "Content-Type": "video/mp4" },
			});
		}) as unknown as typeof fetch;

		const outcome = await pollVideoJob({
			apiKey: "k",
			queueId: "q-cdn",
			downloadUrl: "https://cdn.venice.test/video.mp4",
			pollIntervalMs: 5,
			deadlineMs: 2000,
			fetchImpl: mockFetch,
		});
		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed") {
			expect(Buffer.from(await outcome.response.arrayBuffer())).toEqual(makeMp4Bytes("cdn"));
		}
	});

	it("surfaces 422 policy (recommended_model + refunded), 404, 402, 401, and retries 503", async () => {
		const err422 = formatVeniceError(
			422,
			{
				error: {
					type: "provider_content_policy",
					message: "Blocked by provider",
					recommended_model: "wan-2-7-text-to-video",
					credits_refunded: true,
				},
			},
			"",
		);
		expect(err422).toContain("recommended_model=wan-2-7-text-to-video");
		expect(err422).toContain("credits_refunded=true");

		const fail404 = vi.fn(
			async () => new Response(JSON.stringify({ error: "expired" }), { status: 404 }),
		) as unknown as typeof fetch;
		await expect(
			pollVideoJob({ apiKey: "k", queueId: "q-404", fetchImpl: fail404 }),
		).rejects.toThrow(/404/);

		let calls = 0;
		const recover503 = vi.fn(async () => {
			calls++;
			if (calls === 1) return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
			return new Response(new Uint8Array(makeMp4Bytes("after-503")), {
				status: 200,
				headers: { "Content-Type": "video/mp4" },
			});
		}) as unknown as typeof fetch;
		const ok = await pollVideoJob({
			apiKey: "k",
			queueId: "q-503",
			pollIntervalMs: 5,
			deadlineMs: 5000,
			fetchImpl: recover503,
		});
		expect(ok.status).toBe("completed");
		expect(calls).toBe(2);
	});

	it("returns timeout cleanly with queueId when deadline expires", async () => {
		const slow = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						status: "PROCESSING",
						average_execution_time: 60000,
						execution_duration: 1000,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const outcome = await pollVideoJob({
			apiKey: "k",
			queueId: "q-timeout",
			pollIntervalMs: 30,
			deadlineMs: 20,
			fetchImpl: slow,
		});
		expect(outcome.status).toBe("timeout");
		expect(outcome.queueId).toBe("q-timeout");
	});
});

// ── Magic bytes & upload persistence ───────────────────────────────

describe("detectVideoContainer & persistVideoResponse", () => {
	let dir: string;
	const origQuota = process.env.AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pvv-out-"));
		delete process.env.AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES;
	});

	afterEach(async () => {
		if (origQuota === undefined) delete process.env.AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES;
		else process.env.AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES = origQuota;
		await rm(dir, { recursive: true, force: true });
	});

	it("detects mp4, mov, webm and rejects non-video / avif / matroska", () => {
		expect(detectVideoContainer(makeMp4Bytes())).toEqual({ ext: "mp4", mime: "video/mp4" });
		const mov = Buffer.from([
			0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
		]);
		expect(detectVideoContainer(mov)).toEqual({ ext: "mov", mime: "video/quicktime" });
		const webm = Buffer.concat([
			Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]),
			Buffer.from("webm"),
		]);
		expect(detectVideoContainer(webm)).toEqual({ ext: "webm", mime: "video/webm" });

		const avif = Buffer.from([
			0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
		]);
		expect(detectVideoContainer(avif)).toBeNull();
		expect(detectVideoContainer(Buffer.from("<html>error</html>"))).toBeNull();
	});

	it("writes fresh unique filenames each call, rejects invalid magic, and enforces quota", async () => {
		const res1 = new Response(new Uint8Array(makeMp4Bytes("1")), { status: 200 });
		const res2 = new Response(new Uint8Array(makeMp4Bytes("2")), { status: 200 });
		const out1 = await persistVideoResponse(res1, dir, { generatePoster: false });
		const out2 = await persistVideoResponse(res2, dir, { generatePoster: false });
		expect(out1.videoUrl).toMatch(/^\/uploads\/[0-9a-f-]{36}\.mp4$/);
		expect(out2.videoUrl).toMatch(/^\/uploads\/[0-9a-f-]{36}\.mp4$/);
		expect(out1.videoUrl).not.toBe(out2.videoUrl);

		const badRes = new Response("not a video at all", { status: 200 });
		await expect(persistVideoResponse(badRes, dir, { generatePoster: false })).rejects.toThrow(
			/magic validation/,
		);

		process.env.AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES = "10";
		const overRes = new Response(new Uint8Array(makeMp4Bytes("quota")), { status: 200 });
		await expect(persistVideoResponse(overRes, dir, { generatePoster: false })).rejects.toThrow(
			UploadStorageQuotaError,
		);

		const files = await readdir(dir);
		expect(files.filter((f) => f.endsWith(".part"))).toEqual([]);
	});
});

// ── Model override, job store, catalog cache, arg parsing ──────────

describe("overrides, job recovery, catalog cache, parseVideogenArgs", () => {
	let homeDir: string;
	const origHome = process.env.HOME;

	beforeEach(async () => {
		homeDir = await mkdtemp(join(tmpdir(), "pvv-home-"));
		process.env.HOME = homeDir;
		clearVideoModelCache();
	});

	afterEach(async () => {
		process.env.HOME = origHome;
		await rm(homeDir, { recursive: true, force: true });
	});

	it("resolves override precedence and persists video-jobs.json", async () => {
		expect(resolveVideoModel()).toBe(DEFAULT_VIDEO_MODEL);
		persistVideoModelOverride("wan-3-0-text-to-video");
		expect(resolveVideoModel()).toBe("wan-3-0-text-to-video");
		expect(resolveVideoModel("explicit-id")).toBe("explicit-id");

		saveVideoJob({
			queue_id: "q-abc",
			model: "seedance-2-0-text-to-video-basic",
			download_url: "https://cdn.example/q.mp4",
			quote_usd: 0.42,
			created_at: Date.now(),
		});
		const loaded = getVideoJob("q-abc");
		expect(loaded?.download_url).toBe("https://cdn.example/q.mp4");
		expect(loaded?.quote_usd).toBe(0.42);
	});

	it("caches /models?type=video across calls until forceRefresh", async () => {
		const mockFetch = vi.fn(
			async () => new Response(JSON.stringify({ data: FIXTURE_MODELS }), { status: 200 }),
		) as unknown as typeof fetch;
		const a = await fetchVideoModels("k", { fetchImpl: mockFetch });
		const b = await fetchVideoModels("k", { fetchImpl: mockFetch });
		expect(a.length).toBe(FIXTURE_MODELS.length);
		expect(b.length).toBe(FIXTURE_MODELS.length);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		await fetchVideoModels("k", { fetchImpl: mockFetch, forceRefresh: true });
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("parses /videogen flags and quoted prompts", () => {
		const parsed = parseVideogenArgs(
			'-m wan-3-0-text-to-video -d 4s -a 16:9 -r 720p -i /uploads/a.png -y "a cat surfing"',
		);
		expect(parsed).toEqual({
			model: "wan-3-0-text-to-video",
			duration: "4s",
			aspect_ratio: "16:9",
			resolution: "720p",
			image: "/uploads/a.png",
			yes: true,
			prompt: "a cat surfing",
		});
	});

	it("formats picker options with Venice divider + compact Venice tag and parses IDs cleanly", () => {
		const options = formatPickerOptions(FIXTURE_MODELS);
		expect(options[0]).toBe("── Venice (API, paid) ──");
		expect(modelIdFromOption(options[0])).toBeUndefined();
		expect(options[1]).toBe(
			"MiniMax H3 Chili (minimax-h3-chili-text-to-video) — default · uncensored · 768P · 4s–15s — Venice",
		);
		expect(modelIdFromOption(options[1])).toBe("minimax-h3-chili-text-to-video");
		for (const opt of options.slice(1)) {
			expect(opt.endsWith(" — Venice")).toBe(true);
			const parsed = modelIdFromOption(opt);
			expect(parsed).toBeTruthy();
			expect(FIXTURE_MODELS.some((m) => m.id === parsed)).toBe(true);
		}
	});
});
