#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { runPaths } from "../../src/artifacts/registry.ts";
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

	// Automatic retention must use the same terminal validation and physical
	// containment as explicit prune, not a raw recursive rm.
	const activeTask = await createRun("run_active_task", "completed", 90);
	const malformed = await createRun("run_malformed", "completed", 90);
	async function patchRecord(dir, patch) {
		const path = join(dir, "run.json");
		const record = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...record, ...patch }));
	}
	await patchRecord(activeTask, { tasks: [{ taskId: "task_live", status: "running" }] });
	await patchRecord(malformed, { attempts: [{ attemptId: "bad", status: "unknown" }] });
	const outside = join(fixtureRoot, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "keep.txt"), "do not delete");
	const linkedProject = join(fixtureRoot, "linked-project");
	await mkdir(linkedProject);
	await symlink(runsDir, join(linkedProject, "runs"), "dir");
	await writeRunLocator({ runId: "run_recent_completed", cwd: linkedProject, runsDir: "runs" });
	// Another project points outside its physical cwd through an ancestor.
	await symlink(outside, join(projectDir, "external-runs"), "dir");
	await mkdir(join(outside, "run_external"));
	await writeRunLocator({ runId: "run_external", cwd: projectDir, runsDir: "external-runs" });
	await symlink(outside, join(runsDir, "run_symlink"), "dir");
	await writeRunLocator({ runId: "run_symlink", cwd: projectDir });
	await pruneSubagentRuns({ now });
	await stat(activeTask);
	await stat(malformed);
	await stat(join(outside, "keep.txt"));
	await stat(join(outside, "run_external"));
	await stat(recentCompleted);

	// Hold the registry's sibling lock while retention scans an eligible run.
	// A concurrent generation update must be re-read *after* taking that lock.
	const changing = await createRun("run_generation_race", "completed", 90);
	const paths = runPaths({ cwd: projectDir, runId: "run_generation_race" });
	const lockfile = createRequire(import.meta.url)("proper-lockfile");
	const release = await lockfile.lock(paths.runDir, {
		realpath: false, lockfilePath: paths.lockPath, stale: 10_000, retries: 0,
	});
	let settled = false;
	const pending = pruneSubagentRuns({ now }).finally(() => { settled = true; });
	try {
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(settled, false, "maintenance must wait for the per-run lock");
		await stat(changing);
		await patchRecord(changing, { updatedAt: now.toISOString() });
	} finally {
		await release();
		await pending;
	}
	await stat(changing);

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
