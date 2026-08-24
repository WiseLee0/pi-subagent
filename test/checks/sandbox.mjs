#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxAllowedDomains } from "../../src/core/constants.ts";
import { resolveModelProviderDomains } from "../../src/sandbox/model-network.ts";
import {
	createPiAgentSandboxOverlay,
	mergePiAgentSandboxEnv,
} from "../../src/sandbox/srt.ts";

assert.deepEqual(
	resolveModelProviderDomains({ env: { PI_PROVIDER: "openai-codex" } }),
	["chatgpt.com", "auth.openai.com"],
);
assert.deepEqual(
	resolveModelProviderDomains({
		model: "anthropic/claude-sonnet-4-5",
		env: { PI_PROVIDER: "openai-codex" },
	}),
	["api.anthropic.com"],
);
assert.deepEqual(
	resolveModelProviderDomains({ env: { PI_PROVIDER: "custom-provider" } }),
	[],
);
assert.deepEqual(
	sandboxAllowedDomains(
		{ allowedDomains: ["github.com", "chatgpt.com"] },
		["chatgpt.com"],
	),
	["chatgpt.com", "github.com"],
);

const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-subagent-sandbox-test-"));
const sourceAgentDir = join(fixtureRoot, "agent");
await mkdir(join(sourceAgentDir, "skills"), { recursive: true });
await writeFile(join(sourceAgentDir, "settings.json"), '{"theme":"dark"}\n');
await writeFile(join(sourceAgentDir, "skills", "example.md"), "example\n");
await mkdir(join(sourceAgentDir, "stale.lock"));

const overlay = await createPiAgentSandboxOverlay({
	PI_CODING_AGENT_DIR: sourceAgentDir,
});
try {
	assert.equal(overlay.env.PI_CODING_AGENT_DIR, overlay.agentDir);
	assert.equal(
		await readFile(join(overlay.agentDir, "settings.json"), "utf8"),
		'{"theme":"dark"}\n',
	);
	assert.equal((await lstat(join(overlay.agentDir, "skills"))).isSymbolicLink(), true);
	await assert.rejects(stat(join(overlay.agentDir, "stale.lock")), { code: "ENOENT" });

	await writeFile(join(overlay.agentDir, "settings.json"), '{"theme":"light"}\n');
	assert.equal(
		await readFile(join(sourceAgentDir, "settings.json"), "utf8"),
		'{"theme":"dark"}\n',
	);

	const mergedEnv = mergePiAgentSandboxEnv(
		{
			PI_CODING_AGENT_DIR: overlay.agentDir,
			CHILD_ONLY: "child",
			PRECEDENCE: "child",
		},
		{
			PI_CODING_AGENT_DIR: sourceAgentDir,
			SANDBOX_ONLY: "sandbox",
			PRECEDENCE: "sandbox",
		},
		overlay,
		{ ATTEMPT_ONLY: "attempt", PRECEDENCE: "attempt" },
	);
	assert.equal(mergedEnv.PI_CODING_AGENT_DIR, overlay.agentDir);
	assert.equal(mergedEnv.CHILD_ONLY, "child");
	assert.equal(mergedEnv.SANDBOX_ONLY, "sandbox");
	assert.equal(mergedEnv.ATTEMPT_ONLY, "attempt");
	assert.equal(mergedEnv.PRECEDENCE, "attempt");
} finally {
	await overlay.cleanup();
	await rm(fixtureRoot, { recursive: true, force: true });
}
await assert.rejects(stat(overlay.agentDir), { code: "ENOENT" });

console.log("sandbox checks passed");
