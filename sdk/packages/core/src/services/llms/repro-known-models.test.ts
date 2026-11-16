import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ProviderSettingsManager,
	resolveProviderConfig,
} from "@cline/core";
import { afterAll, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

/**
 * Mirrors the real CLI flow: a custom OpenAI-compatible provider (e.g. a vLLM
 * server) is configured via the config UI, which writes models.json. When a
 * task later runs, the CLI constructs the ProviderSettingsManager (whose
 * constructor registers custom providers from models.json) and then resolves
 * the provider config for model metadata. The custom model's metadata (e.g.
 * maxInputTokens) must survive resolution so context compaction budgets on the
 * correct window — the core of the Case A fix.
 */
function managerWithModelsFile(modelEntry: unknown) {
	const tempDir = mkdtempSync(join(tmpdir(), "cline-repro-"));
	tempDirs.push(tempDir);
	// models.json must exist BEFORE the manager is constructed, because the
	// constructor loads it exactly once per process (subsequent ensures are
	// no-ops). The config UI writes it during setup, before a task starts.
	writeFileSync(
		join(tempDir, "models.json"),
		JSON.stringify({
			version: 1,
			providers: {
				"openai-compatible": {
					provider: { name: "vLLM", baseUrl: "http://localhost:8000/v1" },
					models: { "qwen3.8-27b-int4": modelEntry },
				},
			},
		}),
	);
	const manager = new ProviderSettingsManager({ filePath: join(tempDir, "providers.json") });
	manager.saveProviderSettings({
		provider: "openai-compatible",
		model: "qwen3.8-27b-int4",
		apiKey: "vllm-key",
		baseUrl: "http://localhost:8000/v1",
	});
	return manager;
}

afterAll(() => {
	for (const d of tempDirs) rmSync(d, { force: true, recursive: true });
});

describe("repro: custom OpenAI-compatible model in models.json", () => {
	it("resolves the model into knownModels with its file metadata", async () => {
		const manager = managerWithModelsFile({
			id: "qwen3.8-27b-int4",
			name: "Qwen3.8 27B int4 (vLLM)",
			contextWindow: 262144,
			maxInputTokens: 245760,
			capabilities: ["streaming", "tools"],
		});
		const persistedProviderConfig = manager.getProviderConfig("openai-compatible", {
			includeKnownModels: false,
		});
		const resolved = await resolveProviderConfig("openai-compatible", undefined, persistedProviderConfig);
		expect(resolved?.knownModels?.["qwen3.8-27b-int4"]?.maxInputTokens).toBe(245760);
		expect(resolved?.knownModels?.["qwen3.8-27b-int4"]?.contextWindow).toBe(262144);
	});

	it("does not require explicit ensure when the constructor already registered", async () => {
		const manager = managerWithModelsFile({
			id: "qwen3.8-27b-int4",
			name: "Qwen3.8 27B int4 (vLLM)",
			maxInputTokens: 123456,
		});
		const resolved = await resolveProviderConfig("openai-compatible", undefined, undefined);
		expect(resolved?.knownModels?.["qwen3.8-27b-int4"]?.maxInputTokens).toBe(123456);
	});
});
