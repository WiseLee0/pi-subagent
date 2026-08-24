import { getModels, type KnownProvider } from "@earendil-works/pi-ai";

export interface ModelProviderDomainOptions {
	model?: string;
	env?: NodeJS.ProcessEnv;
}

const PROVIDER_AUXILIARY_DOMAINS: Readonly<Record<string, readonly string[]>> = {
	"openai-codex": ["auth.openai.com"],
};

function scopedModel(value: string | undefined): {
	provider?: string;
	model?: string;
} {
	if (!value) return {};
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) return { model: value };
	return {
		provider: value.slice(0, separator),
		model: value.slice(separator + 1),
	};
}

export function resolveModelProviderDomains({
	model,
	env = process.env,
}: ModelProviderDomainOptions = {}): string[] {
	const requested = scopedModel(model ?? env.PI_MODEL);
	const provider = requested.provider ?? env.PI_PROVIDER;
	if (!provider) return [];

	try {
		const models = getModels(provider as KnownProvider);
		const selected =
			models.find((candidate) => candidate.id === requested.model) ?? models[0];
		if (!selected?.baseUrl) return [];
		return Array.from(
			new Set([
				new URL(selected.baseUrl).hostname,
				...(PROVIDER_AUXILIARY_DOMAINS[provider] ?? []),
			]),
		).filter(Boolean);
	} catch {
		// Custom providers are resolved by child Pi and cannot be safely inferred here.
		return [];
	}
}
