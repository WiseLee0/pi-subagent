import type { ResolveOutput, ResolvedBackend } from "./constants.ts";
import { validateResolveInput } from "./validation.ts";

function completed(backend: ResolvedBackend): ResolveOutput {
  return { backend, status: "completed" };
}

export function resolveBackend(raw: unknown = {}): ResolveOutput {
  const validated = validateResolveInput(raw);
  if (!validated.ok) return validated.failure;

  const input = validated.input;
  const requested = input.backend ?? "auto";

  // An inline worker cannot enforce an OS sandbox. Treat the sandbox request as
  // the stronger constraint and transparently promote it to a process-backed
  // headless worker instead of rejecting an otherwise runnable invocation.
  if (requested === "inline" && input.sandbox) return completed("headless");
  if (requested !== "auto") return completed(requested);

  if (input.visible) return completed("tmux");
  if (input.sandbox) return completed("headless");
  return completed("inline");
}
