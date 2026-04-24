export function stringEnum(values) {
  return {
    type: "string",
    enum: Array.isArray(values) ? values : [],
  };
}

export const HOOK_PRIORITIES = {
  CRITICAL: 0,
  HIGH: 10,
  DEFAULT: 100,
  LOW: 1000,
};

export const Lifecycle = {
  MessageReceived: "message_received",
  BeforePromptBuild: "before_prompt_build",
  BeforeAgentStart: "before_agent_start",
  AgentEnd: "agent_end",
  SessionEnd: "session_end",
  BeforeReset: "before_reset",
};
