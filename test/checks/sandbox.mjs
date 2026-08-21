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
import { createPiAgentSandboxOverlay } from "../../src/sandbox/srt.ts";

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
} finally {
	await overlay.cleanup();
	await rm(fixtureRoot, { recursive: true, force: true });
}
await assert.rejects(stat(overlay.agentDir), { code: "ENOENT" });

console.log("sandbox checks passed");
