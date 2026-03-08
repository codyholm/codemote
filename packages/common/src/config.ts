import type { RuntimeType } from "./index.js";

export interface CodemoteConfig {
	runtimeSettings?: Partial<Record<RuntimeType, RuntimeSettings>>;
}

export interface RuntimeSettings {
	defaultModel?: string;
	defaultProvider?: string;
}
