import { createRequire } from "node:module";
import {
	lstat,
	mkdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { readRunRecord, removeRunIfStill, runPaths } from "../artifacts/registry.ts";
import { isFullyTerminalRunRecord, removeLocatorIfOwned, resolvePhysicalRunsDir } from "../orchestrate/prune.ts";
import { PI_SUBAGENT_CHILD_ENV } from "../core/environment.ts";
import {
	listRunLocators,
	locatorOlderThanPruneThreshold,
	removeRunLocator,
	runLocatorIndexDir,
} from "../orchestrate/run-ref.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = DAY_MS;
const DEFAULT_COMPLETED_RETENTION_MS = 7 * DAY_MS;
const DEFAULT_FAILED_RETENTION_MS = 30 * DAY_MS;
const MAINTENANCE_LOCK_STALE_MS = 10 * 60 * 1000;
const MAINTENANCE_STATE_VERSION = 1 as const;

const properLockfile = createRequire(import.meta.url)("proper-lockfile") as {
	lock(
		file: string,
		options: {
			realpath: boolean;
			lockfilePath: string;
			stale: number;
			update: number;
			retries: number;
		},
	): Promise<() => Promise<void>>;
};

interface MaintenanceState {
	schemaVersion: typeof MAINTENANCE_STATE_VERSION;
	lastRunAt: string;
}

export interface PruneSubagentRunsOptions {
	now?: Date;
	dryRun?: boolean;
}

export interface PruneSubagentRunsResult {
	status: "completed" | "skipped";
	reason?: "child" | "disabled" | "throttled" | "locked";
	scanned: number;
	eligible: number;
	deleted: number;
	missingLocatorsDeleted: number;
	activeSkipped: number;
	retained: number;
	invalid: number;
	errors: number;
}

function configuredDuration(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function retentionMs(status: string): number | null {
	if (status === "completed")
		return configuredDuration(
			"PI_SUBAGENT_COMPLETED_RETENTION_MS",
			DEFAULT_COMPLETED_RETENTION_MS,
		);
	if (status === "failed" || status === "cancelled")
		return configuredDuration(
			"PI_SUBAGENT_FAILED_RETENTION_MS",
			DEFAULT_FAILED_RETENTION_MS,
		);
	return null;
}

function emptyResult(
	status: PruneSubagentRunsResult["status"] = "completed",
): PruneSubagentRunsResult {
	return {
		status,
		scanned: 0,
		eligible: 0,
		deleted: 0,
		missingLocatorsDeleted: 0,
		activeSkipped: 0,
		retained: 0,
		invalid: 0,
		errors: 0,
	};
}

export async function pruneSubagentRuns(
	options: PruneSubagentRunsOptions = {},
): Promise<PruneSubagentRunsResult> {
	const now = options.now ?? new Date();
	const nowMs = now.getTime();
	const result = emptyResult();
	const scanStartedAt = Date.now();
	const { locators, invalidCount } = await listRunLocators();
	result.invalid = invalidCount;

	for (const locator of locators) {
		result.scanned += 1;
		try {
			const probe = runPaths(locator);
			const physical = await resolvePhysicalRunsDir(probe.cwd, probe.runsDir);
			// A missing runs root is left to the bounded global locator sweep.
			if (physical === null) continue;
			const ref = {
				cwd: physical.physicalCwd,
				runsDir: relative(physical.physicalCwd, physical.physicalRunsDir),
				runId: locator.runId,
			};
			const paths = runPaths(ref);
			const runInfo = await lstat(paths.runDir).catch((error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			});
			if (runInfo === null) {
				if (locatorOlderThanPruneThreshold(locator, nowMs)) {
					result.eligible += 1;
					if (!options.dryRun && (await removeRunLocator(locator.runId)))
						result.missingLocatorsDeleted += 1;
				}
				continue;
			}
			if (!runInfo.isDirectory() || runInfo.isSymbolicLink()) {
				result.invalid += 1;
				continue;
			}

			const record = await readRunRecord(ref);
			if (record === null || record.runId !== locator.runId) {
				result.invalid += 1;
				continue;
			}
			if (record.activeAttemptId !== null || !isFullyTerminalRunRecord(record, locator.runId)) {
				result.activeSkipped += 1;
				continue;
			}
			const keepForMs = retentionMs(record.status);
			if (keepForMs === null || keepForMs < 0) {
				result.activeSkipped += 1;
				continue;
			}
			const completedAtMs = Date.parse(record.completedAt ?? "");
			if (!Number.isFinite(completedAtMs) || !Number.isFinite(Date.parse(record.updatedAt))) {
				result.invalid += 1;
				continue;
			}
			if (nowMs - completedAtMs < keepForMs) {
				result.retained += 1;
				continue;
			}

			result.eligible += 1;
			if (options.dryRun) continue;
			const outcome = await removeRunIfStill(ref, (current) => {
				const retention = retentionMs(current.status);
				return current.activeAttemptId === null &&
					isFullyTerminalRunRecord(current, locator.runId) &&
					retention !== null && retention >= 0 &&
					nowMs - Date.parse(current.completedAt ?? "") >= retention;
			}, {
				expectedUpdatedAt: record.updatedAt,
				afterRemove: () => removeLocatorIfOwned(locator.runId, ref.cwd, paths.runsDir, scanStartedAt),
			});
			if (outcome === "removed") result.deleted += 1;
			else result.retained += 1;
		} catch {
			result.errors += 1;
		}
	}

	return result;
}

function maintenancePaths(): {
	dir: string;
	state: string;
	lock: string;
} {
	const dir = join(dirname(runLocatorIndexDir()), "subagent-maintenance");
	return {
		dir,
		state: join(dir, "state.json"),
		lock: join(dir, "maintenance.lock"),
	};
}

async function readLastRunAt(path: string): Promise<number | null> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<MaintenanceState>;
		if (
			parsed.schemaVersion !== MAINTENANCE_STATE_VERSION ||
			typeof parsed.lastRunAt !== "string"
		)
			return null;
		const timestamp = Date.parse(parsed.lastRunAt);
		return Number.isFinite(timestamp) ? timestamp : null;
	} catch {
		return null;
	}
}

async function writeMaintenanceState(path: string, now: Date): Promise<void> {
	const state: MaintenanceState = {
		schemaVersion: MAINTENANCE_STATE_VERSION,
		lastRunAt: now.toISOString(),
	};
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
	await rename(tempPath, path);
}

export async function maybePruneSubagentRuns(
	options: PruneSubagentRunsOptions = {},
): Promise<PruneSubagentRunsResult> {
	if (process.env[PI_SUBAGENT_CHILD_ENV] === "1")
		return { ...emptyResult("skipped"), reason: "child" };
	const intervalMs = configuredDuration(
		"PI_SUBAGENT_MAINTENANCE_INTERVAL_MS",
		DEFAULT_MAINTENANCE_INTERVAL_MS,
	);
	if (intervalMs < 0)
		return { ...emptyResult("skipped"), reason: "disabled" };

	const now = options.now ?? new Date();
	const paths = maintenancePaths();
	await mkdir(paths.dir, { recursive: true });
	let release: (() => Promise<void>) | undefined;
	try {
		release = await properLockfile.lock(paths.dir, {
			realpath: false,
			lockfilePath: paths.lock,
			stale: MAINTENANCE_LOCK_STALE_MS,
			update: Math.floor(MAINTENANCE_LOCK_STALE_MS / 2),
			retries: 0,
		});
	} catch {
		return { ...emptyResult("skipped"), reason: "locked" };
	}

	try {
		const lastRunAt = await readLastRunAt(paths.state);
		if (
			lastRunAt !== null &&
			intervalMs > 0 &&
			now.getTime() - lastRunAt < intervalMs
		)
			return { ...emptyResult("skipped"), reason: "throttled" };
		const result = await pruneSubagentRuns(options);
		if (!options.dryRun) await writeMaintenanceState(paths.state, now);
		return result;
	} finally {
		await release();
	}
}
