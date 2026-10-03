import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { discoverAgents, formatAgentList } from "../agents.ts";
import { LENGTH_CONTINUATION_PROMPT, type SubagentDetails } from "../src/retry.ts";

const spawnCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
const childBehaviors: Array<(child: MockChild) => void> = [];

class MockChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;
	killSignals: string[] = [];
	pid = 4242;

	kill(signal?: string): boolean {
		this.killed = true;
		if (signal) this.killSignals.push(signal);
		return true;
	}
}

mock.module("node:child_process", () => ({
	spawn: (command: string, args: string[], options?: { cwd?: string }) => {
		spawnCalls.push({ command, args, cwd: options?.cwd });
		const child = new MockChild();
		const behavior = childBehaviors.shift();
		queueMicrotask(() => {
			if (behavior) behavior(child);
			else finish(child, 0, [assistant("done", "stop", usage(1, 1))]);
		});
		return child;
	},
}));

const { default: registerSubagent } = await import("../index.ts");

interface RegisteredTool extends ToolDefinition {
	execute: (...args: Parameters<ToolDefinition["execute"]>) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: SubagentDetails;
		isError?: boolean;
	}>;
}

function usage(
	input: number,
	output: number,
	extra: Partial<{ cacheRead: number; cacheWrite: number; total: number; totalTokens: number }> = {},
) {
	return {
		input,
		output,
		cacheRead: extra.cacheRead ?? 0,
		cacheWrite: extra.cacheWrite ?? 0,
		cost: { total: extra.total ?? 0 },
		totalTokens: extra.totalTokens ?? input + output,
	};
}

function assistant(
	text: string,
	stopReason: string,
	messageUsage: ReturnType<typeof usage>,
	model = "event-model",
) {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
			model,
			usage: messageUsage,
		},
	});
}

function finish(child: MockChild, code: number, lines: string[], stderr = "") {
	if (stderr) child.stderr.emit("data", Buffer.from(stderr));
	if (lines.length > 0) child.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`));
	child.emit("close", code);
}

function registerTool(): RegisteredTool {
	let tool: RegisteredTool | undefined;
	const pi = {
		registerTool(definition: RegisteredTool) {
			tool = definition;
		},
	};
	registerSubagent(pi as unknown as ExtensionAPI);
	if (!tool) throw new Error("subagent tool was not registered");
	return tool;
}

function makeCtx(root: string, overrides: Record<string, unknown> = {}): ExtensionToolContext {
	return {
		cwd: root,
		hasUI: false,
		mode: "print",
		model: { provider: "anthropic", id: "parent-model" },
		thinkingLevel: "high",
		isProjectTrusted: () => false,
		ui: {
			confirm: async () => true,
		},
		...overrides,
	} as unknown as ExtensionToolContext;
}

function writeAgent(dir: string, name: string, frontmatter: string, body = "Prompt body") {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}\n`);
}

let tempRoot: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "user-agent");
	spawnCalls.length = 0;
	childBehaviors.length = 0;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("agent discovery", () => {
	test("real YAML parser returns arrays, objects, and scalars", () => {
		const parsed = parseFrontmatter(`---
name: scout
tools: [read, bash]
model: 12
extra:
  nested: true
---
body`);
		expect(Array.isArray(parsed.frontmatter.tools)).toBe(true);
		expect(parsed.frontmatter.model).toBe(12);
		expect(parsed.frontmatter.extra).toEqual({ nested: true });
	});

	test("accepts comma-separated and array tools, and skips invalid files", () => {
		const userDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "agents");
		writeAgent(userDir, "comma", "name: comma\ndescription: comma tools\ntools: read, grep, find");
		writeAgent(userDir, "array", "name: array\ndescription: array tools\ntools:\n  - read\n  - bash\n  - 7\n  - \"  \"");
		writeAgent(userDir, "bad-tools", "name: bad-tools\ndescription: bad tools\ntools:\n  read: true\n  bash: false");
		writeAgent(userDir, "bad-name", "name:\n  - not-a-string\ndescription: invalid name");
		writeAgent(userDir, "bad-description", "name: bad-description\ndescription:\n  text: not a string");
		writeAgent(userDir, "bad-model", "name: bad-model\ndescription: numeric model\nmodel: 12\ntools: [ls]");
		writeAgent(userDir, "no-frontmatter", "this is not frontmatter");

		const discovered = discoverAgents(tempRoot, "user");
		const byName = new Map(discovered.agents.map((agent) => [agent.name, agent]));

		expect([...byName.keys()].sort()).toEqual(["array", "bad-model", "bad-tools", "comma"]);
		expect(byName.get("comma")?.tools).toEqual(["read", "grep", "find"]);
		expect(byName.get("array")?.tools).toEqual(["read", "bash"]);
		expect(byName.get("bad-tools")?.tools).toBeUndefined();
		expect(byName.get("bad-model")?.model).toBeUndefined();
		expect(byName.get("bad-model")?.tools).toEqual(["ls"]);
		expect(byName.get("comma")?.systemPrompt).toContain("Prompt body");
	});

	test("project agents override user agents only for both scope", () => {
		const userDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "agents");
		const projectDir = path.join(tempRoot, "repo", CONFIG_DIR_NAME, "agents");
		writeAgent(userDir, "shared", "name: shared\ndescription: user copy");
		writeAgent(userDir, "user-only", "name: user-only\ndescription: user only");
		writeAgent(projectDir, "shared", "name: shared\ndescription: project copy");
		writeAgent(projectDir, "project-only", "name: project-only\ndescription: project only");

		const cwd = path.join(tempRoot, "repo", "nested");
		fs.mkdirSync(cwd, { recursive: true });
		const both = discoverAgents(cwd, "both");
		const byName = new Map(both.agents.map((agent) => [agent.name, agent]));

		expect(both.projectAgentsDir).toBe(projectDir);
		expect(byName.get("shared")?.source).toBe("project");
		expect(byName.get("shared")?.description).toBe("project copy");
		expect(byName.get("user-only")?.source).toBe("user");
		expect(byName.get("project-only")?.source).toBe("project");
		expect(discoverAgents(cwd, "user").agents.map((agent) => agent.name).sort()).toEqual(["shared", "user-only"]);
		expect(discoverAgents(cwd, "project").agents.map((agent) => agent.name).sort()).toEqual([
			"project-only",
			"shared",
		]);
		expect(formatAgentList(both.agents, 1).remaining).toBe(2);
	});
});

describe("subagent dispatch", () => {
	test("omitted model inherits parent model and thinking", async () => {
		const userDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "agents");
		writeAgent(userDir, "worker", "name: worker\ndescription: inherits\ntools: read, bash");
		const tool = registerTool();

		const result = await tool.execute(
			"call-1",
			{ agent: "worker", task: "inspect auth", maxRetries: 0 },
			undefined,
			undefined,
			makeCtx(tempRoot),
		);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0].args).toContain("--model");
		expect(spawnCalls[0].args).toContain("anthropic/parent-model");
		expect(spawnCalls[0].args).toContain("--thinking");
		expect(spawnCalls[0].args).toContain("high");
		expect(spawnCalls[0].args.at(-1)).toBe("Task: inspect auth");
		expect(result.details?.results[0].model).toBe("anthropic/parent-model");
		expect(result.details?.results[0].task).toBe("inspect auth");
	});

	test("explicit model stays unchanged and does not inherit thinking", async () => {
		const userDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "agents");
		writeAgent(userDir, "worker", "name: worker\ndescription: pinned\nmodel: openai/child-model");
		const tool = registerTool();

		await tool.execute(
			"call-2",
			{ agent: "worker", task: "review", maxRetries: 0 },
			undefined,
			undefined,
			makeCtx(tempRoot, { thinkingLevel: "off" }),
		);

		const args = spawnCalls[0].args;
		expect(args[args.indexOf("--model") + 1]).toBe("openai/child-model");
		expect(args).not.toContain("--thinking");
		expect(args).not.toContain("anthropic/parent-model");
	});

	test("missing parent model does not invent one and still passes off", async () => {
		const userDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "agents");
		writeAgent(userDir, "worker", "name: worker\ndescription: no model");
		const tool = registerTool();

		const result = await tool.execute(
			"call-3",
			{ agent: "worker", task: "plan", maxRetries: 0 },
			undefined,
			undefined,
			makeCtx(tempRoot, { model: undefined, thinkingLevel: "off" }),
		);

		expect(spawnCalls[0].args).not.toContain("--model");
		expect(spawnCalls[0].args).toContain("--thinking");
		expect(spawnCalls[0].args).toContain("off");
		expect(result.details?.results[0].model).toBe("event-model");
	});

	test("parallel and chain keep the same dispatch defaults", async () => {
		const userDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "agents");
		writeAgent(userDir, "scout", "name: scout\ndescription: no model");
		writeAgent(userDir, "planner", "name: planner\ndescription: pinned\nmodel: openai/planner");
		const tool = registerTool();
		const ctx = makeCtx(tempRoot, { thinkingLevel: "low" });

		await tool.execute(
			"call-4",
			{
				tasks: [
					{ agent: "scout", task: "find models" },
					{ agent: "planner", task: "plan models" },
				],
				maxRetries: 0,
			},
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"call-5",
			{
				chain: [
					{ agent: "scout", task: "find providers" },
					{ agent: "planner", task: "use {previous}" },
				],
				maxRetries: 0,
			},
			undefined,
			undefined,
			ctx,
		);

		const scoutArgs = spawnCalls.filter((call) => call.args.at(-1)?.startsWith("Task: find"));
		const plannerArgs = spawnCalls.filter((call) => call.args.includes("openai/planner"));
		expect(scoutArgs).toHaveLength(2);
		for (const call of scoutArgs) {
			expect(call.args).toContain("anthropic/parent-model");
			expect(call.args).toContain("low");
		}
		expect(plannerArgs).toHaveLength(2);
		for (const call of plannerArgs) {
			expect(call.args).not.toContain("--thinking");
			expect(call.args).not.toContain("anthropic/parent-model");
		}
	});

	test("retries and continuations retain dispatch defaults and sum usage", async () => {
		const userDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "agents");
		writeAgent(userDir, "worker", "name: worker\ndescription: inherits");
		childBehaviors.push((child) => finish(child, 1, [], "temporary failure"));
		childBehaviors.push((child) => {
			finish(child, 0, [
				assistant("first portion", "length", usage(10, 3, { cacheRead: 4, cacheWrite: 5, total: 0.1, totalTokens: 100 })),
			]);
			const sessionDir = spawnCalls.at(-1)?.args[spawnCalls.at(-1)!.args.indexOf("--session-dir") + 1];
			const sessionId = spawnCalls.at(-1)?.args[spawnCalls.at(-1)!.args.indexOf("--session-id") + 1];
			fs.mkdirSync(path.join(sessionDir as string, "nested"), { recursive: true });
			fs.writeFileSync(path.join(sessionDir as string, "nested", `run_${sessionId}.jsonl`), "{}\n");
		});
		childBehaviors.push((child) => {
			finish(child, 0, [
				assistant(
					"second portion",
					"stop",
					usage(20, 7, { cacheRead: 1, cacheWrite: 2, total: 0.25, totalTokens: 250 }),
				),
			]);
		});
		const tool = registerTool();

		const result = await tool.execute(
			"call-6",
			{ agent: "worker", task: "original delegated task", maxRetries: 1, retryDelayMs: 0 },
			undefined,
			undefined,
			makeCtx(tempRoot, { thinkingLevel: "medium" }),
		);

		expect(spawnCalls).toHaveLength(3);
		for (const call of spawnCalls) {
			expect(call.args).toContain("anthropic/parent-model");
			expect(call.args).toContain("medium");
		}
		expect(spawnCalls[0].args.at(-1)).toBe("Task: original delegated task");
		expect(spawnCalls[1].args.at(-1)).toBe("Task: original delegated task");
		expect(spawnCalls[2].args).toContain("--session");
		expect(spawnCalls[2].args.at(-1)).toBe(LENGTH_CONTINUATION_PROMPT);
		const details = result.details?.results[0];
		expect(details?.task).toBe("original delegated task");
		expect(details?.usage).toMatchObject({
			input: 30,
			output: 10,
			cacheRead: 5,
			cacheWrite: 7,
			cost: 0.35,
			turns: 2,
			contextTokens: 250,
		});
		expect(details?.retries).toBeUndefined();
		expect(details?.attempts).toBe(1);
		expect(details?.retryReasons).toBeUndefined();
		expect(details?.continuations).toBe(1);
		expect(result.content[0].text).toContain("first portion");
		expect(result.content[0].text).toContain("second portion");
		expect(result.content[0].text).not.toContain(LENGTH_CONTINUATION_PROMPT);
	});

	test("continuation cap keeps both portions and marks lengthLimited", async () => {
		const userDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "agents");
		writeAgent(userDir, "worker", "name: worker\ndescription: inherits");
		const writeSession = () => {
			const args = spawnCalls.at(-1)?.args ?? [];
			const sessionDir = args[args.indexOf("--session-dir") + 1];
			const sessionId = args[args.indexOf("--session-id") + 1];
			if (!sessionDir || !sessionId) return;
			fs.writeFileSync(path.join(sessionDir, `run_${sessionId}.jsonl`), "{}\n");
		};
		childBehaviors.push((child) => {
			finish(child, 0, [assistant("part one", "length", usage(1, 1, { totalTokens: 10 }))]);
			writeSession();
		});
		childBehaviors.push((child) => {
			finish(child, 0, [assistant("part two", "length", usage(2, 2, { totalTokens: 20 }))]);
		});
		childBehaviors.push((child) => {
			finish(child, 0, [assistant("part three", "length", usage(4, 4, { totalTokens: 40 }))]);
		});
		const tool = registerTool();

		const result = await tool.execute(
			"call-7",
			{ agent: "worker", task: "long task", maxRetries: 0 },
			undefined,
			undefined,
			makeCtx(tempRoot),
		);

		expect(spawnCalls).toHaveLength(3);
		expect(spawnCalls[2].args.at(-1)).toBe(LENGTH_CONTINUATION_PROMPT);
		expect(result.details?.results[0].continuations).toBe(2);
		expect(result.details?.results[0].lengthLimited).toBe(true);
		expect(result.details?.results[0].usage.input).toBe(7);
		expect(result.details?.results[0].usage.contextTokens).toBe(40);
		expect(result.content[0].text).toContain("part one");
		expect(result.content[0].text).toContain("part three");
		expect(result.content[0].text).toContain("continuation cap");
	});

	test("failed continuation preserves earlier usage and output", async () => {
		const userDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "agents");
		writeAgent(userDir, "worker", "name: worker\ndescription: inherits");
		childBehaviors.push((child) => {
			finish(child, 0, [assistant("kept portion", "length", usage(10, 2, { total: 0.5, totalTokens: 80 }))]);
			const args = spawnCalls.at(-1)?.args ?? [];
			const sessionDir = args[args.indexOf("--session-dir") + 1];
			const sessionId = args[args.indexOf("--session-id") + 1];
			fs.writeFileSync(path.join(sessionDir, `run_${sessionId}.jsonl`), "{}\n");
		});
		childBehaviors.push((child) => finish(child, 1, [], "continuation crashed"));
		const tool = registerTool();

		const result = await tool.execute(
			"call-8",
			{ agent: "worker", task: "resume me", maxRetries: 0 },
			undefined,
			undefined,
			makeCtx(tempRoot),
		);

		expect(result.isError).toBe(true);
		expect(result.details?.results[0].usage.input).toBe(10);
		expect(result.details?.results[0].usage.cost).toBe(0.5);
		expect(result.details?.results[0].task).toBe("resume me");
		expect(result.content[0].text).toContain("continuation crashed");
		expect(spawnCalls[1].args).toContain("anthropic/parent-model");
		expect(spawnCalls[1].args.at(-1)).toBe(LENGTH_CONTINUATION_PROMPT);
	});
});

describe("project agent confirmation", () => {
	test("trusted project skips the extra prompt", async () => {
		const projectDir = path.join(tempRoot, CONFIG_DIR_NAME, "agents");
		writeAgent(projectDir, "local", "name: local\ndescription: project agent");
		const tool = registerTool();
		let confirmations = 0;

		await tool.execute(
			"call-9",
			{ agent: "local", task: "run", agentScope: "both", maxRetries: 0 },
			undefined,
			undefined,
			makeCtx(tempRoot, {
				hasUI: true,
				isProjectTrusted: () => true,
				ui: {
					confirm: async () => {
						confirmations += 1;
						return false;
					},
				},
			}),
		);

		expect(confirmations).toBe(0);
		expect(spawnCalls).toHaveLength(1);
	});

	test("untrusted project prompts and respects denial", async () => {
		const projectDir = path.join(tempRoot, CONFIG_DIR_NAME, "agents");
		writeAgent(projectDir, "local", "name: local\ndescription: project agent");
		const tool = registerTool();
		const prompts: string[] = [];

		const denied = await tool.execute(
			"call-10",
			{ agent: "local", task: "run", agentScope: "project" },
			undefined,
			undefined,
			makeCtx(tempRoot, {
				hasUI: true,
				isProjectTrusted: () => false,
				ui: {
					confirm: async (_title: string, message: string) => {
						prompts.push(message);
						return false;
					},
				},
			}),
		);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("local");
		expect(denied.content[0].text).toContain("not approved");
		expect(spawnCalls).toHaveLength(0);
	});

	test("confirmation override and missing UI do not prompt", async () => {
		const projectDir = path.join(tempRoot, CONFIG_DIR_NAME, "agents");
		writeAgent(projectDir, "local", "name: local\ndescription: project agent");
		const tool = registerTool();
		let confirmations = 0;
		const ctx = makeCtx(tempRoot, {
			hasUI: true,
			isProjectTrusted: () => false,
			ui: {
				confirm: async () => {
					confirmations += 1;
					return false;
				},
			},
		});

		await tool.execute(
			"call-11",
			{ agent: "local", task: "run", agentScope: "both", confirmProjectAgents: false, maxRetries: 0 },
			undefined,
			undefined,
			ctx,
		);
		await tool.execute(
			"call-12",
			{ agent: "local", task: "run", agentScope: "both", maxRetries: 0 },
			undefined,
			undefined,
			makeCtx(tempRoot, { hasUI: false, isProjectTrusted: () => false }),
		);

		expect(confirmations).toBe(0);
		expect(spawnCalls).toHaveLength(2);
	});

	test("default scope stays user and ignores a same-named project agent", async () => {
		const userDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "agents");
		const projectDir = path.join(tempRoot, CONFIG_DIR_NAME, "agents");
		writeAgent(userDir, "shared", "name: shared\ndescription: user\nmodel: openai/user-model");
		writeAgent(projectDir, "shared", "name: shared\ndescription: project\nmodel: openai/project-model");
		const tool = registerTool();
		let confirmations = 0;

		await tool.execute(
			"call-13",
			{ agent: "shared", task: "run", maxRetries: 0 },
			undefined,
			undefined,
			makeCtx(tempRoot, {
				hasUI: true,
				isProjectTrusted: () => false,
				ui: {
					confirm: async () => {
						confirmations += 1;
						return false;
					},
				},
			}),
		);

		expect(confirmations).toBe(0);
		expect(spawnCalls[0].args).toContain("openai/user-model");
		expect(spawnCalls[0].args).not.toContain("--thinking");
	});
});
