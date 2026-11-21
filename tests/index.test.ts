import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../extensions/index.js";
import { clearVideoModelCache, getVideoJob, type VeniceVideoModel } from "../extensions/lib.js";

const FIXTURE_MODELS: VeniceVideoModel[] = [
	{
		id: "minimax-h3-chili-text-to-video",
		model_spec: {
			name: "MiniMax H3 Chili",
			constraints: {
				model_type: "text-to-video",
				aspect_ratios: ["16:9"],
				resolutions: ["768P"],
				durations: ["4s", "5s", "10s"],
				audio: true,
				audio_configurable: false,
				prompt_character_limit: 7000,
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

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Route a mocked fetch by URL substring; throw on anything unmocked. */
function routedFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		for (const [suffix, handler] of Object.entries(routes)) {
			if (url.includes(suffix)) return handler(init);
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as unknown as typeof fetch;
}

interface Harness {
	tools: Map<string, any>;
	commands: Map<string, any>;
	notes: any[];
	notify: ReturnType<typeof vi.fn>;
}

function loadExtension(): Harness {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const notes: any[] = [];
	const notify = vi.fn();
	const api = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendMessage: (message: any) => notes.push(message),
	};
	extension(api as never);
	return { tools, commands, notes, notify };
}

describe("venice_generate_video failure results carry the queue_id", () => {
	let homeDir: string;
	let uploadsDir: string;
	const origHome = process.env.HOME;
	const origUploads = process.env.ACB_UPLOADS_DIR;
	const origKey = process.env.VENICE_API_KEY;
	const origQuota = process.env.AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES;

	beforeEach(async () => {
		homeDir = await mkdtemp(join(tmpdir(), "pvv-ext-"));
		uploadsDir = join(homeDir, "uploads");
		process.env.HOME = homeDir;
		process.env.ACB_UPLOADS_DIR = uploadsDir;
		process.env.VENICE_API_KEY = "test-key";
		delete process.env.AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES;
		clearVideoModelCache();
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		process.env.HOME = origHome;
		if (origUploads === undefined) delete process.env.ACB_UPLOADS_DIR;
		else process.env.ACB_UPLOADS_DIR = origUploads;
		if (origKey === undefined) delete process.env.VENICE_API_KEY;
		else process.env.VENICE_API_KEY = origKey;
		if (origQuota === undefined) delete process.env.AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES;
		else process.env.AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES = origQuota;
		await rm(homeDir, { recursive: true, force: true });
	});

	it("names the queued job when the user aborts mid-poll", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			routedFetch({
				"/models?type=video": () => jsonResponse({ data: FIXTURE_MODELS }),
				"/video/quote": () => jsonResponse({ quote: 0.1 }),
				"/video/queue": () =>
					jsonResponse({
						model: "minimax-h3-chili-text-to-video",
						queue_id: "q-abort-123",
						download_url: "https://cdn.example/q.mp4",
					}),
				"/video/retrieve": () => {
					// The job is already paid for; the user cancels while it processes.
					controller.abort();
					return jsonResponse({ status: "PROCESSING", average_execution_time: 60_000 });
				},
			}),
		);

		const { tools } = loadExtension();
		const tool = tools.get("venice_generate_video")!;
		const result = await tool.execute("call-1", { prompt: "a cat surfing" }, controller.signal, undefined, {});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("q-abort-123");
		expect(result.content[0].text).toContain('venice_video_result(queue_id: "q-abort-123")');
		expect(result.details.queue_id).toBe("q-abort-123");
		// The id is only useful if the job itself was persisted for collection.
		expect(getVideoJob("q-abort-123")?.download_url).toBe("https://cdn.example/q.mp4");
	});

	it("names the queued job when saving the downloaded video fails", async () => {
		// A regular file where the uploads directory should be makes mkdir fail.
		const blocker = join(homeDir, "blocker");
		await writeFile(blocker, "not a directory");
		process.env.ACB_UPLOADS_DIR = join(blocker, "uploads");

		vi.stubGlobal(
			"fetch",
			routedFetch({
				"/models?type=video": () => jsonResponse({ data: FIXTURE_MODELS }),
				"/video/quote": () => jsonResponse({ quote: 0.1 }),
				"/video/queue": () =>
					jsonResponse({
						model: "minimax-h3-chili-text-to-video",
						queue_id: "q-persist-456",
						download_url: "https://cdn.example/q.mp4",
					}),
				"/video/retrieve": () =>
					new Response(new Uint8Array(makeMp4Bytes("persist")), {
						status: 200,
						headers: { "Content-Type": "video/mp4" },
					}),
				"/video/complete": () => jsonResponse({}),
			}),
		);

		const { tools } = loadExtension();
		const tool = tools.get("venice_generate_video")!;
		const result = await tool.execute("call-2", { prompt: "a cat surfing" }, undefined, undefined, {});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("q-persist-456");
		expect(result.content[0].text).toContain('venice_video_result(queue_id: "q-persist-456")');
		expect(result.details.queue_id).toBe("q-persist-456");
	});

	it("/videogen names the queued job when saving the downloaded video fails", async () => {
		const blocker = join(homeDir, "blocker");
		await writeFile(blocker, "not a directory");
		process.env.ACB_UPLOADS_DIR = join(blocker, "uploads");

		vi.stubGlobal(
			"fetch",
			routedFetch({
				"/models?type=video": () => jsonResponse({ data: FIXTURE_MODELS }),
				"/video/quote": () => jsonResponse({ quote: 0.1 }),
				"/video/queue": () =>
					jsonResponse({
						model: "minimax-h3-chili-text-to-video",
						queue_id: "q-command-789",
						download_url: "https://cdn.example/q.mp4",
					}),
				"/video/retrieve": () =>
					new Response(new Uint8Array(makeMp4Bytes("command")), {
						status: 200,
						headers: { "Content-Type": "video/mp4" },
					}),
				"/video/complete": () => jsonResponse({}),
			}),
		);

		const { commands, notes, notify } = loadExtension();
		const ctx = { ui: { notify, select: vi.fn() } };
		await commands.get("videogen")!.handler("a cat surfing", ctx);

		const failure = notes.at(-1);
		expect(failure.content).toContain("failed");
		expect(failure.content).toContain("q-command-789");
		expect(failure.details.queue_id).toBe("q-command-789");
	});
});
