import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Live progress for a running attempt. Written (throttled, atomically) to
 * `<attemptDir>/progress.json` so `status`/`wait` can show what a long-running
 * worker is doing instead of only a heartbeat.
 */
export const PROGRESS_FILENAME = "progress.json";

const RECENT_LIMIT = 8;
const FLUSH_INTERVAL_MS = 1_000;
const DETAIL_LIMIT = 120;
const TEXT_TAIL_LIMIT = 400;

export interface RunProgressEntry {
	at: string;
	kind: "tool" | "tool_error" | "message";
	text: string;
}

export interface RunProgress {
	schemaVersion: 1;
	startedAt: string;
	updatedAt: string;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	assistantMessages: number;
	currentTool: string | null;
	recent: RunProgressEntry[];
	lastAssistantText?: string;
}

function clip(value: string, limit: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= limit
		? normalized
		: `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function argsBrief(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const record = args as Record<string, unknown>;
	for (const key of ["command", "path", "pattern", "url", "query", "action", "task"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0)
			return clip(value, DETAIL_LIMIT);
	}
	return "";
}

function assistantText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant") return "";
	const content = record.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			typeof part === "object" &&
			part !== null &&
			(part as Record<string, unknown>).type === "text" &&
			typeof (part as Record<string, unknown>).text === "string"
				? ((part as Record<string, unknown>).text as string)
				: "",
		)
		.join("");
}

export class RunProgressTracker {
	private readonly path: string;
	private readonly state: RunProgress;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private writing: Promise<void> = Promise.resolve();
	private dirty = false;
	private closed = false;

	constructor(attemptDir: string, startedAt: Date = new Date()) {
		this.path = join(attemptDir, PROGRESS_FILENAME);
		const iso = startedAt.toISOString();
		this.state = {
			schemaVersion: 1,
			startedAt: iso,
			updatedAt: iso,
			turns: 0,
			toolCalls: 0,
			toolErrors: 0,
			assistantMessages: 0,
			currentTool: null,
			recent: [],
		};
		this.schedule();
	}

	processEvent(event: unknown): void {
		if (this.closed || typeof event !== "object" || event === null) return;
		const record = event as Record<string, unknown>;
		const now = new Date().toISOString();
		switch (record.type) {
			case "turn_start":
				this.state.turns += 1;
				break;
			case "tool_execution_start": {
				const name = typeof record.toolName === "string" ? record.toolName : "tool";
				const brief = argsBrief(record.args);
				const label = brief.length > 0 ? `${name}: ${brief}` : name;
				this.state.toolCalls += 1;
				this.state.currentTool = label;
				this.push({ at: now, kind: "tool", text: label });
				break;
			}
			case "tool_execution_end": {
				this.state.currentTool = null;
				if (record.isError === true) {
					this.state.toolErrors += 1;
					const name = typeof record.toolName === "string" ? record.toolName : "tool";
					this.push({ at: now, kind: "tool_error", text: `${name} failed` });
				}
				break;
			}
			case "message_end": {
				const text = assistantText(record.message);
				if (text.trim().length === 0) {
					if (
						typeof record.message === "object" &&
						record.message !== null &&
						(record.message as Record<string, unknown>).role === "assistant"
					)
						this.state.assistantMessages += 1;
					break;
				}
				this.state.assistantMessages += 1;
				this.state.lastAssistantText = clip(text, TEXT_TAIL_LIMIT);
				this.push({ at: now, kind: "message", text: clip(text, DETAIL_LIMIT) });
				break;
			}
			default:
				return;
		}
		this.state.updatedAt = now;
		this.schedule();
	}

	/** Flush the latest state and stop further writes. */
	async close(): Promise<void> {
		if (this.closed) return;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.dirty = true;
		await this.flush();
		this.closed = true;
	}

	private push(entry: RunProgressEntry): void {
		this.state.recent.push(entry);
		if (this.state.recent.length > RECENT_LIMIT)
			this.state.recent.splice(0, this.state.recent.length - RECENT_LIMIT);
	}

	private schedule(): void {
		this.dirty = true;
		if (this.timer !== undefined || this.closed) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, FLUSH_INTERVAL_MS);
		this.timer.unref?.();
	}

	private flush(): Promise<void> {
		this.writing = this.writing.then(async () => {
			if (!this.dirty || this.closed) return;
			this.dirty = false;
			const temp = `${this.path}.${process.pid}.tmp`;
			try {
				await writeFile(temp, `${JSON.stringify(this.state)}\n`);
				await rename(temp, this.path);
			} catch {
				// Progress is best-effort observability; never fail the run.
			}
		});
		return this.writing;
	}
}
