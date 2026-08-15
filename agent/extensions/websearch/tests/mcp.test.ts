import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MAX_RESPONSE_BYTES,
	EXA_TOOL_NAME,
	buildExaRequest,
	parseMcpResponse,
	searchExa,
	type FetchLike,
	type FetchResponse,
} from "../src/mcp";

function response(body: string, status = 200): FetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Bad Request",
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
		const request = buildExaRequest("  latest pi release  ");
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
				arguments: {
					query: "latest pi release",
					type: "auto",
					numResults: 8,
					livecrawl: "fallback",
				},
			},
		});
	});

	test("adds the optional API key to the MCP URL", () => {
		const request = buildExaRequest("query", "secret value");
		expect(request.url).toBe("https://mcp.exa.ai/mcp?exaApiKey=secret+value");
	});

	test("rejects an empty query", () => {
		expect(() => buildExaRequest(" \n ")).toThrow("Search query must not be empty");
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
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "upstream failed" } });
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

describe("searchExa", () => {
	test("sends the request and returns the search text", async () => {
		let capturedUrl = "";
		let capturedBody = "";
		const result = await searchExa("what is new", {
			apiKey: "test-key",
			fetchImpl: async (url, init) => {
				capturedUrl = url;
				capturedBody = init.body;
				return response(successPayload("answer"));
			},
		});

		expect(result).toBe("answer");
		expect(capturedUrl).toBe("https://mcp.exa.ai/mcp?exaApiKey=test-key");
		expect(JSON.parse(capturedBody).params.name).toBe(EXA_TOOL_NAME);
	});

	test("reports HTTP failures", async () => {
		await expect(
			searchExa("query", {
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
			await expect(searchExa("query", { fetchImpl: undefined })).rejects.toThrow("Fetch is unavailable");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
