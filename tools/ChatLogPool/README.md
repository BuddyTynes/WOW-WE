# ChatLogPool

This folder builds the portable Spice of Life chat seed used by the WoW LLM
bridge.

Raw ElvUI SavedVariables files stay local in `unparsed logs`. After a
successful parse they are copied to `parsed logs` for operator bookkeeping.
Neither folder's `.lua` contents are committed.

Generate the tracked seed with:

```powershell
node .\tools\ChatLogPool\import-chat-logs.js
```

The script writes:

```text
tools\WoWLlmBridge\seeds\spice_chat_pool.seed.jsonl
```

Commit the updated seed file when the pool should ship to another machine.
