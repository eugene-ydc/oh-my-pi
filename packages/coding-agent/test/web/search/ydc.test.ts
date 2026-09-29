import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { buildRequestBody, searchYou, type YouSearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/ydc";
import type { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const catalogAuthStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(catalogAuthStorage);

function requireYdcModel() {
	const model = modelRegistry.find("web", "ydc");
	if (!model) throw new Error("Expected bundled web/ydc model");
	return model;
}

const ydcModel = requireYdcModel();

afterAll(() => {
	catalogAuthStorage.close();
});

describe("You.com buildRequestBody", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("always includes query and count", () => {
		const body = buildRequestBody({ query: "Bun 1.3 release notes", num_results: 7 });
		expect(body.query).toBe("Bun 1.3 release notes");
		expect(body.count).toBe(7);
	});

	it("defaults count to 5 when num_results is unset", () => {
		const body = buildRequestBody({ query: "q" });
		expect(body.count).toBe(5);
	});

	it("omits freshness when recency is unset", () => {
		const body = buildRequestBody({ query: "q" });
		expect(body).not.toHaveProperty("freshness");
	});

	it.each(["day", "week", "month", "year"] as const)("passes %s through as freshness verbatim", recency => {
		const body = buildRequestBody({ query: "q", recency });
		expect(body.freshness).toBe(recency);
	});
});

describe("You.com searchYou request shape (integration)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.YDC_API_KEY;
	});

	const fakeAuthStorage = {
		keys: {
			get: async () => process.env.YDC_API_KEY ?? undefined,
			resolver: vi.fn(() => async () => process.env.YDC_API_KEY ?? undefined),
			source: () => (process.env.YDC_API_KEY ? { kind: "env", concrete: true } : undefined),
		},
	} as unknown as AuthStorage;

	function makeParams(query: string, extras: Partial<YouSearchParams> = {}) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "You.com integration test prompt",
			...extras,
			model: ydcModel,
			modelRegistry,
		};
	}

	it("posts query, count, and freshness with the X-API-Key header", async () => {
		process.env.YDC_API_KEY = "test-ydc-key";

		let capturedUrl: string | undefined;
		let capturedBody: Record<string, unknown> | undefined;
		let capturedApiKey: string | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			capturedUrl =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			capturedBody = JSON.parse(init?.body as string);
			capturedApiKey = new Headers(init?.headers).get("X-API-Key") ?? undefined;
			return new Response(JSON.stringify({ results: { web: [] }, metadata: { search_uuid: "req-0" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchYou({
			...makeParams("Bun runtime latest release notes", { recency: "week" }),
			numSearchResults: 3,
			fetch: fetchMock,
		});

		expect(capturedUrl).toBe("https://ydc-index.io/v1/search");
		expect(capturedApiKey).toBe("test-ydc-key");
		expect(capturedBody).toMatchObject({
			query: "Bun runtime latest release notes",
			count: 3,
			freshness: "week",
		});
	});

	it("omits freshness entirely when recency is not provided", async () => {
		process.env.YDC_API_KEY = "test-ydc-key";

		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ results: {}, metadata: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchYou({ ...makeParams("bun sqlite"), fetch: fetchMock });

		expect(capturedBody).toBeDefined();
		expect(capturedBody).not.toHaveProperty("freshness");
	});
});

describe("You.com web search provider response mapping", () => {
	beforeEach(() => {
		process.env.YDC_API_KEY = "test-ydc-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.YDC_API_KEY;
	});

	const fakeAuthStorage = {
		keys: {
			get: async () => process.env.YDC_API_KEY ?? undefined,
			resolver: vi.fn(() => async () => process.env.YDC_API_KEY ?? undefined),
			source: () => (process.env.YDC_API_KEY ? { kind: "env", concrete: true } : undefined),
		},
	} as unknown as AuthStorage;

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "You.com test prompt",
			model: ydcModel,
			modelRegistry,
		} as const;
	}

	it("maps web and news results into a unified SearchResponse", async () => {
		const fetchMock = async (): Promise<Response> =>
			new Response(
				JSON.stringify({
					results: {
						web: [
							{
								title: "Result One",
								url: "https://example.com/one",
								description: "First description",
								snippets: ["snippet a", "snippet b"],
								page_age: "2026-03-01T00:00:00Z",
								authors: ["Jane Doe"],
							},
							{ url: "https://example.com/two", description: "Second description" },
							{ title: "No URL", description: "dropped" },
						],
						news: [
							{
								title: "News One",
								url: "https://news.example.com/n1",
								description: "News description",
								page_age: "2026-05-01T00:00:00Z",
							},
						],
					},
					metadata: { search_uuid: "req-ydc-123", query: "latest ai" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchYou({
			...makeParams("latest ai"),
			numSearchResults: 5,
			fetch: fetchMock,
		});

		expect(response.provider).toBe("ydc");
		expect(response.authMode).toBe("api_key");
		expect(response.requestId).toBe("req-ydc-123");
		// URL-less result is dropped; web results precede news results.
		expect(response.sources).toMatchObject([
			{
				title: "Result One",
				url: "https://example.com/one",
				snippet: "First description\nsnippet a\nsnippet b",
				publishedDate: "2026-03-01T00:00:00Z",
				author: "Jane Doe",
			},
			{
				title: "https://example.com/two",
				url: "https://example.com/two",
				snippet: "Second description",
			},
			{
				title: "News One",
				url: "https://news.example.com/n1",
				snippet: "News description",
				publishedDate: "2026-05-01T00:00:00Z",
			},
		]);
		expect(response.sources[0]?.ageSeconds).toBeTypeOf("number");
	});

	it("slices combined web and news results to numSearchResults", async () => {
		const fetchMock = async (): Promise<Response> =>
			new Response(
				JSON.stringify({
					results: {
						web: [
							{ title: "W1", url: "https://example.com/w1" },
							{ title: "W2", url: "https://example.com/w2" },
						],
						news: [{ title: "N1", url: "https://news.example.com/n1" }],
					},
					metadata: {},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const response = await searchYou({
			...makeParams("bounded"),
			numSearchResults: 2,
			fetch: fetchMock,
		});

		expect(response.sources.map(s => s.url)).toEqual(["https://example.com/w1", "https://example.com/w2"]);
	});

	it("surfaces structured API errors", async () => {
		const fetchMock = (): Promise<Response> =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "invalid api key" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				}),
			);

		await expect(searchYou({ ...makeParams("bad auth"), fetch: fetchMock })).rejects.toEqual(
			expect.objectContaining({
				provider: "ydc",
				status: 403,
			}) satisfies Partial<SearchProviderError>,
		);
	});

	it("throws a clear error when You.com credentials are missing", async () => {
		delete process.env.YDC_API_KEY;
		await expect(searchYou(makeParams("missing creds"))).rejects.toThrow(
			'You.com credentials not found. Set YDC_API_KEY or configure an API key for provider "ydc".',
		);
	});
});
