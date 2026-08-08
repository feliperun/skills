---
name: humanize
description: Rewrites text to strip the structural fingerprints of LLM writing by attacking narrative and argumentative decisions, not lexical surface. Use when the user asks to "make it sound human", "remove the AI feel", "this reads like ChatGPT", "rewrite so it doesn't look like an LLM", "humanize this text", "humanizar esse texto", "tirar cara de IA", "deixar mais humano", "está genérico demais". Also use proactively when reviewing authored prose (post, essay, fiction, newsletter, README with a voice) before publishing.
---

# Humanize

Rewrites text by attacking **structural decisions**, not words.

Based on: Russell, Rajendhran, Pham, Iyyer, Wieting. "StoryScope: Investigating
idiosyncrasies in AI fiction". COLM 2026, arXiv:2604.03136.

---

## 1. Core thesis (read this first)

The paper tested exactly the shortcut everyone reaches for. They applied the LAMP
framework, which rewrites seven categories of AI-writing artifact (cliche, redundant
exposition, purple prose) span by span, with 25 few-shot examples from professional
writers. Result: detection by narrative features fell from 95.5% to 93.9% macro-F1.
**A 1.6-point drop.**

Operational conclusion: swapping em dashes for commas and deleting "delve",
"tapestry", "it's not just X, it's Y" and "at the end of the day" humanizes nothing.
It only changes the surface of a text that keeps making the same construction
decisions.

What separates human from LLM, at 93.2% macro-F1 with no style signal at all:

1. **Thematic determinacy.** The LLM explains what the text means.
2. **Causal linearity.** The LLM tells one line, from first clue to reveal.
3. **Sensory performance.** The LLM stages emotion in the body instead of naming it.
4. **Disengagement from the real world.** The LLM alludes, it does not cite by name.
5. **Low variance.** The LLM always picks the modal option.

This skill operates on those five fronts. If the rewrite changed nothing on any of
them, the rewrite did not happen.

---

## 2. Scope and limits

- Applies to authored prose: fiction, essay, post, newsletter, memo with a voice.
- **Do not apply** to regulated documentation (ANVISA, IEC 62304, ISO 13485),
  technical specs, RFCs, ADRs or reports. In those contexts thematic unity, causal
  linearity and absence of subplot are quality requirements, not defects. If the user
  asks anyway, warn them and ask for confirmation.
- The paper measured stories of roughly 5,000 words. In short text (under 800 words)
  most temporal and subplot markers have nowhere to show up. Prioritize moves M1, M2,
  M4 and M6.
- This is a writing-quality skill, not detector evasion. If an AI-use disclosure
  obligation applies, it still applies after the rewrite.

---

## 3. Process

### Step 1: diagnosis

Before writing anything, score the original text on the 12 markers below. Scale 1 to
5, where 5 is "fully LLM". Compact rubric:

    diagnosis:
      thematic_determinacy:
        theme_stated_by_narrator: 0-5     # does the text say what it means?
        thematic_unity: 0-5               # does everything serve the same idea?
        moral_philosophical_weight: 0-5   # does dialogue turn into a debate of ideas?
      structure:
        causal_chain_continuity: 0-5      # one line only, no branching?
        absence_of_subplot: 0-5
        resolution_by_protagonist_choice: 0-5
        resolution_by_internal_understanding: 0-5
      sensory:
        embodied_emotion: 0-5             # tight throat, cold chest
        sensory_density: 0-5
        setting_as_psychological_mirror: 0-5
      world:
        vague_reference_instead_of_named: 0-5
        absence_of_reader_address: 0-5

Report the diagnosis in three lines maximum. Do not write an essay about the
diagnosis.

### Step 2: rewrite

Apply the moves in section 4, starting from the highest-scoring markers. Budget rule:
**change at least three structural decisions**. One alone does not move the needle.

### Step 3: verification

Run the checklist in section 8. If the answer to "which construction decision
changed?" is only "the vocabulary", go back to step 2.

---

## 4. The eight moves

Ordered by the size of the gap measured in the paper (human vs. AI, corpus of 61,608
stories).

### M1. Do not explain the theme

**Data:** the narrator states the theme in 77% of AI stories against 52% of human
ones. Mean thematic explicitness 3.94 against 3.28. Dialogue as philosophical debate:
59% against 34%.

- Find the sentence where the text declares its own meaning. Usually the last
  paragraph, sometimes the second to last. Delete it.
- If the reader still understands after the deletion, the sentence was redundant. If
  they do not, the problem is the scene, not the sentence. Fix the scene.
- Cut the second formulation of the same idea. An LLM states, illustrates, then
  restates. Keep the illustration.
- Take the moral out of a character's mouth. Nobody verbalizes the thesis of the text
  they are in.

### M2. Name the emotion

**Data:** AI conveys emotion through bodily metaphor in 81% of cases against 38% for
humans. Explicit emotional label: 29% human against only 8% for AI.

This is the single largest gap in the entire paper (43 percentage points).

- "His throat tightened, his hands went cold, the floor seemed to give way" becomes
  "he was scared".
- One bodily signal per scene, maximum. Not three in a row.
- Holds for nonfiction: "I felt a discomfort hard to name reading the report" becomes
  "I thought the report was dishonest".

### M3. Break the linearity

**Data:** causal chain continuity 4.20 against 3.92. Chronological discontinuity 2.12
against 2.40. Anachrony 2.31 against 2.58. Depth of recontextualization after the
reveal 2.95 against 3.28.

- Start in the middle or at the end. The paper describes exactly this: a human mystery
  opens at the funeral and spirals decades backward, the AI tells it from first clue to
  reveal.
- Add a time jump the reader has to reconstruct alone, with no transition sentence of
  the "three years earlier" kind.
- Place information early that only makes sense later. Recontextualization is the
  strongest human marker in the reveal dimension.

### M4. Cite by name

**Data:** humans make explicit named references in 47% of texts against 24% for AI.
Balanced mix of explicit and implicit: 37% against 16%. AI prefers vague allusion (72%
against 50%).

- Replace "an ancient philosopher once said" with "Seneca wrote".
- Replace "a recent study" with author, year, and the number that matters.
- Name the brand, the street, the model, the version, the restaurant, the bug tracker.
  An LLM avoids real-world proper nouns by default, and that is detectable.
- Watch the inverse: an invented source name is worse than a vague allusion. Only name
  what you can verify.

### M5. Leave the ending crooked

**Data:** resolution by protagonist choice 69% against 46%. Resolution by internal
understanding or acceptance 47% against 27%. Ambivalent moral polarity 59% human
against 38% AI.

- Not every conflict resolves through the protagonist's decision. Chance, a third
  party, bureaucracy, exhaustion, and sometimes nothing.
- Cut the paragraph of serene acceptance. "He finally understood that..." is a
  signature.
- Let the protagonist have done something indefensible and never pay for it.
- In an essay: end without synthesis. An argument can end on an open problem.

### M6. Talk to the reader

**Data:** humans break the fourth wall in 67% of texts against 39% for AI, and address
the reader directly in 28% against 7%.

- One direct aside to the reader. A parenthetical admitting the previous explanation
  was bad.
- An acknowledged digression ("I'm going off track here, but it's related").
- In a technical post this is natural and the LLM still will not do it. Use it.

### M7. Leave debris

**Data:** 79% of AI stories have no subplot at all, against 57% of human ones.
Thematically parallel subplot: 42% human against 21% AI. Variety of locations 1.34
against 1.08. Dialogue-to-narration ratio 2.95 against 2.70. Thematic unity 4.74 for
AI against 4.41 for human.

- Add an element that does **not** serve the central thesis. A neighbor, a side
  obsession, an anecdote that exists only because it happened.
- More locations. More people talking. Less narrator summarizing what was said.
- If every paragraph justifies its presence by the thesis, the text is machine-made.

### M8. Cut the sensory inventory

**Data:** olfactory imagery in 82% of AI texts against 57% of human ones. Sensory
density 3.93 against 3.66. Setting as psychological mirror 4.07 against 3.58. Spatial
granularity and opening spatial anchoring are also elevated in AI.

- Cut the smell. Seriously. Olfaction is the most disproportionate sensory marker in
  the corpus, and it almost always enters as decoration.
- Do not open by anchoring the reader in physical space. Open in the middle of a line
  of dialogue, a proposition, or a problem.
- Rainy weather because the character is sad is the modal decision. Let the weather be
  indifferent to the internal state.

---

## 5. Self-correction by fingerprint

The paper identified per-model fingerprints. Claude is **the most distinct of the five
LLMs** (89.3% F1 on six-way attribution, against 55 to 67% for the others), so this
section takes priority when the skill runs on Claude.

### Claude fingerprint (always correct)

| Mark | Correction |
|---|---|
| Flat event escalation (SHAP 0.402, the highest in the corpus) | Let one thing get badly out of hand. A disproportionate break. |
| Low diversity of event types | Mix registers: one bureaucratic scene, one physical, one comic. |
| Epilogue and flash-forward at the end | Cut the last block. End on the scene, not after it. |
| Avoids dreams and visions | If it fits, use one. It is a device Claude systematically skips. |
| Reverence for literary tradition (62% against 39 to 56% for the others) | Subvert the genre convention instead of honoring it. |
| Uniform narrative voice | Let the register vary. One drier paragraph, one sloppier. |
| Quiet ending instead of an avalanche | Consider the loud ending. |

### Other models (if the text came from one)

- **GPT:** gossip and rumor as plot mechanism (64%), distant retrospective narrator,
  ambiguous reconciliation. Cut the "years later, they said that" frame.
- **Gemini:** endings too tidy, extended denouement, somber setting in 88% of cases,
  the protagonist's social network always expanding. Cut the denouement, leave the
  world neutral, leave the protagonist more isolated at the end than at the start.
- **DeepSeek:** loads crucial context up front, visible narrator, emotion through
  behavioral cues. Delay the information.
- **Kimi:** opens in medias res, introduces characters in action, no trait labels. It
  is the most generic model in the corpus (F1 55.0%). Here the problem is absence of
  choice, not the wrong choice: add any striking decision.

---

## 6. Adaptation for nonfiction

Mapping of the moves to essay, post and newsletter:

| Move | Nonfiction version |
|---|---|
| M1 Do not explain the theme | Do not restate the thesis in the conclusion. Cut the "in summary". |
| M2 Name the emotion | "This API annoyed me" instead of staged discomfort. |
| M3 Break the linearity | Open on the specific incident, not the panorama. |
| M4 Cite by name | Tool, version, number, date, author. No "studies show". |
| M5 Leave the ending crooked | Admit the tradeoff you did not resolve. Do not close on a recommendation. |
| M6 Talk to the reader | Aside, self-criticism, "I was wrong about this until June". |
| M7 Leave debris | A tangent that does not serve the argument and you kept because it is good. |
| M8 Cut the sensory | Cut the illustrative metaphor. Go straight to the mechanism. |

Extra LLM markers in nonfiction, not measured by the paper but correlates of M1 and
M7: a tricolon in every list, every paragraph the same length, every section with the
same number of bullets, an explicit transition between every block.

---

## 7. Anti-patterns

Do none of these. They are all cosmetic (see section 1) or they make the text worse.

- Swapping em dashes for commas and calling it humanization.
- Hunting for "delve", "tapestry", "crucial", "in today's landscape".
- Inserting typos, forced slang, "like, you know", "right?".
- Adding artificial hesitation ("hmm", "well...").
- Padding the text. Human is not longer, it is disorganized on purpose.
- Sacrificing clarity. The goal is structural variance, not noise.
- Applying all eight moves at once to a short text. It turns into caricature.
- Naming a source that does not exist in order to satisfy M4.

---

## 8. Verification checklist

Before delivering, answer internally:

1. Which **construction** decision changed? (If the answer is only vocabulary, redo it.)
2. Does the text still declare its own meaning anywhere?
3. Is there at least one emotion named directly?
4. Is there at least one verifiable real-world proper noun?
5. Is the order of events still chronological order?
6. Is the ending still resolution by conscious choice followed by understanding?
7. Is there any element that does not serve the thesis?
8. Is there a decorative smell left?

Underlying goal: **rarity**. In the paper, human stories sit at mean rarity percentile
0.71 against 0.49 for AI ones, and the human version is the rarest of the six in 57.8%
of prompts (against 16.7% by chance). Practical rule derived from that: for every
construction decision, if the option that came to mind first is the obvious one, it is
the modal one. Take the second or the third.

---

## 9. Output format

Always deliver in this order:

1. **Diagnosis** (3 lines, the highest markers and nothing else).
2. **Rewritten text** (complete, ready to copy).
3. **Moves applied** (short list: `M3 time jump in the opening`, `M5 resolution
   transferred to chance`, `M8 olfactory image removed`).

Do not write long justifications. If the user wants to understand a choice, they ask.
