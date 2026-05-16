# LLM Bot Realness Scorecards

These files track live model-backed guild bot test scores over time. Each heartbeat pass should:

1. Invent fresh messy guild chat for every category.
2. Run several live messages per category through the real bridge endpoint.
3. Score the category from 1-10 using Buddy's realness rubric.
4. Append a dated entry to the matching scorecard.
5. Note fixes made, services rebuilt/restarted, and whether a fix is unscored until the next pass.

Important test framing:

- Categories should be general human/gamer guild chat first, not narrowly WoW-specific.
- They should still be WoW-capable: if the chat mentions marks, pulls, loot, quests, deaths, or party behavior, bots should understand and respond correctly.
- Good tests mix real-life nonsense, frustration, teasing, questions, and WoW context the way actual guild chat does.

Scorecards:

- [Memory](memory.md)
- [Shit-talk / Guild Banter](shit-talk-guild-banter.md)
- [Everyday Slice Of Life](everyday-slice-of-life.md)
- [Complaining](complaining.md)
- [Requests / Questions](requests-questions.md)

Current high-priority trend:

- Memory usually writes and recalls facts, but repeat suppression can falsely block a valid recall.
- Banter is the strongest category, though speaker blame can still drift.
- Slice-of-life is improving but can sound theatrical or miss the exact callout.
- Complaints are decent when the model responds, but malformed JSON/holds still waste good moments.
- Requests/questions around marks are weakest; tactical context exists now, and the new rejected-output retry still needs live scoring.
