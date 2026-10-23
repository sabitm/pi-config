const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const EXA_TOOL_NAME = "web_search_exa";
export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
export const PARALLEL_TOOL_NAME = "web_search";
export const FIRECRAWL_MCP_URL = "https://mcp.firecrawl.dev/v2/mcp";
export const FIRECRAWL_TOOL_NAME = "firecrawl_search";
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TINYFISH_MCP_URL = "https://agent.tinyfish.ai/mcp";
export const TINYFISH_TOOL_NAME = "search";
export const EXA_REQUEST_ID = 1;
export const DEFAULT_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const NO_RESULTS = "No search results found. Please try a different query.";

export const WEB_SEARCH_PROVIDERS = ["exa", "parallel", "firecrawl", "tavily", "tinyfish"] as const;

export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export interface WebSearchResult {
	url: string;
	title?: string;
	content?: string;
	published?: string;
}

interface ResponseBodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel?(reason?: unknown): Promise<void> | void;
	releaseLock?(): void;
}

interface ResponseBody {
	getReader(): ResponseBodyReader;
}

interface ResponseHeaders {
	get(name: string): string | null;
}

export interface FetchResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
	readonly headers?: ResponseHeaders | Record<string, string>;
	readonly body?: ResponseBody | null;
	text(): Promise<string>;
}

export interface FetchRequestInit {
	method: "POST";
	headers: Record<string, string>;
	body: string;
	signal: AbortSignal;
}

export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponse>;

export interface WebSearchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxResponseBytes?: number;
	apiKey?: string;
	fetchImpl?: FetchLike;
}

export interface WebSearchRequest {
	url: string;
	init: Omit<FetchRequestInit, "signal">;
}

function textEncoderByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

// FNV-1a 32-bit, same as opencode's checksum (base36)
export function checksum(content: string): string | undefined {
	if (!content) return undefined;
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

export function selectWebSearchProvider(sessionID: string): WebSearchProvider {
	const cs = checksum(sessionID);
	return Number.parseInt(cs ?? "0", 36) % 2 === 0 ? "exa" : "parallel";
}

export function webSearchProviderOrder(sessionID: string): WebSearchProvider[] {
	const cs = checksum(sessionID);
	const start = Number.parseInt(cs ?? "0", 36) % WEB_SEARCH_PROVIDERS.length;
	return [...WEB_SEARCH_PROVIDERS.slice(start), ...WEB_SEARCH_PROVIDERS.slice(0, start)];
}

export async function searchWithFallback(
	query: string,
	sessionID: string,
	search: (provider: WebSearchProvider) => Promise<string>,
	signal?: AbortSignal,
): Promise<{ provider: WebSearchProvider; output: string }> {
	const attempted = new Set<WebSearchProvider>();
	let lastError: unknown;

	for (const provider of webSearchProviderOrder(sessionID)) {
		if (attempted.has(provider)) continue;
		attempted.add(provider);
		if (signal?.aborted) break;
		try {
			return { provider, output: await search(provider) };
		} catch (error) {
			// User abort must not trigger another provider.
			if (signal?.aborted) throw error;
			lastError = error;
		}
	}

	if (lastError instanceof Error) throw lastError;
	throw new Error("Web search aborted");
}

function trimmedQuery(query: string): string {
	const value = query.trim();
	if (!value) throw new Error("Search query must not be empty");
	return value;
}

function mcpRequest(
	url: string,
	tool: string,
	args: Record<string, unknown>,
	headers: Record<string, string> = {},
): WebSearchRequest {
	return {
		url,
		init: {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				...headers,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: EXA_REQUEST_ID,
				method: "tools/call",
				params: { name: tool, arguments: args },
			}),
		},
	};
}

export function buildExaRequest(query: string, apiKey = process.env.EXA_API_KEY): WebSearchRequest {
	const value = trimmedQuery(query);
	const url = new URL(EXA_MCP_URL);
	if (apiKey?.trim()) url.searchParams.set("exaApiKey", apiKey.trim());
	return mcpRequest(url.toString(), EXA_TOOL_NAME, {
		query: value,
		numResults: 8,
	});
}

export function buildParallelRequest(
	query: string,
	apiKey = process.env.PARALLEL_API_KEY,
): WebSearchRequest {
	const value = trimmedQuery(query);
	const headers: Record<string, string> = { "User-Agent": "pi" };
	if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
	return mcpRequest(
		PARALLEL_MCP_URL,
		PARALLEL_TOOL_NAME,
		{ objective: value, search_queries: [value] },
		headers,
	);
}

export function buildFirecrawlRequest(
	query: string,
	apiKey = process.env.FIRECRAWL_API_KEY,
): WebSearchRequest {
	const value = trimmedQuery(query);
	const headers: Record<string, string> = { "User-Agent": "pi" };
	if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
	return mcpRequest(FIRECRAWL_MCP_URL, FIRECRAWL_TOOL_NAME, { query: value, limit: 8 }, headers);
}

export function buildTavilyRequest(
	query: string,
	apiKey = process.env.TAVILY_API_KEY,
): WebSearchRequest {
	const value = trimmedQuery(query);
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
		"User-Agent": "pi",
		"X-Client-Name": "opencode2",
	};
	if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
	else headers["X-Tavily-Access-Mode"] = "keyless";

	return {
		url: TAVILY_SEARCH_URL,
		init: {
			method: "POST",
			headers,
			body: JSON.stringify({
				query: value,
				search_depth: "basic",
				chunks_per_source: 3,
				max_results: 8,
			}),
		},
	};
}

function tinyfishHeaders(apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { "User-Agent": "pi" };
	if (apiKey?.trim()) headers["X-API-Key"] = apiKey.trim();
	else headers["X-TinyFish-Access-Mode"] = "keyless";
	return headers;
}

export function buildTinyfishRequest(
	query: string,
	options: { sessionId?: string; apiKey?: string } = {},
): WebSearchRequest {
	const value = trimmedQuery(query);
	const apiKey = options.apiKey ?? process.env.TINYFISH_API_KEY;
	const headers = tinyfishHeaders(apiKey);
	if (options.sessionId) headers["Mcp-Session-Id"] = options.sessionId;
	return mcpRequest(TINYFISH_MCP_URL, TINYFISH_TOOL_NAME, { query: value }, headers);
}

export function buildTinyfishInitializeRequest(
	apiKey = process.env.TINYFISH_API_KEY,
): WebSearchRequest {
	return {
		url: TINYFISH_MCP_URL,
		init: {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				...tinyfishHeaders(apiKey),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "pi", version: "1.0" },
				},
			}),
		},
	};
}

export function buildTinyfishInitializedNotification(
	sessionId: string,
	apiKey = process.env.TINYFISH_API_KEY,
): WebSearchRequest {
	return {
		url: TINYFISH_MCP_URL,
		init: {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				...tinyfishHeaders(apiKey),
				"Mcp-Session-Id": sessionId,
			},
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		},
	};
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function getMcpTextFromResult(result: Record<string, unknown> | undefined): string | undefined {
	if (!result || !Array.isArray(result.content)) return undefined;
	const texts = result.content
		.map((item) => {
			const content = getRecord(item);
			return typeof content?.text === "string" ? content.text.trim() : "";
		})
		.filter(Boolean);
	return texts.length > 0 ? texts.join("\n\n") : undefined;
}

export function parseMcpResult(
	body: string,
	expectedId = EXA_REQUEST_ID,
): Record<string, unknown> | undefined {
	const trimmed = body.trim();
	const candidates: string[] = [];
	if (trimmed.startsWith("{")) candidates.push(trimmed);

	for (const line of body.split(/\r?\n/)) {
		const match = /^data:\s?(.*)$/.exec(line);
		if (!match) continue;
		const data = match[1].trim();
		if (data && data !== "[DONE]") candidates.push(data);
	}

	let parsedPayload = false;
	for (const candidate of candidates) {
		let payload: unknown;
		try {
			payload = JSON.parse(candidate);
		} catch {
			continue;
		}
		parsedPayload = true;
		const envelope = getRecord(payload);
		if (!envelope) continue;
		// Missing/null ids are accepted; a present mismatch is a different RPC reply.
		const id = envelope.id;
		if (id !== undefined && id !== null && id !== expectedId) continue;

		const error = getRecord(envelope.error);
		if (error) {
			const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
			throw new Error(`Web search failed: ${message}`);
		}

		const result = getRecord(envelope.result);
		if (result?.isError === true) {
			throw new Error("Web search returned an error result");
		}
		return result;
	}

	if (parsedPayload) return undefined;
	throw new Error("Web search returned an invalid MCP response");
}

export function parseMcpResponse(body: string, expectedId = EXA_REQUEST_ID): string {
	const result = parseMcpResult(body, expectedId);
	const text = getMcpTextFromResult(result);
	if (text) return text;
	throw new Error("Web search returned no text results");
}

export async function readResponseBody(response: FetchResponse, maxBytes: number): Promise<string> {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
		throw new Error("Maximum response size must be greater than zero");
	}

	if (!response.body) {
		const body = await response.text();
		if (textEncoderByteLength(body) > maxBytes) {
			throw new Error(`Web search response exceeded ${maxBytes} bytes`);
		}
		return body;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			const value = next.value ?? new Uint8Array();
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				try {
					await reader.cancel?.("response too large");
				} catch {
					// The size error is more useful than a cancellation error.
				}
				throw new Error(`Web search response exceeded ${maxBytes} bytes`);
			}
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} finally {
		reader.releaseLock?.();
	}
}

function compactHttpErrorBody(body: string): string {
	return body.replace(/\s+/g, " ").trim().slice(0, 500);
}

function readHeader(response: FetchResponse, name: string): string | undefined {
	const headers = response.headers;
	if (!headers) return undefined;
	if (typeof (headers as ResponseHeaders).get === "function") {
		return (headers as ResponseHeaders).get(name) ?? undefined;
	}
	const record = headers as Record<string, string>;
	return record[name] ?? record[name.toLowerCase()];
}

async function fetchText(
	label: string,
	request: WebSearchRequest,
	options: WebSearchOptions,
): Promise<{ body: string; response: FetchResponse }> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("Search timeout must be greater than zero");
	}

	const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
	if (!fetchImpl) {
		throw new Error("Fetch is unavailable; cannot perform web search");
	}

	const controller = new AbortController();
	let timedOut = false;
	let externallyAborted = false;
	const onAbort = () => {
		externallyAborted = true;
		controller.abort();
	};
	if (options.signal?.aborted) {
		externallyAborted = true;
		controller.abort();
	} else {
		options.signal?.addEventListener("abort", onAbort, { once: true });
	}

	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		if (externallyAborted) throw new Error(`${label} aborted`);
		const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal });
		if (timedOut) throw new Error(`${label} timed out`);
		if (externallyAborted || options.signal?.aborted) throw new Error(`${label} aborted`);

		if (!response.ok) {
			let errorBody = "";
			try {
				errorBody = await readResponseBody(response, maxResponseBytes);
			} catch {
				// Preserve the HTTP status when the error body cannot be read.
			}
			const suffix = compactHttpErrorBody(errorBody);
			throw new Error(
				`${label} request failed (${response.status} ${response.statusText || "HTTP error"})${suffix ? `: ${suffix}` : ""}`,
			);
		}

		const body = await readResponseBody(response, maxResponseBytes);
		if (timedOut) throw new Error(`${label} timed out`);
		if (externallyAborted || options.signal?.aborted) throw new Error(`${label} aborted`);
		return { body, response };
	} catch (error) {
		if (timedOut) {
			throw new Error(`${label} timed out after ${timeoutMs}ms`);
		}
		if (externallyAborted || options.signal?.aborted) {
			throw new Error(`${label} aborted`);
		}
		if (error instanceof Error) throw error;
		throw new Error(String(error));
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function toIsoDate(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function safeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

export function parseExaResults(text: string): WebSearchResult[] {
	return text.split(/\n\n---\n\n/).flatMap((block) => {
		const url = /^URL:\s*(.+)$/m.exec(block)?.[1]?.trim();
		if (!url) return [];
		const title = /^Title:\s*(.+)$/m.exec(block)?.[1]?.trim();
		const publishedText = /^Published:\s*(.+)$/m.exec(block)?.[1]?.trim();
		const content = /^(?:Highlights|Text):\s*\n?([\s\S]*)$/m.exec(block)?.[1]?.trim();
		const published =
			publishedText && publishedText !== "N/A" ? toIsoDate(publishedText) : undefined;
		return [
			{
				url,
				...(title && title !== "N/A" ? { title } : {}),
				...(content ? { content } : {}),
				...(published ? { published } : {}),
			},
		];
	});
}

export function parseParallelResults(structuredContent: unknown): WebSearchResult[] {
	const results = getRecord(structuredContent)?.results;
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		const result = getRecord(item);
		const url = typeof result?.url === "string" ? result.url : undefined;
		if (!url) return [];
		const title = typeof result?.title === "string" ? result.title : undefined;
		const excerpts = Array.isArray(result?.excerpts)
			? result.excerpts.filter((value): value is string => typeof value === "string")
			: [];
		const published = toIsoDate(result?.publish_date);
		return [
			{
				url,
				...(title ? { title } : {}),
				...(excerpts.length ? { content: excerpts.join("\n\n") } : {}),
				...(published ? { published } : {}),
			},
		];
	});
}

export function parseFirecrawlResults(text: string): WebSearchResult[] {
	const data = getRecord(getRecord(safeJson(text))?.data);
	const web = data?.web;
	if (!Array.isArray(web)) return [];
	return web.flatMap((item) => {
		const result = getRecord(item);
		const url = typeof result?.url === "string" ? result.url : undefined;
		if (!url) return [];
		const title = typeof result?.title === "string" ? result.title : undefined;
		const content = typeof result?.description === "string" ? result.description : undefined;
		return [{ url, ...(title ? { title } : {}), ...(content ? { content } : {}) }];
	});
}

export function parseTavilyResults(payload: unknown): WebSearchResult[] {
	const results = getRecord(payload)?.results;
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		const result = getRecord(item);
		const url = typeof result?.url === "string" ? result.url : undefined;
		if (!url) return [];
		const title = typeof result?.title === "string" ? result.title : undefined;
		const content = typeof result?.content === "string" ? result.content : undefined;
		return [{ url, ...(title ? { title } : {}), ...(content ? { content } : {}) }];
	});
}

export function parseTinyfishResults(text: string): WebSearchResult[] {
	const results = getRecord(safeJson(text))?.results;
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		const result = getRecord(item);
		const url = typeof result?.url === "string" ? result.url : undefined;
		if (!url) return [];
		const title = typeof result?.title === "string" ? result.title : undefined;
		const content = typeof result?.snippet === "string" ? result.snippet : undefined;
		return [{ url, ...(title ? { title } : {}), ...(content ? { content } : {}) }];
	});
}

export function formatResultsMarkdown(results: readonly WebSearchResult[]): string {
	if (results.length === 0) return NO_RESULTS;
	return results
		.map((result) => {
			const title = result.title ?? result.url;
			const published = result.published ? `\nPublished: ${result.published}` : "";
			return `## [${title}](${result.url})${published}${result.content ? `\n\n${result.content}` : ""}`;
		})
		.join("\n\n");
}

export interface SearchOutputLimits {
	maxLines: number;
	maxBytes: number;
	sizeLabel: string;
}

interface TruncationResult {
	content: string;
	truncated: boolean;
}

// Format first, then let the caller's truncate guard cap the final text.
export function buildSearchOutput(
	output: string,
	truncate: (
		text: string,
		options: { maxLines: number; maxBytes: number },
	) => TruncationResult,
	limits: SearchOutputLimits,
): { text: string; truncated: boolean } {
	const truncation = truncate(output, {
		maxLines: limits.maxLines,
		maxBytes: limits.maxBytes,
	});
	const text = truncation.truncated
		? [
				truncation.content,
				`[Search output truncated at ${limits.sizeLabel} or ${limits.maxLines} lines.]`,
		  ]
				.filter(Boolean)
				.join("\n\n")
		: truncation.content;
	return { text, truncated: truncation.truncated };
}

function mcpFallback(result: Record<string, unknown> | undefined, results: WebSearchResult[]): string {
	if (results.length > 0) return formatResultsMarkdown(results);
	return getMcpTextFromResult(result) ?? NO_RESULTS;
}

export async function searchExa(query: string, options: WebSearchOptions = {}): Promise<string> {
	const request = buildExaRequest(query, options.apiKey);
	const { body } = await fetchText("Exa web search", request, options);
	const result = parseMcpResult(body, EXA_REQUEST_ID);
	const text = getMcpTextFromResult(result);
	return mcpFallback(result, text ? parseExaResults(text) : []);
}

export async function searchParallel(query: string, options: WebSearchOptions = {}): Promise<string> {
	const request = buildParallelRequest(query, options.apiKey);
	const { body } = await fetchText("Parallel web search", request, options);
	const result = parseMcpResult(body, EXA_REQUEST_ID);
	const structured = result?.structuredContent;
	return mcpFallback(result, parseParallelResults(structured));
}

export async function searchFirecrawl(query: string, options: WebSearchOptions = {}): Promise<string> {
	const request = buildFirecrawlRequest(query, options.apiKey);
	const { body } = await fetchText("Firecrawl web search", request, options);
	const result = parseMcpResult(body, EXA_REQUEST_ID);
	const text = getMcpTextFromResult(result);
	return mcpFallback(result, text ? parseFirecrawlResults(text) : []);
}

export async function searchTavily(query: string, options: WebSearchOptions = {}): Promise<string> {
	const request = buildTavilyRequest(query, options.apiKey);
	const { body } = await fetchText("Tavily web search", request, options);
	const payload = safeJson(body);
	if (payload === undefined) throw new Error("Tavily web search returned invalid JSON");
	return formatResultsMarkdown(parseTavilyResults(payload));
}

export async function initializeTinyfish(options: WebSearchOptions = {}): Promise<string> {
	const apiKey = options.apiKey ?? process.env.TINYFISH_API_KEY;
	if (!apiKey?.trim()) throw new Error("TinyFish API key required for initialize");

	const { response } = await fetchText(
		"TinyFish initialize",
		buildTinyfishInitializeRequest(apiKey),
		options,
	);
	const sessionId = readHeader(response, "mcp-session-id");
	if (!sessionId) {
		throw new Error("TinyFish MCP initialize did not return an Mcp-Session-Id header");
	}

	await fetchText(
		"TinyFish initialize",
		buildTinyfishInitializedNotification(sessionId, apiKey),
		options,
	);
	return sessionId;
}

export async function searchTinyfish(query: string, options: WebSearchOptions = {}): Promise<string> {
	const apiKey = options.apiKey ?? process.env.TINYFISH_API_KEY;
	const sessionId = apiKey?.trim() ? await initializeTinyfish({ ...options, apiKey }) : undefined;
	const request = buildTinyfishRequest(query, { apiKey, sessionId });
	const { body } = await fetchText("TinyFish web search", request, options);
	const result = parseMcpResult(body, EXA_REQUEST_ID);
	const text = getMcpTextFromResult(result);
	return mcpFallback(result, text ? parseTinyfishResults(text) : []);
}
