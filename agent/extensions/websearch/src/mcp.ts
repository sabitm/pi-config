const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const EXA_TOOL_NAME = "web_search_exa";
export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
export const PARALLEL_TOOL_NAME = "web_search";
export const EXA_REQUEST_ID = 1;
export const DEFAULT_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export type WebSearchProvider = "exa" | "parallel";

interface ResponseBodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel?(reason?: unknown): Promise<void> | void;
	releaseLock?(): void;
}

interface ResponseBody {
	getReader(): ResponseBodyReader;
}

export interface FetchResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
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

export interface ExaSearchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxResponseBytes?: number;
	apiKey?: string;
	fetchImpl?: FetchLike;
}

export interface ParallelSearchOptions extends ExaSearchOptions {
	sessionId?: string;
	modelName?: string;
}

export interface ExaRequest {
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

export function webSearchModelName(model: unknown): string | undefined {
	if (!model || typeof model !== "object") return undefined;
	const record = model as Record<string, unknown>;
	const api = record.api;
	const apiRecord = api && typeof api === "object" ? (api as Record<string, unknown>) : undefined;
	const apiID = apiRecord && "id" in apiRecord && typeof apiRecord.id === "string" ? apiRecord.id : undefined;
	const id = "id" in record && typeof record.id === "string" ? record.id : undefined;
	return (apiID ?? id)?.slice(0, 100);
}

function parallelAuthHeaders(apiKey = process.env.PARALLEL_API_KEY): Record<string, string> {
	const headers: Record<string, string> = { "User-Agent": "pi" };
	if (apiKey?.trim()) {
		headers.Authorization = `Bearer ${apiKey.trim()}`;
	}
	return headers;
}

export function buildExaRequest(query: string, apiKey = process.env.EXA_API_KEY): ExaRequest {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		throw new Error("Search query must not be empty");
	}

	const url = new URL(EXA_MCP_URL);
	if (apiKey?.trim()) {
		url.searchParams.set("exaApiKey", apiKey.trim());
	}

	return {
		url: url.toString(),
		init: {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: EXA_REQUEST_ID,
				method: "tools/call",
				params: {
					name: EXA_TOOL_NAME,
					arguments: {
						query: trimmedQuery,
						type: "auto",
						numResults: 8,
						livecrawl: "fallback",
					},
				},
			}),
		},
	};
}

export function buildParallelRequest(
	query: string,
	options: { sessionId?: string; modelName?: string; apiKey?: string } = {},
): ExaRequest {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		throw new Error("Search query must not be empty");
	}

	const args: Record<string, unknown> = {
		objective: trimmedQuery,
		search_queries: [trimmedQuery],
	};
	if (options.sessionId) args.session_id = options.sessionId;
	if (options.modelName) args.model_name = options.modelName;

	return {
		url: PARALLEL_MCP_URL,
		init: {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				...parallelAuthHeaders(options.apiKey),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: EXA_REQUEST_ID,
				method: "tools/call",
				params: {
					name: PARALLEL_TOOL_NAME,
					arguments: args,
				},
			}),
		},
	};
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function getMcpText(payload: unknown): string | undefined {
	const envelope = getRecord(payload);
	if (!envelope) return undefined;

	const error = getRecord(envelope.error);
	if (error) {
		const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
		throw new Error(`Web search failed: ${message}`);
	}

	const result = getRecord(envelope.result);
	if (!result) return undefined;
	if (result.isError === true) {
		throw new Error("Web search returned an error result");
	}

	if (!Array.isArray(result.content)) return undefined;
	const texts = result.content
		.map((item) => {
			const content = getRecord(item);
			return typeof content?.text === "string" ? content.text.trim() : "";
		})
		.filter(Boolean);

	return texts.length > 0 ? texts.join("\n\n") : undefined;
}

export function parseMcpResponse(body: string, expectedId = EXA_REQUEST_ID): string {
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
		// Missing/null ids are accepted; a present mismatch is a different RPC reply.
		const id = envelope?.id;
		if (id !== undefined && id !== null && id !== expectedId) {
			continue;
		}
		const text = getMcpText(payload);
		if (text) return text;
	}

	if (parsedPayload) {
		throw new Error("Web search returned no text results");
	}
	throw new Error("Web search returned an invalid MCP response");
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

export async function searchExa(query: string, options: ExaSearchOptions = {}): Promise<string> {
	const request = buildExaRequest(query, options.apiKey);
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
		if (externallyAborted) throw new Error("Exa web search aborted");
		const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal });
		if (timedOut) throw new Error("Exa web search timed out");
		if (externallyAborted || options.signal?.aborted) throw new Error("Exa web search aborted");

		if (!response.ok) {
			let errorBody = "";
			try {
				errorBody = await readResponseBody(response, maxResponseBytes);
			} catch {
				// Preserve the HTTP status when the error body cannot be read.
			}
			const suffix = compactHttpErrorBody(errorBody);
			throw new Error(
				`Exa web search request failed (${response.status} ${response.statusText || "HTTP error"})${suffix ? `: ${suffix}` : ""}`,
			);
		}

		const body = await readResponseBody(response, maxResponseBytes);
		if (timedOut) throw new Error("Exa web search timed out");
		if (externallyAborted || options.signal?.aborted) throw new Error("Exa web search aborted");
		return parseMcpResponse(body, EXA_REQUEST_ID);
	} catch (error) {
		if (timedOut) {
			throw new Error(`Exa web search timed out after ${timeoutMs}ms`);
		}
		if (externallyAborted || options.signal?.aborted) {
			throw new Error("Exa web search aborted");
		}
		if (error instanceof Error) throw error;
		throw new Error(String(error));
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export async function searchParallel(query: string, options: ParallelSearchOptions = {}): Promise<string> {
	const request = buildParallelRequest(query, {
		sessionId: options.sessionId,
		modelName: options.modelName,
		apiKey: options.apiKey,
	});
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
		if (externallyAborted) throw new Error("Parallel web search aborted");
		const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal });
		if (timedOut) throw new Error("Parallel web search timed out");
		if (externallyAborted || options.signal?.aborted) throw new Error("Parallel web search aborted");

		if (!response.ok) {
			let errorBody = "";
			try {
				errorBody = await readResponseBody(response, maxResponseBytes);
			} catch {
				// Preserve the HTTP status when the error body cannot be read.
			}
			const suffix = compactHttpErrorBody(errorBody);
			throw new Error(
				`Parallel web search request failed (${response.status} ${response.statusText || "HTTP error"})${suffix ? `: ${suffix}` : ""}`,
			);
		}

		const body = await readResponseBody(response, maxResponseBytes);
		if (timedOut) throw new Error("Parallel web search timed out");
		if (externallyAborted || options.signal?.aborted) throw new Error("Parallel web search aborted");
		return parseMcpResponse(body, EXA_REQUEST_ID);
	} catch (error) {
		if (timedOut) {
			throw new Error(`Parallel web search timed out after ${timeoutMs}ms`);
		}
		if (externallyAborted || options.signal?.aborted) {
			throw new Error("Parallel web search aborted");
		}
		if (error instanceof Error) throw error;
		throw new Error(String(error));
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
