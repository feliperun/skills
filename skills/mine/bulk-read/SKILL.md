---
name: bulk-read
description: Ask one question about many large files without loading them into context.
---

`intent-factory bulk-read --question "<question>" --paths <a.mjs,b.mjs,c.mjs>`

Delegates to a cheap runtime and returns bullets only, each starting with an
exact symbol name or file:line number. Corpora under 1500 lines are refused —
read those directly. Every call is independent. Check the line number in the
file before editing.
