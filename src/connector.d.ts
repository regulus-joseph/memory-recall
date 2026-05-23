/**
 * llm-connector/src/ts/connector.ts
 * ==================================
 * 统一 LLM/Embedding 客户端 (TypeScript)
 * 引用 shared-lib/ts/config.ts 获取统一 env。
 *
 * shared-lib 路径: ~/projects/shared-lib/ts/
 * 消费项目 tsconfig 建议配置:
 *   "paths": {
 *     "shared-lib": ["../shared-lib/ts"],
 *     "shared-lib/*": ["../shared-lib/ts/*"]
 *   }
 */
import { ENV } from "../../../shared-lib/ts/config.js";
export interface LLMConfig {
    baseUrl?: string;
    llmModel?: string;
    embedModel?: string;
    embedDim?: number;
    timeoutMs?: number;
    embedTimeout?: number;
    retries?: number;
}
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface LLMStats {
    calls: number;
    totalTokens: number;
    totalMs: number;
}
export declare function cosineSimilarity(a: number[], b: number[]): number;
export declare function getEmbedding(text: string, cfg?: LLMConfig): Promise<number[]>;
export declare function translateToEnglish(text: string, cfg?: LLMConfig): Promise<string | null>;
export declare function extractKeywords(description: string, skillName: string, cfg?: LLMConfig): Promise<string[]>;
export declare function chat(messages: ChatMessage[], cfg?: LLMConfig): Promise<string>;
export declare function getStats(): LLMStats;
export { ENV as llmConnectorDefaults };
