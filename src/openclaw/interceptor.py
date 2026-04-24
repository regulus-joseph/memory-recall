"""
OpenClaw Hook Interceptor for memory-recall
Hooks into before_prompt_build to inject relevant memories
"""
import logging
from typing import Any

log = logging.getLogger(__name__)

HOOK_NAME = "before_prompt_build"


def register_hook(api: Any, config: dict) -> None:
    """Register the before_prompt_build hook with OpenClaw"""
    api.on(HOOK_NAME, create_hook_handler(config))


def create_hook_handler(config: dict):
    """Create the hook handler function"""

    async def hook_handler(params: dict) -> dict:
        session_messages = params.get("sessionMessages", [])
        user_message = params.get("userMessage", "")

        if not user_message:
            return {"prependContext": ""}

        from .core.matcher import MemoryMatcher

        matcher = MemoryMatcher(config)
        results = await matcher.recall(user_message, session_messages)

        if not results:
            return {"prependContext": ""}

        prepend = format_memory_context(results, config)
        log.info(f"memory-recall: injected {len(results)} memories")

        return {"prependContext": prepend}

    return hook_handler


def format_memory_context(memories: list[dict], config: dict) -> str:
    """Format memories for injection into prompt context"""
    max_chars = config.get("autoRecallMaxChars", 600)
    max_items = config.get("autoRecallMaxItems", 3)

    lines = ["\n\n[Relevant Memory Context]"]
    total_chars = 0

    for mem in memories[:max_items]:
        content = mem.get("content", "")[:200]
        agent_id = mem.get("agent_id", "unknown")
        timestamp = mem.get("timestamp", "")

        entry = f"- [{agent_id}] ({timestamp}): {content}"
        entry_len = len(entry)

        if total_chars + entry_len > max_chars:
            break

        lines.append(entry)
        total_chars += entry_len

    lines.append("[/Relevant Memory Context]\n")
    return "\n".join(lines)
