import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MAX_RESPONSE_BYTES,
	EXA_TOOL_NAME,
	FIRECRAWL_MCP_URL,
	FIRECRAWL_TOOL_NAME,
	NO_RESULTS,
	PARALLEL_MCP_URL,
	PARALLEL_TOOL_NAME,
	TINYFISH_MCP_URL,
	TINYFISH_TOOL_NAME,
	WEB_SEARCH_PROVIDERS,
	buildExaRequest,
	buildFirecrawlRequest,
	buildParallelRequest,
	buildSearchOutput,
	buildTavilyRequest,
	buildTinyfishRequest,
	checksum,
	formatResultsMarkdown,
	parseExaResults,
	parseFirecrawlResults,
	parseMcpResponse,
	parseParallelResults,
	parseTavilyResults,
	parseTinyfishResults,
	searchExa,
	searchFirecrawl,
	searchParallel,
	searchTavily,
	searchTinyfish,
	searchWithFallback,
	selectWebSearchProvider,
	webSearchProviderOrder,
	type FetchLike,
	type FetchResponse,
} from "../src/mcp";

function response(
	body: string,
	status = 200,
	headers: Record<string, string> = {},
): FetchResponse {
	const normalized = Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
	);
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Bad Request",
		headers: { get: (name) => normalized[name.toLowerCase()] ?? null },
		text: async () => body,
	};
}

function successPayload(text: string, id = 1): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: { content: [{ type: "text", text }] },
	});
}

function structuredPayload(text: string, structuredContent: unknown, id = 1): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: { content: [{ type: "text", text }], structuredContent },
	});
}

function deferredFetch(): {
	fetchImpl: FetchLike;
	resolve: (response: FetchResponse) => void;
	called: boolean;
} {
	let called = false;
	let resolveFn: ((response: FetchResponse) => void) | undefined;
	let rejectFn: ((error: unknown) => void) | undefined;
	const pending = new Promise<FetchResponse>((resolve, reject) => {
		resolveFn = resolve;
		rejectFn = reject;
	});

	const fetchImpl: FetchLike = async (_url, init) => {
		called = true;
		if (init.signal.aborted) {
			throw new DOMException("The operation was aborted.", "AbortError");
		}
		const onAbort = () => {
			rejectFn?.(new DOMException("The operation was aborted.", "AbortError"));
		};
		init.signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await pending;
		} finally {
			init.signal.removeEventListener("abort", onAbort);
		}
	};

	return {
		get called() {
			return called;
		},
		fetchImpl,
		resolve: (value) => resolveFn?.(value),
	};
}

describe("buildExaRequest", () => {
	test("builds the hosted MCP tools/call request", () => {
		const request = buildExaRequest("  latest pi release  ", "");
		const body = JSON.parse(request.init.body);

		expect(request.url).toBe("https://mcp.exa.ai/mcp");
		expect(request.init.method).toBe("POST");
		expect(request.init.headers.Accept).toBe("application/json, text/event-stream");
		expect(body).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: EXA_TOOL_NAME,
				arguments: { query: "latest pi release", numResults: 8 },
			},
		});
	});

	test("adds the optional API key to the MCP URL", () => {
		const request = buildExaRequest("query", "secret value");
		expect(request.url).toBe("https://mcp.exa.ai/mcp?exaApiKey=secret+value");
	});

	test("rejects an empty query", () => {
		expect(() => buildExaRequest(" \n ", "")).toThrow("Search query must not be empty");
	});
});

describe("buildParallelRequest", () => {
	test("builds the Parallel MCP request without session or model", () => {
		const request = buildParallelRequest("hello", "");
		const body = JSON.parse(request.init.body);
		expect(request.url).toBe(PARALLEL_MCP_URL);
		expect(request.init.method).toBe("POST");
		expect(body.params.name).toBe(PARALLEL_TOOL_NAME);
		expect(body.params.arguments).toEqual({
			objective: "hello",
			search_queries: ["hello"],
		});
	});

	test("rejects an empty query", () => {
		expect(() => buildParallelRequest(" \n ", "")).toThrow("Search query must not be empty");
	});

	test("adds Authorization when a key is provided", () => {
		const request = buildParallelRequest("hello", "parallel-key");
		expect(request.init.headers.Authorization).toBe("Bearer parallel-key");
	});

	test("omits Authorization without a key", () => {
		const request = buildParallelRequest("hello", "");
		expect(request.init.headers.Authorization).toBeUndefined();
		expect(request.init.headers["User-Agent"]).toBe("pi");
	});
});

describe("buildFirecrawlRequest", () => {
	test("builds the Firecrawl MCP request", () => {
		const request = buildFirecrawlRequest("hello", "");
		const body = JSON.parse(request.init.body);
		expect(request.url).toBe(FIRECRAWL_MCP_URL);
		expect(body.params.name).toBe(FIRECRAWL_TOOL_NAME);
		expect(body.params.arguments).toEqual({ query: "hello", limit: 8 });
		expect(request.init.headers.Authorization).toBeUndefined();
	});

	test("adds Authorization when a key is provided", () => {
		const request = buildFirecrawlRequest("hello", "fire-key");
		expect(request.init.headers.Authorization).toBe("Bearer fire-key");
	});
});

describe("buildTavilyRequest", () => {
	test("builds the direct REST request with keyless mode", () => {
		const request = buildTavilyRequest("hello", "");
		expect(request.url).toBe("https://api.tavily.com/search");
		expect(request.init.headers["X-Tavily-Access-Mode"]).toBe("keyless");
		expect(request.init.headers.Authorization).toBeUndefined();
		expect(JSON.parse(request.init.body)).toEqual({
			query: "hello",
			search_depth: "basic",
			chunks_per_source: 3,
			max_results: 8,
		});
	});

	test("uses Bearer auth when a key is provided", () => {
		const request = buildTavilyRequest("hello", "tavily-key");
		expect(request.init.headers.Authorization).toBe("Bearer tavily-key");
		expect(request.init.headers["X-Tavily-Access-Mode"]).toBeUndefined();
	});
});

describe("buildTinyfishRequest", () => {
	test("builds a keyless search request", () => {
		const request = buildTinyfishRequest("hello", { apiKey: "" });
		const body = JSON.parse(request.init.body);
		expect(request.url).toBe(TINYFISH_MCP_URL);
		expect(body.params.name).toBe(TINYFISH_TOOL_NAME);
		expect(body.params.arguments).toEqual({ query: "hello" });
		expect(request.init.headers["X-TinyFish-Access-Mode"]).toBe("keyless");
		expect(request.init.headers["Mcp-Session-Id"]).toBeUndefined();
	});

	test("uses X-API-Key and session id for keyed requests", () => {
		const request = buildTinyfishRequest("hello", { apiKey: "tiny-key", sessionId: "sess-1" });
		expect(request.init.headers["X-API-Key"]).toBe("tiny-key");
		expect(request.init.headers["Mcp-Session-Id"]).toBe("sess-1");
		expect(request.init.headers["X-TinyFish-Access-Mode"]).toBeUndefined();
	});
});

describe("checksum / selectWebSearchProvider", () => {
	test("checksum deterministic and matches opencode FNV-1a", () => {
		expect(checksum("hello")).toBe(checksum("hello"));
		expect(checksum("")).toBeUndefined();
		expect(checksum("abc")).toBeDefined();
	});

	test("selects provider deterministically per session id", () => {
		const a = selectWebSearchProvider("session-a");
		const b = selectWebSearchProvider("session-a");
		expect(a).toBe(b);
		expect(["exa", "parallel"]).toContain(a);
	});
});

describe("webSearchProviderOrder", () => {
	test("is deterministic and includes all providers once", () => {
		const a = webSearchProviderOrder("session-a");
		const b = webSearchProviderOrder("session-a");
		expect(a).toEqual(b);
		expect(new Set(a)).toEqual(new Set(WEB_SEARCH_PROVIDERS));
		expect(a).toHaveLength(WEB_SEARCH_PROVIDERS.length);
	});
});

describe("parseMcpResponse", () => {
	test("parses a JSON-RPC response", () => {
		expect(parseMcpResponse(successPayload("search result"))).toBe("search result");
	});

	test("parses an SSE response", () => {
		const body = `event: message\ndata: ${successPayload("streamed result")}\n\ndata: [DONE]\n`;
		expect(parseMcpResponse(body)).toBe("streamed result");
	});

	test("reports JSON-RPC errors", () => {
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -1, message: "upstream failed" },
		});
		expect(() => parseMcpResponse(body)).toThrow("upstream failed");
	});

	test("rejects responses without text content", () => {
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } });
		expect(() => parseMcpResponse(body)).toThrow("no text results");
	});

	test("skips SSE frames with a mismatched JSON-RPC id", () => {
		const body = `event: message\ndata: ${successPayload("decoy", 2)}\n\nevent: message\ndata: ${successPayload("real result")}\n\ndata: [DONE]\n`;
		expect(parseMcpResponse(body)).toBe("real result");
	});
});

describe("result parsers", () => {
	test("parses Exa text blocks", () => {
		const text = [
			[
				"Title: Example",
				"URL: https://example.com/a",
				"Published: 2025-01-02T03:04:05.000Z",
				"Highlights:",
				"First highlight",
			].join("\n"),
			[
				"Title: N/A",
				"URL: https://example.com/b",
				"Published: N/A",
				"Text:",
				"Second body",
			].join("\n"),
			"Title: Missing URL",
		].join("\n\n---\n\n");
		const results = parseExaResults(text);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			url: "https://example.com/a",
			title: "Example",
			content: "First highlight",
			published: "2025-01-02T03:04:05.000Z",
		});
		expect(results[1]).toEqual({
			url: "https://example.com/b",
			content: "Second body",
		});
	});

	test("parses Parallel structuredContent", () => {
		const results = parseParallelResults({
			results: [
				{
					url: "https://parallel.example",
					title: "Parallel result",
					publish_date: "2025-02-03",
					excerpts: ["one", "two"],
				},
				{ title: "No URL" },
			],
		});
		expect(results).toEqual([
			{
				url: "https://parallel.example",
				title: "Parallel result",
				content: "one\n\ntwo",
				published: "2025-02-03T00:00:00.000Z",
			},
		]);
	});

	test("parses Firecrawl JSON content", () => {
		const results = parseFirecrawlResults(
			JSON.stringify({
				success: true,
				data: {
					web: [
						{ url: "https://fire.example", title: "Fire", description: "Fire body" },
						{ title: "No URL" },
					],
				},
			}),
		);
		expect(results).toEqual([
			{ url: "https://fire.example", title: "Fire", content: "Fire body" },
		]);
	});

	test("parses Tavily JSON", () => {
		const results = parseTavilyResults({
			results: [{ title: "Tav", url: "https://tav.example", content: "Tav body" }],
		});
		expect(results).toEqual([
			{ url: "https://tav.example", title: "Tav", content: "Tav body" },
		]);
	});

	test("parses TinyFish JSON", () => {
		const results = parseTinyfishResults(
			JSON.stringify({
				results: [{ url: "https://tiny.example", title: "Tiny", snippet: "Tiny body" }],
			}),
		);
		expect(results).toEqual([
			{ url: "https://tiny.example", title: "Tiny", content: "Tiny body" },
		]);
	});

	test("formats markdown with title, published date, and content", () => {
		const markdown = formatResultsMarkdown([
			{
				url: "https://example.com",
				title: "Example",
				published: "2025-01-02T03:04:05.000Z",
				content: "Body",
			},
			{ url: "https://no-title.example" },
		]);
		expect(markdown).toBe(
			"## [Example](https://example.com)\nPublished: 2025-01-02T03:04:05.000Z\n\nBody\n\n## [https://no-title.example](https://no-title.example)",
		);
	});

	test("returns the upstream NO_RESULTS string for an empty result list", () => {
		expect(formatResultsMarkdown([])).toBe(NO_RESULTS);
	});

	test("markdown output passes through the truncate guard and notice", () => {
		const markdown = formatResultsMarkdown([
			{ url: "https://example.com/a", title: "A", content: "alpha " },
			{ url: "https://example.com/b", title: "B", content: "beta " },
		]);
		const result = buildSearchOutput(
			markdown,
			(text, options) => ({
				content: text.slice(0, options.maxBytes),
				truncated: text.length > options.maxBytes,
			}),
			{ maxLines: 20, maxBytes: 40, sizeLabel: "40 B" },
		);
		expect(result.truncated).toBe(true);
		expect(result.text.startsWith("## [A]")).toBe(true);
		expect(result.text).toContain("[Search output truncated at 40 B or 20 lines.]");
	});
});

describe("searchExa", () => {
	test("sends the request and returns formatted markdown", async () => {
		let capturedUrl = "";
		let capturedBody = "";
		const text = "Title: Result\nURL: https://exa.example\nText:\nExa body";
		const result = await searchExa("what is new", {
			apiKey: "test-key",
			fetchImpl: async (url, init) => {
				capturedUrl = url;
				capturedBody = init.body;
				return response(successPayload(text));
			},
		});

		expect(result).toBe("## [Result](https://exa.example)\n\nExa body");
		expect(capturedUrl).toBe("https://mcp.exa.ai/mcp?exaApiKey=test-key");
		expect(JSON.parse(capturedBody).params.name).toBe(EXA_TOOL_NAME);
	});

	test("falls back to joined MCP text when the block parser finds nothing", async () => {
		await expect(
			searchExa("query", {
				apiKey: "",
				fetchImpl: async () => response(successPayload("plain answer")),
			}),
		).resolves.toBe("plain answer");
	});

	test("reports HTTP failures", async () => {
		await expect(
			searchExa("query", {
				apiKey: "",
				fetchImpl: async () => response("invalid query", 400),
			}),
		).rejects.toThrow("request failed (400 Bad Request): invalid query");
	});

	test("enforces the response size limit", async () => {
		await expect(
			searchExa("query", {
				maxResponseBytes: 4,
				fetchImpl: async () => response("12345"),
			}),
		).rejects.toThrow("exceeded 4 bytes");
		expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(256 * 1024);
	});

	test("rejects an already-aborted signal before fetch", async () => {
		const controller = new AbortController();
		controller.abort();
		const deferred = deferredFetch();

		await expect(
			searchExa("query", {
				signal: controller.signal,
				fetchImpl: deferred.fetchImpl,
			}),
		).rejects.toThrow("Exa web search aborted");
		expect(deferred.called).toBe(false);
	});

	test("rejects when aborted during fetch", async () => {
		const controller = new AbortController();
		const deferred = deferredFetch();
		const pending = searchExa("query", {
			signal: controller.signal,
			fetchImpl: deferred.fetchImpl,
		});
		queueMicrotask(() => controller.abort());

		await expect(pending).rejects.toThrow("Exa web search aborted");
		expect(deferred.called).toBe(true);
	});

	test("rejects when the request times out", async () => {
		const deferred = deferredFetch();

		await expect(
			searchExa("query", {
				timeoutMs: 10,
				fetchImpl: deferred.fetchImpl,
			}),
		).rejects.toThrow("Exa web search timed out after 10ms");
		expect(deferred.called).toBe(true);
	});

	test("rejects a non-positive timeout", async () => {
		await expect(
			searchExa("query", {
				timeoutMs: 0,
				fetchImpl: async () => response(successPayload("unused")),
			}),
		).rejects.toThrow("Search timeout must be greater than zero");
	});

	test("rejects when fetch is unavailable", async () => {
		const originalFetch = globalThis.fetch;
		try {
			// @ts-expect-error -- temporarily remove the platform fetch to hit the guard
			delete globalThis.fetch;
			await expect(searchExa("query", { fetchImpl: undefined })).rejects.toThrow(
				"Fetch is unavailable",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("searchParallel", () => {
	test("parses structuredContent into markdown", async () => {
		let capturedBody = "";
		let capturedHeaders: Record<string, string> = {};
		const structured = {
			results: [
				{
					url: "https://parallel.example",
					title: "Parallel",
					publish_date: "2025-02-03",
					excerpts: ["first", "second"],
				},
			],
		};
		const result = await searchParallel("parallel query", {
			apiKey: "parallel-key",
			fetchImpl: async (_url, init) => {
				capturedBody = init.body;
				capturedHeaders = init.headers;
				return response(structuredPayload("fallback text", structured));
			},
		});

		expect(result).toBe(
			"## [Parallel](https://parallel.example)\nPublished: 2025-02-03T00:00:00.000Z\n\nfirst\n\nsecond",
		);
		expect(capturedHeaders["User-Agent"]).toBe("pi");
		expect(capturedHeaders.Authorization).toBe("Bearer parallel-key");
		const parsed = JSON.parse(capturedBody);
		expect(parsed.params.name).toBe(PARALLEL_TOOL_NAME);
		expect(parsed.params.arguments).toEqual({
			objective: "parallel query",
			search_queries: ["parallel query"],
		});
	});

	test("reports HTTP failures", async () => {
		await expect(
			searchParallel("query", {
				apiKey: "",
				fetchImpl: async () => response("bad", 500),
			}),
		).rejects.toThrow("Parallel web search request failed");
	});

	test("rejects when aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const deferred = deferredFetch();
		await expect(
			searchParallel("query", {
				signal: controller.signal,
				fetchImpl: deferred.fetchImpl,
			}),
		).rejects.toThrow("Parallel web search aborted");
		expect(deferred.called).toBe(false);
	});

	test("rejects when fetch is unavailable", async () => {
		const originalFetch = globalThis.fetch;
		try {
			// @ts-expect-error -- temporarily remove the platform fetch to hit the guard
			delete globalThis.fetch;
			await expect(searchParallel("query", { fetchImpl: undefined })).rejects.toThrow(
				"Fetch is unavailable",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("searchFirecrawl", () => {
	test("parses JSON content into markdown", async () => {
		const text = JSON.stringify({
			success: true,
			data: { web: [{ url: "https://fire.example", title: "Fire", description: "Body" }] },
		});
		const result = await searchFirecrawl("query", {
			apiKey: "",
			fetchImpl: async () => response(successPayload(text)),
		});
		expect(result).toBe("## [Fire](https://fire.example)\n\nBody");
	});

	test("falls back to raw text when parsing yields nothing", async () => {
		await expect(
			searchFirecrawl("query", {
				apiKey: "",
				fetchImpl: async () => response(successPayload("plain firecrawl text")),
			}),
		).resolves.toBe("plain firecrawl text");
	});
});

describe("searchTavily", () => {
	test("parses direct JSON into markdown", async () => {
		let capturedHeaders: Record<string, string> = {};
		const result = await searchTavily("query", {
			apiKey: "",
			fetchImpl: async (_url, init) => {
				capturedHeaders = init.headers;
				return response(
					JSON.stringify({
						results: [{ title: "Tav", url: "https://tav.example", content: "Body" }],
					}),
				);
			},
		});
		expect(result).toBe("## [Tav](https://tav.example)\n\nBody");
		expect(capturedHeaders["X-Tavily-Access-Mode"]).toBe("keyless");
	});

	test("rejects invalid JSON", async () => {
		await expect(
			searchTavily("query", {
				apiKey: "",
				fetchImpl: async () => response("not json"),
			}),
		).rejects.toThrow("Tavily web search returned invalid JSON");
	});
});

describe("searchTinyfish", () => {
	test("uses keyless mode without initialize", async () => {
		let calls = 0;
		const text = JSON.stringify({
			results: [{ url: "https://tiny.example", title: "Tiny", snippet: "Body" }],
		});
		const result = await searchTinyfish("query", {
			apiKey: "",
			fetchImpl: async () => {
				calls += 1;
				return response(successPayload(text));
			},
		});
		expect(result).toBe("## [Tiny](https://tiny.example)\n\nBody");
		expect(calls).toBe(1);
	});

	test("initializes a keyed session and reuses Mcp-Session-Id", async () => {
		const seen: Array<{ method?: string; headers: Record<string, string> }> = [];
		const text = JSON.stringify({
			results: [{ url: "https://tiny.example", title: "Tiny", snippet: "Body" }],
		});
		const result = await searchTinyfish("query", {
			apiKey: "tiny-key",
			fetchImpl: async (_url, init) => {
				const body = JSON.parse(init.body);
				seen.push({ method: body.method, headers: init.headers });
				if (body.method === "initialize") {
					return response("", 200, { "mcp-session-id": "sess-1" });
				}
				if (body.method === "notifications/initialized") return response("");
				return response(successPayload(text));
			},
		});

		expect(result).toBe("## [Tiny](https://tiny.example)\n\nBody");
		expect(seen.map((entry) => entry.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/call",
		]);
		expect(seen[0].headers["X-API-Key"]).toBe("tiny-key");
		expect(seen[2].headers["Mcp-Session-Id"]).toBe("sess-1");
	});

	test("rejects when initialize omits Mcp-Session-Id", async () => {
		await expect(
			searchTinyfish("query", {
				apiKey: "tiny-key",
				fetchImpl: async () => response(""),
			}),
		).rejects.toThrow("did not return an Mcp-Session-Id header");
	});
});

describe("searchWithFallback", () => {
	test("tries providers in order until one succeeds", async () => {
		const sessionID = "fallback-session";
		const order = webSearchProviderOrder(sessionID);
		const seen: string[] = [];

		const result = await searchWithFallback("query", sessionID, async (provider) => {
			seen.push(provider);
			if (provider !== order[2]) throw new Error(`${provider} failed`);
			return `${provider} output`;
		});

		expect(seen).toEqual(order.slice(0, 3));
		expect(result).toEqual({ provider: order[2], output: `${order[2]} output` });
	});

	test("attempts every provider once and throws the last error", async () => {
		const sessionID = "fallback-session";
		const seen: string[] = [];
		const pending = searchWithFallback("query", sessionID, async (provider) => {
			seen.push(provider);
			throw new Error(`${provider} failed`);
		});

		await expect(pending).rejects.toThrow("failed");
		expect(seen).toEqual(webSearchProviderOrder(sessionID));
		expect(new Set(seen).size).toBe(WEB_SEARCH_PROVIDERS.length);
	});

	test("does not fall back after a user abort", async () => {
		const controller = new AbortController();
		const seen: string[] = [];
		const pending = searchWithFallback(
			"query",
			"fallback-session",
			async (provider) => {
				seen.push(provider);
				controller.abort();
				throw new Error("user aborted");
			},
			controller.signal,
		);

		await expect(pending).rejects.toThrow("user aborted");
		expect(seen).toHaveLength(1);
	});
});
