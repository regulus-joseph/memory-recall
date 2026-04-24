# Memory Recall Skill

Provides L1/L2/L3 memory recall for OpenClaw agents.

## Usage

The plugin automatically injects relevant memories when you ask about past conversations.

Example:
- "What did we discuss about Docker?"
- "Do you remember the Python project we worked on?"

## Configuration

In your openclaw.json:

```json
{
  "plugins": {
    "entries": {
      "memory-recall": {
        "enabled": true,
        "config": {
          "qdrant": {
            "host": "localhost",
            "port": 6333,
            "collection": "memory_recall"
          },
          "autoRecall": true,
          "autoRecallMaxItems": 3,
          "autoRecallMaxChars": 600
        }
      }
    }
  }
}
```