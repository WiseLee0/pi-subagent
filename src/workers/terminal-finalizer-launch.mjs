import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function terminalFinalizerEnvironment() {
	return {
		PATH: "/usr/bin:/bin",
		LC_ALL: "C",
		LANG: "C",
		// In VS Code, execPath is Code Helper (Electron), not the Node binary.
		// Do not inherit the worker's environment (credentials, NODE_OPTIONS,
		// etc.), but explicitly preserve Node mode for this detached process.
		ELECTRON_RUN_AS_NODE: "1",
	};
}

export function spawnTerminalFinalizer({
	ref,
	attemptId,
	status,
	worker,
	cwd,
	cancelReason,
	execPath = process.execPath,
}) {
	const finalizerPath = fileURLToPath(
		new URL("./terminal-finalizer.mjs", import.meta.url),
	);
	const finalizerPayload = Buffer.from(
		JSON.stringify({
			ref,
			attemptId,
			status,
			worker,
			...(typeof cancelReason === "string" ? { cancelReason } : {}),
		}),
	).toString("base64url");
	const logPath = join(
		resolve(ref.cwd, ref.runsDir ?? ".pi/agent/runs"),
		ref.runId,
		"attempts",
		attemptId,
		"finalizer.log",
	);
	const logFd = openSync(logPath, "a");
	let finalizer;
	try {
		finalizer = spawn(execPath, [finalizerPath, finalizerPayload], {
			cwd,
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: terminalFinalizerEnvironment(),
		});
	} finally {
		closeSync(logFd);
	}
	finalizer.on("error", (error) => {
		console.error("Unable to start terminal finalizer:", error);
	});
	finalizer.unref();
	return finalizer;
}
