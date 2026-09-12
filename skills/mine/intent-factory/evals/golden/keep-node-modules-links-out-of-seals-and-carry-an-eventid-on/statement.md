fix(intent-factory): keep node_modules links out of seals and carry an eventId on notifications

The seal unstages the node_modules link that createAttemptWorktree adds (node_modules/ in
.gitignore does not match a symlink, and the first integrated attempt committed it). Notify
events and receipts carry a stable eventId derived from the dedupe key because the human
channel adapter rejects an event without one (every phase-3 receipt said failed: eventId is
invalid). The glm env-overlay lock test waits until its marker parses instead of racing the
provider's write, which failed dashboard-v2's verification under parallel load.
