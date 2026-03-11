import { exec } from "node:child_process";
import { type ModelInfo, RUNTIME_MODELS } from "@codemote/common";

function titleCase(str: string): string {
	return str
		.split("-")
		.map((word, i, arr) => {
			const prev = arr[i - 1];
			// Preserve dot-separated version segments (e.g. "4-6" after "sonnet" → "4.6")
			if (/^\d+$/.test(word) && prev && /^\d+$/.test(prev)) {
				return `.${word}`;
			}
			return word.charAt(0).toUpperCase() + word.slice(1);
		})
		.join(" ")
		.replace(/ \./g, ".");
}

// Derive tier indicators from the canonical RUNTIME_MODELS registry
const MODEL_INDICATORS = new Map(
	RUNTIME_MODELS["opencode"]
		.filter(
			(
				m,
			): m is ModelInfo & {
				costTier: NonNullable<ModelInfo["costTier"]>;
				capabilityTier: NonNullable<ModelInfo["capabilityTier"]>;
			} => m.costTier != null && m.capabilityTier != null,
		)
		.map((m) => [m.id, { costTier: m.costTier, capabilityTier: m.capabilityTier }] as const),
);

export async function discoverOpenCodeModels(
	opencodePath = "opencode",
	providers = ["anthropic", "openai", "google"],
): Promise<ModelInfo[]> {
	const results = await Promise.all(
		providers.map(async (provider) => {
			try {
				const stdout = await new Promise<string>((resolve, reject) => {
					exec(`${opencodePath} models ${provider}`, { timeout: 5000 }, (error, stdout) => {
						if (error) reject(error);
						else resolve(stdout);
					});
				});
				return stdout
					.trim()
					.split("\n")
					.filter((line) => line.trim().length > 0)
					.map((line): ModelInfo => {
						const id = line.trim();
						const slashIndex = id.indexOf("/");
						const modelPart = slashIndex >= 0 ? id.slice(slashIndex + 1) : id;
						return {
							id,
							label: titleCase(modelPart),
							provider,
						};
					});
			} catch {
				return [];
			}
		}),
	);
	const flat = results.flat();
	return flat.map((model) => {
		const indicators = MODEL_INDICATORS.get(model.id);
		if (indicators) {
			return { ...model, ...indicators };
		}
		return model;
	});
}
