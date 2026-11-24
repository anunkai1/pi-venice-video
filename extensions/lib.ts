/**
 * pi-venice-video helpers — live catalog + variant resolution, constraint
 * validation, /video/quote cap gate, /video/queue + /video/retrieve polling,
 * magic-byte validation, quota-safe upload persistence, and ffmpeg poster
 * generation.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { open, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	OUTPUT_URL_PREFIX,
	UPLOAD_RESERVATION_PREFIX,
	UploadStorageQuotaError,
	VENICE_BASE,
	ensureOutputDir,
	formatCost,
	getVeniceKey,
	maxUploadStorageBytes,
	resolveInputImageUrl,
	resolveOutputDir,
	sleep,
	uploadStorageUsageBytes,
	withTimeout,
} from "pi-image-core";

export {
	OUTPUT_URL_PREFIX,
	UploadStorageQuotaError,
	VENICE_BASE,
	ensureOutputDir,
	formatCost,
	getVeniceKey,
	maxUploadStorageBytes,
	resolveInputImageUrl,
	resolveOutputDir,
	uploadStorageUsageBytes,
};

// ── Defaults & knobs ───────────────────────────────────────────────

export const DEFAULT_VIDEO_MODEL = "minimax-h3-chili-text-to-video";
export const DEFAULT_VIDEO_DURATION = "5s";
export const DEFAULT_MAX_COST_USD = 1.0;
export const DEFAULT_MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_POLL_DEADLINE_MS = 10 * 60_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
export const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60_000;
export const MAX_TRANSIENT_POLL_ERRORS = 5;

const MAX_SAVED_JOBS = 50;
const JOB_MAX_AGE_MS = 48 * 60 * 60_000;

export function maxVideoBytes(): number {
	const parsed = Number.parseInt(process.env.PI_VIDEO_MAX_BYTES ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_VIDEO_BYTES;
}

export function pollDeadlineMs(): number {
	const parsed = Number.parseInt(process.env.VENICE_VIDEO_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_DEADLINE_MS;
}

export function resolveMaxCostUsd(explicit?: number | null, bypassCap = false): number {
	if (bypassCap) return Number.POSITIVE_INFINITY;
	if (explicit !== undefined && explicit !== null) {
		if (!Number.isFinite(explicit) || explicit <= 0) {
			throw new RangeError(`max_cost must be a positive USD number (got ${explicit})`);
		}
		return explicit;
	}
	const raw = process.env.VENICE_VIDEO_MAX_USD?.trim();
	if (raw && raw.length > 0) {
		const parsed = Number(raw);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			throw new RangeError(`VENICE_VIDEO_MAX_USD must be a positive number (got "${raw}")`);
		}
		return parsed;
	}
	return DEFAULT_MAX_COST_USD;
}

// ── Model override & job recovery store ────────────────────────────

export function videoModelOverrideFile(): string {
	return join(process.env.HOME ?? homedir(), ".config", "acb", "video-model");
}

export function readVideoModelOverride(): string {
	try {
		const file = videoModelOverrideFile();
		if (existsSync(file)) return readFileSync(file, "utf8").trim();
	} catch {
		/* fall through */
	}
	return "";
}

export function persistVideoModelOverride(modelId: string | null): void {
	const file = videoModelOverrideFile();
	mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
	if (modelId === null) {
		rmSync(file, { force: true });
		return;
	}
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${modelId.trim()}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, file);
}

export function resolveVideoModel(explicit?: string | null): string {
	const trimmed = explicit?.trim();
	if (trimmed) return trimmed;
	const override = readVideoModelOverride();
	if (override) return override;
	const fromEnv = process.env.VENICE_VIDEO_MODEL?.trim();
	if (fromEnv) return fromEnv;
	return DEFAULT_VIDEO_MODEL;
}

export interface SavedVideoJob {
	queue_id: string;
	model: string;
	download_url?: string;
	prompt?: string;
	quote_usd?: number;
	duration?: string;
	resolution?: string;
	aspect_ratio?: string;
	created_at: number;
}

export function videoJobsFile(): string {
	return join(process.env.HOME ?? homedir(), ".config", "acb", "video-jobs.json");
}

function readJobsMap(): Record<string, SavedVideoJob> {
	try {
		const file = videoJobsFile();
		if (!existsSync(file)) return {};
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, SavedVideoJob>;
		}
	} catch {
		/* fall through */
	}
	return {};
}

export function saveVideoJob(job: SavedVideoJob): void {
	const file = videoJobsFile();
	mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
	const now = Date.now();
	const current = readJobsMap();
	current[job.queue_id] = job;
	const fresh = Object.values(current)
		.filter((entry) => entry && typeof entry.queue_id === "string" && now - (entry.created_at || 0) < JOB_MAX_AGE_MS)
		.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
		.slice(0, MAX_SAVED_JOBS);
	const out: Record<string, SavedVideoJob> = {};
	for (const entry of fresh) out[entry.queue_id] = entry;
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, file);
}

export function getVideoJob(queueId: string): SavedVideoJob | undefined {
	const map = readJobsMap();
	return map[queueId];
}

// ── Live catalog & constraints ─────────────────────────────────────

export interface VeniceVideoConstraints {
	model_type?: string;
	aspect_ratios?: string[];
	resolutions?: string[];
	durations?: string[];
	audio?: boolean;
	audio_configurable?: boolean;
	audio_input?: boolean;
	per_reference_audio?: boolean;
	video_input?: boolean;
	prompt_character_limit?: number;
	reference_image_min_short_side_pixels?: number;
	reference_image_min_aspect_ratio?: number;
	reference_image_max_aspect_ratio?: number;
}

export interface VeniceVideoModel {
	id: string;
	type?: string;
	model_spec?: {
		name?: string;
		description?: string;
		privacy?: string;
		uncensored?: boolean;
		offline?: boolean;
		model_sets?: string[];
		constraints?: VeniceVideoConstraints;
	};
}

let cachedModels: { at: number; models: VeniceVideoModel[] } | null = null;

export function clearVideoModelCache(): void {
	cachedModels = null;
}

export async function fetchVideoModels(
	apiKey: string,
	options?: { signal?: AbortSignal; forceRefresh?: boolean; fetchImpl?: typeof fetch },
): Promise<VeniceVideoModel[]> {
	const now = Date.now();
	if (!options?.forceRefresh && cachedModels && now - cachedModels.at < DEFAULT_MODEL_CACHE_TTL_MS) {
		return cachedModels.models;
	}
	const f = options?.fetchImpl ?? fetch;
	const res = await f(`${VENICE_BASE}/models?type=video`, {
		method: "GET",
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: withTimeout(options?.signal, DEFAULT_HTTP_TIMEOUT_MS),
	});
	const text = await res.text().catch(() => "");
	if (!res.ok) {
		throw new Error(formatVeniceError(res.status, tryParseJson(text), text, "Venice /models"));
	}
	const parsed = tryParseJson(text) as { data?: unknown } | undefined;
	const list = Array.isArray(parsed?.data) ? (parsed.data as VeniceVideoModel[]) : [];
	if (list.length === 0) {
		throw new Error("Venice /models?type=video returned an empty model list");
	}
	cachedModels = { at: now, models: list };
	return list;
}

// ── Variant resolution ─────────────────────────────────────────────

export interface VideoInputPresence {
	hasImage: boolean;
	hasEndImage: boolean;
	hasReferenceImages: boolean;
}

const MODE_SEGMENT_RE = /-(text|image|reference|video)-to-video(?=$|-)/;

function swapModeSegment(
	id: string,
	target: "text-to-video" | "image-to-video" | "reference-to-video",
): string | null {
	if (MODE_SEGMENT_RE.test(id)) {
		return id.replace(MODE_SEGMENT_RE, `-${target}`);
	}
	return null;
}

export function resolveVariantModel(
	baseModelId: string,
	inputs: VideoInputPresence,
	models: readonly VeniceVideoModel[],
): VeniceVideoModel {
	const byId = new Map(models.map((m) => [m.id, m]));
	const base = byId.get(baseModelId);
	if (!base) {
		const sample = models
			.slice(0, 6)
			.map((m) => m.id)
			.join(", ");
		throw new Error(
			`Unknown Venice video model '${baseModelId}'. Run /videomodel or check live catalog (e.g. ${sample}).`,
		);
	}
	if (base.model_spec?.offline) {
		throw new Error(`Venice video model '${baseModelId}' is currently marked offline.`);
	}

	const targetKind: "text-to-video" | "image-to-video" | "reference-to-video" =
		inputs.hasReferenceImages
			? "reference-to-video"
			: inputs.hasImage || inputs.hasEndImage
				? "image-to-video"
				: "text-to-video";

	if (targetKind === "reference-to-video") {
		if (baseModelId.includes("reference-to-video")) return base;
		const swapped = swapModeSegment(baseModelId, "reference-to-video");
		if (swapped && byId.has(swapped)) return byId.get(swapped)!;
		const appended = `${baseModelId}-reference-to-video`;
		if (byId.has(appended)) return byId.get(appended)!;
		throw new Error(
			`Model '${baseModelId}' has no reference-to-video variant for reference_images.`,
		);
	}

	if (targetKind === "image-to-video") {
		if (inputs.hasEndImage) {
			const flf = baseModelId.replace(
				/-(text|image|reference)-to-video(?=$|-)/,
				"-first-last-frame-to-video",
			);
			if (flf !== baseModelId && byId.has(flf)) {
				return byId.get(flf)!;
			}
		}
		if (base.model_spec?.constraints?.model_type === "image-to-video") return base;
		if (baseModelId === "runway-gen4-5-text" && byId.has("runway-gen4-5")) {
			return byId.get("runway-gen4-5")!;
		}
		const swapped = swapModeSegment(baseModelId, "image-to-video");
		if (swapped && byId.has(swapped)) return byId.get(swapped)!;
		const appended = `${baseModelId}-image-to-video`;
		if (byId.has(appended)) return byId.get(appended)!;
		throw new Error(
			`Model '${baseModelId}' has no image-to-video variant for image/end_image inputs.`,
		);
	}

	// text-to-video
	if (base.model_spec?.constraints?.model_type === "text-to-video") return base;
	if (baseModelId === "runway-gen4-5" && byId.has("runway-gen4-5-text")) {
		return byId.get("runway-gen4-5-text")!;
	}
	const swapped = swapModeSegment(baseModelId, "text-to-video");
	if (swapped && byId.has(swapped)) return byId.get(swapped)!;
	if (base.model_spec?.constraints?.model_type === "image-to-video") {
		throw new Error(
			`Model '${baseModelId}' requires an input image (and has no text-to-video sibling).`,
		);
	}
	if (base.model_spec?.constraints?.model_type === "video") {
		throw new Error(
			`Model '${baseModelId}' is a video-to-video/enhancement model and cannot run text-to-video.`,
		);
	}
	return base;
}

// ── Constraint validation & request builder ────────────────────────

export interface VideoRequestParams {
	prompt: string;
	negative_prompt?: string;
	duration?: string;
	aspect_ratio?: string;
	resolution?: string;
	audio?: boolean;
	image_url?: string;
	end_image_url?: string;
	reference_image_urls?: string[];
}

export interface BuiltVideoBodies {
	model: string;
	duration: string;
	resolution?: string;
	aspect_ratio?: string;
	quoteBody: Record<string, unknown>;
	queueBody: Record<string, unknown>;
}

function matchCaseInsensitive(value: string, allowed: readonly string[]): string | undefined {
	const needle = value.trim().toLowerCase();
	return allowed.find((item) => item.toLowerCase() === needle);
}

function pickDefault(
	allowed: readonly string[] | undefined,
	preferences: readonly string[],
): string | undefined {
	if (!allowed || allowed.length === 0) return undefined;
	for (const pref of preferences) {
		const found = matchCaseInsensitive(pref, allowed);
		if (found) return found;
	}
	return allowed[0];
}

export function validateAndBuildBodies(
	modelEntry: VeniceVideoModel,
	params: VideoRequestParams,
): BuiltVideoBodies {
	const prompt = params.prompt.trim();
	if (!prompt) {
		throw new Error("prompt is required and must be non-empty.");
	}
	const constraints = modelEntry.model_spec?.constraints ?? {};
	if (
		typeof constraints.prompt_character_limit === "number" &&
		prompt.length > constraints.prompt_character_limit
	) {
		throw new Error(
			`Prompt length (${prompt.length} chars) exceeds ${modelEntry.id} limit of ${constraints.prompt_character_limit} chars.`,
		);
	}

	// Duration
	const allowedDurations = constraints.durations ?? [];
	let duration: string;
	if (params.duration !== undefined && params.duration.trim().length > 0) {
		const rawDur = params.duration.trim();
		const normalized = /^\d+$/.test(rawDur) ? `${rawDur}s` : rawDur;
		if (allowedDurations.length > 0) {
			const matched =
				matchCaseInsensitive(rawDur, allowedDurations) ??
				matchCaseInsensitive(normalized, allowedDurations);
			if (!matched) {
				throw new Error(
					`Unsupported duration '${params.duration}' for ${modelEntry.id}. Allowed: ${allowedDurations.join(", ")}.`,
				);
			}
			duration = matched;
		} else {
			duration = normalized;
		}
	} else {
		duration = pickDefault(allowedDurations, [DEFAULT_VIDEO_DURATION, "4s"]) ?? DEFAULT_VIDEO_DURATION;
	}

	// Resolution
	const allowedResolutions = constraints.resolutions ?? [];
	let resolution: string | undefined;
	if (params.resolution !== undefined && params.resolution.trim().length > 0) {
		if (allowedResolutions.length === 0) {
			throw new Error(`Model '${modelEntry.id}' does not accept a resolution parameter.`);
		}
		const matched = matchCaseInsensitive(params.resolution, allowedResolutions);
		if (!matched) {
			throw new Error(
				`Unsupported resolution '${params.resolution}' for ${modelEntry.id}. Allowed: ${allowedResolutions.join(", ")}.`,
			);
		}
		resolution = matched;
	} else if (allowedResolutions.length > 0) {
		resolution = pickDefault(allowedResolutions, ["768P", "720p", "720P", "480p", "480P"]);
	}

	// Aspect ratio
	const allowedAspects = constraints.aspect_ratios ?? [];
	let aspect_ratio: string | undefined;
	if (params.aspect_ratio !== undefined && params.aspect_ratio.trim().length > 0) {
		if (allowedAspects.length === 0) {
			throw new Error(
				`Model '${modelEntry.id}' derives aspect ratio from the input image and does not accept aspect_ratio.`,
			);
		}
		const matched = matchCaseInsensitive(params.aspect_ratio, allowedAspects);
		if (!matched) {
			throw new Error(
				`Unsupported aspect_ratio '${params.aspect_ratio}' for ${modelEntry.id}. Allowed: ${allowedAspects.join(", ")}.`,
			);
		}
		aspect_ratio = matched;
	} else if (allowedAspects.length > 0) {
		aspect_ratio = pickDefault(allowedAspects, ["16:9", "adaptive", "auto"]);
	}

	// Audio
	let audioToSend: boolean | undefined;
	if (params.audio !== undefined) {
		if (constraints.audio_configurable === true) {
			audioToSend = Boolean(params.audio);
		} else if (constraints.audio_configurable === false) {
			const fixed = Boolean(constraints.audio);
			if (Boolean(params.audio) !== fixed) {
				throw new Error(
					`Model '${modelEntry.id}' has fixed audio=${fixed} (audio is not configurable).`,
				);
			}
		} else {
			audioToSend = Boolean(params.audio);
		}
	}

	const quoteBody: Record<string, unknown> = {
		model: modelEntry.id,
		duration,
	};
	if (resolution) quoteBody.resolution = resolution;
	if (aspect_ratio) quoteBody.aspect_ratio = aspect_ratio;
	if (audioToSend !== undefined) quoteBody.audio = audioToSend;
	if (params.image_url) quoteBody.image_url = params.image_url;

	const queueBody: Record<string, unknown> = {
		model: modelEntry.id,
		prompt,
		duration,
	};
	if (resolution) queueBody.resolution = resolution;
	if (aspect_ratio) queueBody.aspect_ratio = aspect_ratio;
	if (audioToSend !== undefined) queueBody.audio = audioToSend;
	if (params.negative_prompt && params.negative_prompt.trim().length > 0) {
		queueBody.negative_prompt = params.negative_prompt.trim();
	}
	if (params.image_url) queueBody.image_url = params.image_url;
	if (params.end_image_url) queueBody.end_image_url = params.end_image_url;
	if (params.reference_image_urls && params.reference_image_urls.length > 0) {
		queueBody.reference_image_urls = params.reference_image_urls;
	}

	return {
		model: modelEntry.id,
		duration,
		resolution,
		aspect_ratio,
		quoteBody,
		queueBody,
	};
}

// ── Input media resolution ─────────────────────────────────────────

export async function resolveVideoInputImage(input: string): Promise<string> {
	const trimmed = input.trim();
	if (trimmed.startsWith(OUTPUT_URL_PREFIX)) {
		const rel = trimmed.slice(OUTPUT_URL_PREFIX.length);
		if (!rel || rel.includes("/") || rel.includes("\\") || rel === "." || rel === "..") {
			throw new Error(`Invalid /uploads/ image path: ${trimmed}`);
		}
	}
	const resolved = await resolveInputImageUrl(trimmed);
	if ("error" in resolved) {
		throw new Error(resolved.error);
	}
	return resolved.url;
}

// ── Error formatting ───────────────────────────────────────────────

export function tryParseJson(text: string): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function formatVeniceError(
	status: number,
	parsed: unknown,
	rawText: string,
	context = "Venice video API",
): string {
	const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	const errVal = obj?.error;
	const errObj =
		errVal && typeof errVal === "object" ? (errVal as Record<string, unknown>) : undefined;

	if (status === 422) {
		const message =
			typeof errObj?.message === "string"
				? errObj.message
				: typeof errVal === "string"
					? errVal
					: rawText || "content policy rejection";
		const recommended =
			typeof errObj?.recommended_model === "string" ? errObj.recommended_model : undefined;
		const refunded =
			typeof errObj?.credits_refunded === "boolean" ? errObj.credits_refunded : undefined;
		const parts = [`${context} 422 (policy): ${message}`];
		if (refunded !== undefined) parts.push(`credits_refunded=${refunded}`);
		if (recommended) parts.push(`recommended_model=${recommended}`);
		return parts.join(" | ");
	}
	if (status === 401) {
		const detail = typeof errVal === "string" ? errVal : rawText || "authentication failed or Pro-only model";
		return `${context} 401 (auth): ${detail}`;
	}
	if (status === 402) {
		const detail =
			typeof errVal === "string"
				? errVal
				: "Insufficient Venice USD or Diem balance. Top up at https://venice.ai/settings/api";
		return `${context} 402 (balance): ${detail}`;
	}
	if (status === 404) {
		const detail = typeof errVal === "string" ? errVal : rawText || "job expired or not found";
		return `${context} 404 (not found): ${detail}`;
	}
	if (status === 409 && errObj?.code === "needs_consent") {
		return `${context} 409 (needs_consent): ${String(errObj.message ?? "provider consent required")}`;
	}
	const detail =
		typeof errVal === "string"
			? errVal
			: typeof errObj?.message === "string"
				? errObj.message
				: rawText
					? rawText.slice(0, 400)
					: `HTTP ${status}`;
	return `${context} ${status}: ${detail}`;
}

// ── Quote, Cap Check, Queue, Retrieve, Complete ────────────────────

export class CostCapExceededError extends Error {
	constructor(
		readonly quoteUsd: number,
		readonly maxCostUsd: number,
		readonly model: string,
		readonly duration: string,
		readonly resolution?: string,
	) {
		super(
			`Quoted cost $${quoteUsd.toFixed(4)} USD exceeds cap $${maxCostUsd.toFixed(2)} USD for ${model} (${duration}${resolution ? `, ${resolution}` : ""}). Raise max_cost / VENICE_VIDEO_MAX_USD or pass -y to /videogen to proceed.`,
		);
		this.name = "CostCapExceededError";
	}
}

export function assertWithinCap(
	quoteUsd: number,
	maxCostUsd: number,
	meta: { model: string; duration: string; resolution?: string },
): void {
	if (quoteUsd > maxCostUsd) {
		throw new CostCapExceededError(quoteUsd, maxCostUsd, meta.model, meta.duration, meta.resolution);
	}
}

export async function quoteVideo(
	apiKey: string,
	quoteBody: Record<string, unknown>,
	options?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<number> {
	const f = options?.fetchImpl ?? fetch;
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= 2; attempt++) {
		const res = await f(`${VENICE_BASE}/video/quote`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(quoteBody),
			signal: withTimeout(options?.signal, DEFAULT_HTTP_TIMEOUT_MS),
		});
		const text = await res.text().catch(() => "");
		const parsed = tryParseJson(text) as { quote?: unknown } | undefined;
		if (res.ok) {
			const quote = parsed?.quote;
			if (typeof quote !== "number" || !Number.isFinite(quote) || quote < 0) {
				throw new Error(`Venice /video/quote returned invalid quote: ${text}`);
			}
			return quote;
		}
		lastError = new Error(formatVeniceError(res.status, parsed, text, "Venice /video/quote"));
		if ((res.status === 429 || res.status === 503) && attempt < 2) {
			await sleep(500 * 2 ** attempt, options?.signal);
			continue;
		}
		throw lastError;
	}
	throw lastError ?? new Error("Venice /video/quote failed");
}

export interface QueueVideoResult {
	model: string;
	queue_id: string;
	download_url?: string;
}

export async function queueVideo(
	apiKey: string,
	queueBody: Record<string, unknown>,
	options?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<QueueVideoResult> {
	const f = options?.fetchImpl ?? fetch;
	let lastError: Error | undefined;
	// Only retry 429/503 (never 500) so we never risk double-billing a queued job.
	for (let attempt = 0; attempt <= 2; attempt++) {
		const res = await f(`${VENICE_BASE}/video/queue`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(queueBody),
			signal: withTimeout(options?.signal, DEFAULT_HTTP_TIMEOUT_MS),
		});
		const text = await res.text().catch(() => "");
		const parsed = tryParseJson(text) as Partial<QueueVideoResult> | undefined;
		if (res.ok) {
			if (typeof parsed?.queue_id !== "string" || parsed.queue_id.length === 0) {
				throw new Error(`Venice /video/queue missing queue_id: ${text}`);
			}
			return {
				model: typeof parsed.model === "string" ? parsed.model : String(queueBody.model),
				queue_id: parsed.queue_id,
				download_url:
					typeof parsed.download_url === "string" && parsed.download_url.length > 0
						? parsed.download_url
						: undefined,
			};
		}
		lastError = new Error(formatVeniceError(res.status, parsed, text, "Venice /video/queue"));
		if ((res.status === 429 || res.status === 503) && attempt < 2) {
			await sleep(1000 * 2 ** attempt, options?.signal);
			continue;
		}
		throw lastError;
	}
	throw lastError ?? new Error("Venice /video/queue failed");
}

export async function completeVideo(
	apiKey: string,
	queueId: string,
	options?: { fetchImpl?: typeof fetch },
): Promise<void> {
	const f = options?.fetchImpl ?? fetch;
	await f(`${VENICE_BASE}/video/complete`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ queue_id: queueId }),
		signal: AbortSignal.timeout(15_000),
	}).catch(() => {});
}

export interface PollProgress {
	queueId: string;
	elapsedMs: number;
	averageExecutionTimeMs?: number;
	executionDurationMs?: number;
	attempt: number;
}

export type PollOutcome =
	| { status: "completed"; response: Response; queueId: string; elapsedMs: number }
	| { status: "timeout"; queueId: string; elapsedMs: number };

export interface PollVideoOptions {
	apiKey: string;
	queueId: string;
	downloadUrl?: string;
	signal?: AbortSignal;
	pollIntervalMs?: number;
	deadlineMs?: number;
	maxTransientErrors?: number;
	fetchImpl?: typeof fetch;
	onProgress?: (progress: PollProgress) => void;
}

const TERMINAL_FAILURE_STATUSES = new Set([
	"FAILED",
	"ERROR",
	"CANCELLED",
	"CANCELED",
	"REJECTED",
	"EXPIRED",
]);

export async function pollVideoJob(opts: PollVideoOptions): Promise<PollOutcome> {
	const f = opts.fetchImpl ?? fetch;
	const intervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const deadlineMs = opts.deadlineMs ?? pollDeadlineMs();
	const maxTransient = opts.maxTransientErrors ?? MAX_TRANSIENT_POLL_ERRORS;
	const started = Date.now();
	const deadline = started + deadlineMs;
	let attempt = 0;
	let transientErrors = 0;

	while (true) {
		if (opts.signal?.aborted) {
			throw new Error(`Aborted while waiting for Venice video job ${opts.queueId}`);
		}
		const now = Date.now();
		if (attempt > 0 && now >= deadline) {
			return { status: "timeout", queueId: opts.queueId, elapsedMs: now - started };
		}
		attempt++;

		let res: Response;
		try {
			res = await f(`${VENICE_BASE}/video/retrieve`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${opts.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					queue_id: opts.queueId,
					delete_media_on_completion: false,
				}),
				// /video/retrieve can stream the raw binary clip inline, so keep the
				// same download timeout budget as download_url fetches.
				signal: withTimeout(opts.signal, DEFAULT_DOWNLOAD_TIMEOUT_MS),
			});
		} catch (err) {
			if (opts.signal?.aborted) {
				throw new Error(`Aborted while waiting for Venice video job ${opts.queueId}`);
			}
			transientErrors++;
			if (transientErrors > maxTransient) {
				throw new Error(
					`Network error polling job ${opts.queueId}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			const backoff = Math.min(30_000, 1_000 * 2 ** (transientErrors - 1));
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				return { status: "timeout", queueId: opts.queueId, elapsedMs: Date.now() - started };
			}
			await sleep(Math.min(backoff, remaining), opts.signal);
			continue;
		}

		if (res.ok) {
			transientErrors = 0;
			const ct = (res.headers.get("content-type") ?? "").toLowerCase();
			if (ct.includes("application/json")) {
				const text = await res.text().catch(() => "");
				const parsed = tryParseJson(text) as
					| {
							status?: string;
							error?: unknown;
							message?: unknown;
							average_execution_time?: number;
							execution_duration?: number;
					  }
					| undefined;
				const status =
					typeof parsed?.status === "string" ? parsed.status.trim().toUpperCase() : undefined;
				if (status === "COMPLETED") {
					if (!opts.downloadUrl) {
						throw new Error(
							`Job ${opts.queueId} completed with status=COMPLETED, but no download_url is available.`,
						);
					}
					const dlRes = await fetchWithRetries(opts.downloadUrl, opts.signal, f);
					return {
						status: "completed",
						response: dlRes,
						queueId: opts.queueId,
						elapsedMs: Date.now() - started,
					};
				}
				if (status && TERMINAL_FAILURE_STATUSES.has(status)) {
					const errObj =
						parsed?.error && typeof parsed.error === "object"
							? (parsed.error as Record<string, unknown>)
							: undefined;
					const detail =
						typeof parsed?.error === "string"
							? parsed.error
							: typeof errObj?.message === "string"
								? errObj.message
								: typeof parsed?.message === "string"
									? parsed.message
									: undefined;
					throw new Error(
						`Venice video job ${opts.queueId} ended with status=${status}${detail ? `: ${detail}` : ""}`,
					);
				}
				opts.onProgress?.({
					queueId: opts.queueId,
					elapsedMs: Date.now() - started,
					averageExecutionTimeMs:
						typeof parsed?.average_execution_time === "number"
							? parsed.average_execution_time
							: undefined,
					executionDurationMs:
						typeof parsed?.execution_duration === "number"
							? parsed.execution_duration
							: undefined,
					attempt,
				});
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					return { status: "timeout", queueId: opts.queueId, elapsedMs: Date.now() - started };
				}
				await sleep(Math.min(intervalMs, remaining), opts.signal);
				continue;
			}
			// Raw binary video stream
			return {
				status: "completed",
				response: res,
				queueId: opts.queueId,
				elapsedMs: Date.now() - started,
			};
		}

		// Non-200 error path
		const text = await res.text().catch(() => "");
		const parsed = tryParseJson(text);
		if (res.status === 503 || res.status === 429) {
			transientErrors++;
			if (transientErrors <= maxTransient) {
				const backoff = Math.min(30_000, 1_000 * 2 ** (transientErrors - 1));
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					return { status: "timeout", queueId: opts.queueId, elapsedMs: Date.now() - started };
				}
				await sleep(Math.min(backoff, remaining), opts.signal);
				continue;
			}
		}
		throw new Error(
			`${formatVeniceError(res.status, parsed, text, "Venice /video/retrieve")} (queue_id=${opts.queueId})`,
		);
	}
}

async function fetchWithRetries(
	url: string,
	signal: AbortSignal | undefined,
	f: typeof fetch,
): Promise<Response> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= 2; attempt++) {
		try {
			const res = await f(url, {
				method: "GET",
				signal: withTimeout(signal, DEFAULT_DOWNLOAD_TIMEOUT_MS),
			});
			if (res.ok) return res;
			lastError = new Error(`Download from Venice download_url failed (${res.status})`);
			if ((res.status === 429 || res.status >= 500) && attempt < 2) {
				await sleep(1000 * 2 ** attempt, signal);
				continue;
			}
			throw lastError;
		} catch (err) {
			if (signal?.aborted) throw err;
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < 2) {
				await sleep(1000 * 2 ** attempt, signal);
				continue;
			}
			throw lastError;
		}
	}
	throw lastError ?? new Error("Download failed");
}

// ── Magic bytes & upload persistence + poster frame ────────────────

export interface DetectedVideoContainer {
	ext: "mp4" | "mov" | "webm";
	mime: "video/mp4" | "video/quicktime" | "video/webm";
}

export function detectVideoContainer(header: Buffer): DetectedVideoContainer | null {
	if (header.length >= 12) {
		const boxSize = header.readUInt32BE(0);
		const atom = header.subarray(4, 8).toString("ascii");
		if (boxSize >= 8 || boxSize === 0 || boxSize === 1) {
			if (atom === "ftyp") {
				const brand = header.subarray(8, 12).toString("ascii");
				if (brand === "qt  ") return { ext: "mov", mime: "video/quicktime" };
				if (brand !== "avif" && brand !== "avis") return { ext: "mp4", mime: "video/mp4" };
			}
			if (["moov", "mdat", "wide", "free", "skip"].includes(atom)) {
				return { ext: "mov", mime: "video/quicktime" };
			}
		}
	}
	if (
		header.length >= 4 &&
		header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
	) {
		const ascii = header.toString("latin1");
		if (ascii.includes("matroska") && !ascii.includes("webm")) return null;
		return { ext: "webm", mime: "video/webm" };
	}
	return null;
}

function reservationOwner(name: string): number | null {
	const match = name.match(/^\.acb-upload-reservation-(\d+)-/);
	if (!match) return null;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

async function withQuotaReservation<T>(
	outputDir: string,
	requiredBytes: number,
	operation: () => Promise<T>,
): Promise<T> {
	const quotaBytes = maxUploadStorageBytes();
	if (quotaBytes === null) return operation();

	for (const entry of await readdir(outputDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const pid = reservationOwner(entry.name);
		if (pid !== null && processIsGone(pid)) {
			await unlink(join(outputDir, entry.name)).catch((err: NodeJS.ErrnoException) => {
				if (err.code !== "ENOENT") throw err;
			});
		}
	}

	const reservation = join(
		outputDir,
		`${UPLOAD_RESERVATION_PREFIX}${process.pid}-${randomUUID()}`,
	);
	const handle = await open(reservation, "wx", 0o600);
	let prepErr: unknown;
	try {
		await handle.truncate(requiredBytes);
	} catch (err) {
		prepErr = err;
	}
	try {
		await handle.close();
	} catch (err) {
		prepErr ??= err;
	}
	if (prepErr) {
		await unlink(reservation).catch(() => {});
		throw prepErr;
	}

	try {
		const allocated = await uploadStorageUsageBytes(outputDir);
		if (allocated > quotaBytes) {
			throw new UploadStorageQuotaError(allocated - requiredBytes, requiredBytes, quotaBytes);
		}
		return await operation();
	} finally {
		await unlink(reservation).catch((err: NodeJS.ErrnoException) => {
			if (err.code !== "ENOENT") throw err;
		});
	}
}

export interface PersistedVideo {
	videoUrl: string;
	videoPath: string;
	posterUrl?: string;
	posterPath?: string;
	mime: string;
	bytes: number;
}

export async function generatePosterFrame(
	videoPath: string,
	outputDir: string,
	baseUuid: string,
): Promise<{ posterUrl: string; posterPath: string } | undefined> {
	const posterName = `${baseUuid}-poster.jpg`;
	const posterTarget = join(outputDir, posterName);
	const posterStaging = join(outputDir, `.${posterName}.${process.pid}.part`);
	try {
		await new Promise<void>((resolve, reject) => {
			const proc = spawn(
				"ffmpeg",
				["-y", "-v", "error", "-i", videoPath, "-frames:v", "1", "-q:v", "3", "-f", "image2", posterStaging],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			const timer = setTimeout(() => {
				proc.kill("SIGKILL");
				reject(new Error("ffmpeg poster timed out"));
			}, 15_000);
			let stderr = "";
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			proc.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
			});
		});
		const info = await stat(posterStaging);
		if (!info.isFile() || info.size === 0) {
			await unlink(posterStaging).catch(() => {});
			return undefined;
		}
		await withQuotaReservation(outputDir, info.size, async () => {
			await rename(posterStaging, posterTarget);
		});
		return { posterUrl: `${OUTPUT_URL_PREFIX}${posterName}`, posterPath: posterTarget };
	} catch {
		await unlink(posterStaging).catch(() => {});
		return undefined;
	}
}

export async function persistVideoResponse(
	res: Response,
	outputDir: string,
	options?: { generatePoster?: boolean },
): Promise<PersistedVideo> {
	ensureOutputDir(outputDir);
	const limit = maxVideoBytes();
	const contentLengthHeader = res.headers.get("content-length");
	if (contentLengthHeader) {
		const declared = Number(contentLengthHeader);
		if (Number.isFinite(declared) && declared > limit) {
			throw new RangeError(`video exceeds PI_VIDEO_MAX_BYTES (${declared} > ${limit})`);
		}
	}

	const id = randomUUID();
	const staging = join(outputDir, `.${id}.video.${process.pid}.part`);
	const handle = await open(staging, "wx", 0o600);
	let totalBytes = 0;
	const headerChunks: Buffer[] = [];
	let headerLen = 0;

	try {
		if (!res.body) {
			const buf = Buffer.from(await res.arrayBuffer());
			totalBytes = buf.length;
			if (totalBytes > limit) {
				throw new RangeError(`video exceeds PI_VIDEO_MAX_BYTES (${totalBytes} > ${limit})`);
			}
			headerChunks.push(buf.subarray(0, 64));
			headerLen = Math.min(64, buf.length);
			await handle.write(buf);
		} else {
			const reader = res.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				totalBytes += value.byteLength;
				if (totalBytes > limit) {
					await reader.cancel().catch(() => {});
					throw new RangeError(`video exceeds PI_VIDEO_MAX_BYTES (${totalBytes} > ${limit})`);
				}
				const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
				if (headerLen < 64) {
					const take = chunk.subarray(0, 64 - headerLen);
					headerChunks.push(take);
					headerLen += take.length;
				}
				await handle.write(chunk);
			}
		}
		await handle.sync();
		await handle.close();

		if (totalBytes === 0) {
			throw new Error("Venice returned an empty video body");
		}
		const header = Buffer.concat(headerChunks);
		const detected = detectVideoContainer(header);
		if (!detected) {
			throw new Error(
				`Venice video response failed container magic validation (first bytes: ${header.subarray(0, 16).toString("hex")})`,
			);
		}

		const finalName = `${id}.${detected.ext}`;
		const target = join(outputDir, finalName);
		await withQuotaReservation(outputDir, totalBytes, async () => {
			await rename(staging, target);
		});

		const poster =
			options?.generatePoster === false
				? undefined
				: await generatePosterFrame(target, outputDir, id);

		return {
			videoUrl: `${OUTPUT_URL_PREFIX}${finalName}`,
			videoPath: target,
			posterUrl: poster?.posterUrl,
			posterPath: poster?.posterPath,
			mime: detected.mime,
			bytes: totalBytes,
		};
	} catch (err) {
		await handle.close().catch(() => {});
		await unlink(staging).catch(() => {});
		throw err;
	}
}
