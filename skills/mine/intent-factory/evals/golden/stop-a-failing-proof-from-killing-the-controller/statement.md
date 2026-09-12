fix(intent-factory): stop a failing proof from killing the controller

A failing command proof whose output exceeded 4 KiB produced a gate finding
the node-snapshot validator rejects, and that rejection propagated as a
controller crash mid-gate — the run died with work already on disk. The cause
was an off-by-one in the truncation: it cut to maxBytes minus one byte and
appended an ellipsis that costs three, so a 4096 limit produced 4098 bytes. A
byte-aligned cut can also land inside a multibyte character, whose
replacement costs three more, so the fix reserves the marker and then shrinks
until the encoded result actually fits.

Both halves are needed to trigger it — findings are built only from failed
proofs, so a passing proof with a large output never reaches the validator —
and the regression test uses exactly that shape.

A Python virtual environment no longer moves the ignore-source fingerprint.
It is the same class as node_modules: the environment and its installed
packages carry their own .gitignore files, so they appeared mid-node and
killed workers that had done nothing wrong.

The contract reference now states what a gate costs and what it will not see:
a command proof is executed rather than declared, under a 120-second cap;
failOn ["critical"] is close to no gate at all against a judge that works at
major; and a worker reads nothing outside its worktree, so the text a node
must read belongs in the packet.

Found in the field by a peer session running a 16-node campaign in another
repository, with reproductions.
