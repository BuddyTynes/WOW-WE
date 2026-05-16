# Memory

Tracks whether bots store durable facts, recall them naturally, and avoid fake memory acknowledgements. Memory tests should not be WoW-only: use real-life names, food, schedules, preferences, dumb personal details, and WoW facts interchangeably.

| Date / Pass | Scenario | Representative Replies | Score | Notes / Next Fix |
|---|---|---|---:|---|
| 2026-05-15 12:12 live pass | Buddy taught "jalapeno chips" and 6am shift, then asked snack recall. | Cumm/Zartorg recalled jalapenos and riffed on the snack. | 8/10 | Recall worked, but answer slightly normalized "jalapeno chips" down to "jalapenos" and over-focused on snack. |
| 2026-05-15 12:19 live pass | Buddy taught bank alt `Coinpanic`, then asked Zartorg to recall it. | "Coinpanic? You're a menace, Buddy..." | 8/10 | Good recall and voice. No fake "Got it" ack. |
| 2026-05-15 12:21 live pass | Buddy taught favorite vendor trash `cracked fang`, then asked Cumm to recall it. | Initial write: "Cracked fang? Seriously? You're gonna hoard that?" Recall was held. | 6/10 | Memory existed, but fuzzy repeat suppression rejected a valid recall because it resembled the earlier acknowledgement. New retry path is added but not scored yet. |
| 2026-05-15 12:26 heartbeat | Buddy taught emergency hearth spot `Sentinel Hill`, then asked Zartorg to recall it after pizza chatter. | "Sentinel Hill, you blithering idiot. Goldshire is for genuine emergencies..." | 9/10 | Strong recall, distinct voice, no canned acknowledgement. Slightly aggressive but believable for this bot. |
| 2026-05-15 12:36 heartbeat | Buddy taught backup snack `freezer waffles, not chips`, then asked Cumm after laundry chatter. | "Freezer waffles, you nitwit. Chips are superior, obviously." | 8/10 | Recall worked and stayed in character. Explicit remember still produced a soft "I'll try to remember" style line, but not the bad canned assistant ack. |

Latest focus:

- Let valid recall through when it shares the remembered fact with prior chat.
- Keep model-voiced recall, not deterministic canned answers.
- Keep blocking fake acknowledgements like "Got it, I'll remember that" unless explicitly asked and actually appropriate.
| 2026-05-15 13:52 heartbeat | Durable weird dinner fact, mockery, then cross-bot recall. | "Nachos and root beer, remember? You're gonna need a bigger plate." | 8/10 | Cross-bot player memory now works and no canned ack. First replies still overuse "Seriously"; next fix is more varied voice starts. |
| 2026-05-15 14:12 heartbeat | Buddy taught emergency snack as glovebox cinnamon pretzels, got teased, then asked Cumm to recall it. | "Pretzels. Glovebox. Tragic." | 8/10 | Durable recall worked and no fake memory ack. Reply hit the fact first, but was a little too clipped; next fix is one short personality beat after fact recall. |
| 2026-05-15 14:35 heartbeat | Taught backup breakfast as cold pizza folded around a cheese stick, then asked Cumm to recall and clown it. | "Cold pizza, remember? You're gonna be regretting that cheese stick later..." | 8/10 | Correct durable recall with no fake "got it" acknowledgement. It remembered the food and added a jab, though it dropped the full "folded around a cheese stick" phrasing. Next fix: preserve more exact weird food details in recall. |
| 2026-05-15 14:45 heartbeat | Taught cursed lunch combo as ramen with shredded cheese and hot sauce, got mocked, then asked Cumm to recall without fake acknowledgement. | "Ramen cheese bomb, huh? You're gonna regret that." | 7/10 | No bad ack and it recalled the core ramen/cheese idea, but lost hot sauce and exact phrasing. Next fix: preserve full multi-ingredient facts instead of compressing them too aggressively. |
| 2026-05-15 14:51 heartbeat + targeted rerun | Initial sleep-schedule recall held because sleep schedule was not durable; patched and retested with two alarms losing to gas station coffee. | "Your sleep schedule is two alarms losing a fistfight to a gas station coffee." | 8/10 | Sleep schedule is now a durable fact and recall no longer gets swallowed by stale tactical context. Still a little canned with "somehow survived in my head"; next fix is bot-specific recall flavor. |
