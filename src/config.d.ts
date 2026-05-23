/**
 * shared-lib/ts/config.ts
 * =========================
 * 统一 env 前缀声明，所有 ~/projects/ 下的 TS 项目共享此文件。
 *
 * 模型策略（重要约束）
 * ===================
 * 本地 Ollama 模型分层：
 *
 *   qwen2.5:3b   默认  |  轻量任务：翻译、结构化提取、关键词、二元分类、简单对话
 *   qwen3.5:9b   增强  |  复杂推理：多步分析、代码生成、风控评估（需 override）
 *   bge-m3        向量  |  Embedding
 *
 * Ollama 调用必须指定 "think": false（qwen3 系列默认开启 thinking，极慢）。
 *
 * 约束：
 *   1. shared-lib 的 LLM_MODEL 默认值不可随意升级。
 *      如项目需要 qwen3.5:9b，在项目自己的 .env 或 config 中 override，
 *      并在项目的 README/DEPLOY.md 中说明理由。
 *   2. 所有 LLM 调用必须加 "think": false。
 *   3. Embedding 统一用 bge-m3，不单独配置其他 embedder。
 *
 * 性能参考（warmup 后，GPU Titan Xp 12GB）：
 *   qwen2.5:3b  translate ~500ms  |  smart-review ~300ms
 *   qwen3.5:9b  translate ~2-5s   |  smart-review ~200ms（冷启动 >15s）
 *
 * Env Variables (统一前缀 OLLAMA_*):
 *   OLLAMA_BASE_URL          = "http://localhost:11434"
 *   OLLAMA_LLM_MODEL        = "qwen2.5:3b"     ← 默认轻量模型
 *   OLLAMA_EMBED_MODEL      = "bge-m3"
 *   OLLAMA_EMBED_DIM        = 1024
 *   OLLAMA_TIMEOUT_MS       = 30000   (毫秒)
 *   OLLAMA_EMBED_TIMEOUT_MS = 60000   (毫秒)
 *   OLLAMA_RETRIES          = 2
 */
export declare const ENV: {
    readonly baseUrl: any;
    readonly llmModel: any;
    readonly embedModel: any;
    readonly embedDim: number;
    readonly timeoutMs: number;
    readonly embedTimeout: number;
    readonly retries: number;
};
export type EnvKey = keyof typeof ENV;
