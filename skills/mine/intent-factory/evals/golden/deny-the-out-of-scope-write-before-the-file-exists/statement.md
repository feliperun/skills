fix(intent-factory): deny the out-of-scope write before the file exists

The delivered write-scope decision passed any target that was not already
on disk, reasoning that a missing path cannot be proven out of scope. That
rule belongs to the two read decisions, where a file that cannot be measured
genuinely cannot be judged. Scope membership is a fact about the path.

The effect was that decision 1 only ever fired on an overwrite, and creating
a new file anywhere outside the declared scope -- the ordinary violation --
went through. The test encoded the same reasoning twice and contradicted
itself: one assertion said scope is judged on the path alone, the next said
a not-yet-created file cannot be judged.
