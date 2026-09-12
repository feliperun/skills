fix(intent-factory): keep runner-managed signal-block rewrites out of worker scope drift

The workspace snapshot hashed AGENTS.md verbatim, so every runner-owned
signal-block refresh looked like worker scope drift across the evidence
window. Hash the file with only the complete managed block normalized:
runner rewrites become scope-neutral while human guidance outside the
block still changes the identity.
