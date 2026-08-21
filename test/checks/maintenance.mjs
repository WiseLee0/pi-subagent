#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	maybePruneSubagentRuns,
	pruneSubagentRuns,
} from "../../src/maintenance/prune.ts";
import { writeRunLocator } from "../../src/orchestrate/run-ref.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-01-31T12:00:00.000Z");
const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-subagent-maintenance-test-"));
const indexDir = join(fixtureRoot, "global-index");
const projectDir = join(fixtureRoot, "project");
const runsDir = join(projectDir, ".pi", "agent", "runs");
const envNames = [
	"PI_SUBAGENT_RUN_INDEX_DIR",
	"PI_SUBAGENT_COMPLETED_RETENTION_MS",
	"PI_SUBAGENT_FAILED_RETENTION_MS",
	"PI_SUBAGENT_MAINTENANCE_INTERVAL_MS",
	"PI_SUBAGENT_CHILD",
];
const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

process.env.PI_SUBAGENT_RUN_INDEX_DIR = indexDir;
process.env.PI_SUBAGENT_COMPLETED_RETENTION_MS = String(7 * DAY_MS);
process.env.PI_SUBAGENT_FAILED_RETENTION_MS = String(30 * DAY_MS);
process.env.PI_SUBAGENT_MAINTENANCE_INTERVAL_MS = String(DAY_MS);

async function createRun(runId, status, ageDays, active = false) {
	const runDir = join(runsDir, runId);
	await mkdir(runDir, { recursive: true });
	const completedAt = new Date(now.getTime() - ageDays * DAY_MS).toISOString();
	await writeFile(
		join(runDir, "run.json"),
		`${JSON.stringify(
			{
				schemaVersion: 2,
				runId,
				mode: "single",
				status,
				failureKind: status === "failed" ? "model" : null,
				dependency: null,
				cwd: projectDir,
				runsDir: ".pi/agent/runs",
				startedAt: completedAt,
				updatedAt: completedAt,
				completedAt: active ? null : completedAt,
				activeAttemptId: active ? `attempt_${runId}` : null,
				latestAttemptId: `attempt_${runId}`,
				attempts: [],
			},
			null,
			2,
		)}\n`,
	);
	await writeRunLocator({ runId, cwd: projectDir });
	return runDir;
}

const oldCompleted = await createRun("run_old_completed", "completed", 8);
const recentCompleted = await createRun("run_recent_completed", "completed", 6);
const oldFailed = await createRun("run_old_failed", "failed", 31);
const recentFailed = await createRun("run_recent_failed", "failed", 29);
const running = await createRun("run_running", "running", 90, true);

try {
	const dryRun = await pruneSubagentRuns({ now, dryRun: true });
	assert.equal(dryRun.eligible, 2);
	assert.equal(dryRun.deleted, 0);
	await stat(oldCompleted);
	await stat(oldFailed);

	const pruned = await pruneSubagentRuns({ now });
	assert.equal(pruned.deleted, 2);
	await assert.rejects(stat(oldCompleted), { code: "ENOENT" });
	await assert.rejects(stat(oldFailed), { code: "ENOENT" });
	await stat(recentCompleted);
	await stat(recentFailed);
	await stat(running);

	process.env.PI_SUBAGENT_CHILD = "1";
	const childMaintenance = await maybePruneSubagentRuns({ now });
	assert.equal(childMaintenance.status, "skipped");
	assert.equal(childMaintenance.reason, "child");
	delete process.env.PI_SUBAGENT_CHILD;

	const firstMaintenance = await maybePruneSubagentRuns({ now });
	assert.equal(firstMaintenance.status, "completed");
	const throttled = await maybePruneSubagentRuns({
		now: new Date(now.getTime() + 60_000),
	});
	assert.equal(throttled.status, "skipped");
	assert.equal(throttled.reason, "throttled");
} finally {
	for (const name of envNames) {
		const previous = previousEnv[name];
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
	await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("maintenance checks passed");
