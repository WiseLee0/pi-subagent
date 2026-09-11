#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { monitorParentLifetime } from "../../src/workers/parent-lifetime.mjs";
import { validateResolveInput } from "../../src/core/validation.ts";
import { readRunRecord } from "../../src/artifacts/index.ts";
import { inspectProcessIdentity } from "../../src/process-identity.ts";
import { interruptSubagent } from "../../api.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message) {
	for (let i = 0; i < 400; i++) {
		const result = await fn();
		if (result) return result;
		await sleep(50);
	}
	throw new Error(message);
}
for (const value of [true, false]) {
	const valid = validateResolveInput({ task: "test", surviveParentExit: value });
	assert.equal(valid.ok, true);
	assert.equal(valid.input.surviveParentExit, value);
}
for (const value of ["true", 1, null, {}])
	assert.equal(validateResolveInput({ task: "test", surviveParentExit: value }).ok, false);

// PID reuse counts as death; unknown inspection and session changes do not.
let state = "alive";
let cancelled = 0;
const stop = await monitorParentLifetime({
	parentIdentity: { pid: 123, processGroupId: 123, birthIdentity: "old" },
	verifyProcessIdentity: async () => state,
	onExit: () => cancelled++, intervalMs: 5,
});
await sleep(20);
assert.equal(cancelled, 0);
state = "unknown";
await sleep(20);
assert.equal(cancelled, 0);
state = "mismatch";
await sleep(20);
assert.equal(cancelled, 1);
stop();
await monitorParentLifetime({ surviveParentExit: true, onExit: () => assert.fail("opt-in monitored") });

const root = await mkdtemp(join(tmpdir(), "pi-parent-lifetime-"));
const apiUrl = pathToFileURL(resolve("api.mjs")).href;
const children = [];
const refs = [];
try {
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "pi"), `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync('execution-' + process.pid + '.json', JSON.stringify([process.pid, child.pid]));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`, { mode: 0o700 });

	async function launch(name, { survive = false, parallel = false, delay = false } = {}) {
		const cwd = join(root, name);
		await mkdir(cwd);
		const code = `
const { runSubagent } = await import(${JSON.stringify(apiUrl)});
const result = await runSubagent({ cwd: ${JSON.stringify(cwd)}, backend: 'headless',
  ${parallel ? "tasks: [{task:'one'}, {task:'two'}]," : "task: 'one',"}
  async: true, onComplete: 'detach', ${survive ? 'surviveParentExit: true' : ''} });
process.send(result);
process.on('message', () => process.exit(0));
`;
		const host = spawn(process.execPath, ["--input-type=module", "-e", code], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_SUBAGENT_RUN_INDEX_DIR: join(root, "index"), PI_SUBAGENT_DURABLE_WORKER_START_DELAY_MS: delay ? "3000" : "0" },
		});
		children.push(host);
		const [result] = await once(host, "message");
		const runs = (result.results ?? [result]).map((r) => ({ cwd, runId: r.runId }));
		refs.push(...runs);
		return { host, runs, cwd };
	}
	async function terminal(ref) {
		return await until(async () => {
			const record = await readRunRecord(ref);
			return record && ["cancelled", "failed", "completed"].includes(record.status) && record;
		}, "worker did not finalize without status/reconcile polling");
	}
	for (const kill of [false, true]) {
		const { host, runs, cwd } = await launch(`early-${kill}`, { delay: true });
		const exited = once(host, "exit");
		if (kill) host.kill("SIGKILL"); else host.send("quit");
		await exited;
		assert.equal((await terminal(runs[0])).status, "cancelled");
		assert.equal((await readdir(cwd)).some((f) => f.startsWith("execution-")), false, "dead host must not authorize delayed execution");
	}
	const { host, runs, cwd } = await launch("parallel", { parallel: true });
	const files = await until(async () => {
		const files = (await readdir(cwd)).filter((f) => f.startsWith("execution-"));
		return files.length === 2 && files;
	}, "parallel executions did not start");
	const identities = (await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(cwd, f), "utf8"))))).flat();
	// Returning the tool/API call and an idle host must not cancel workers.
	await sleep(600);
	for (const ref of runs) assert.equal((await readRunRecord(ref)).status, "running");
	const exited = once(host, "exit");
	host.kill("SIGKILL");
	await exited;
	for (const ref of runs) assert.equal((await terminal(ref)).status, "cancelled");
	for (const pid of identities)
		await until(async () => (await inspectProcessIdentity(pid)).state === "dead", "child/grandchild survived");

	const normal = await launch("normal-active");
	await until(async () => (await readdir(normal.cwd)).some((f) => f.startsWith("execution-")), "normal execution did not start");
	const normalExited = once(normal.host, "exit");
	normal.host.send("quit");
	await normalExited;
	assert.equal((await terminal(normal.runs[0])).status, "cancelled");

	const opt = await launch("opt-in", { survive: true, delay: true });
	const optExited = once(opt.host, "exit");
	opt.host.kill("SIGKILL");
	await optExited;
	await until(async () => Boolean((await readRunRecord(opt.runs[0]))?.attempts[0]?.process?.pid), "opt-in did not execute after host death");
	assert.equal((await readRunRecord(opt.runs[0])).status, "running");
	await interruptSubagent(opt.runs[0]);
	assert.equal((await terminal(opt.runs[0])).status, "cancelled");
	console.log(JSON.stringify({ name: "check-parent-lifetime", status: "completed" }));
} finally {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const ref of refs) await interruptSubagent(ref).catch(() => {});
	if (!process.env.KEEP_TEST_ROOT) await rm(root, { recursive: true, force: true });
	else console.error(root);
}
