// Monitor process lifetime, never Pi session/turn lifetime. No resources are
// installed in the extension factory. Birth identity prevents PID reuse from
// making a dead host appear alive; the host itself is never signalled.
export async function monitorParentLifetime({
	parentIdentity,
	surviveParentExit,
	verifyProcessIdentity,
	onExit,
	intervalMs = 250,
}) {
	if (surviveParentExit === true) return () => {};
	let stopped = false;
	let timer;
	async function check() {
		if (stopped) return;
		const state = parentIdentity
			? await verifyProcessIdentity(parentIdentity).catch(() => "unknown")
			: "dead";
		if (stopped) return;
		if (state === "dead" || state === "mismatch") {
			stopped = true;
			onExit();
			return;
		}
		// Unknown is not evidence of death. Retry without unsafe PID-only kills.
		timer = setTimeout(() => void check(), intervalMs);
		timer.unref?.();
	}
	// Check before any execution, including when the host died before imports.
	await check();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}
