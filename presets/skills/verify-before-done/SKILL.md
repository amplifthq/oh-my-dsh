---
name: verify-before-done
description: Require fresh evidence before claiming an implementation, fix, build, or test is complete.
whenToUse: Use before any completion claim or handoff.
---

# Verify before done

1. Identify the exact command or observation that proves each claim.
2. Run it fresh after the final edit.
3. Read the complete exit status and relevant output; do not infer one check from another.
4. For a bug fix, reproduce the original symptom or run a regression test that exercises it.
5. Reconcile the implementation against every requested requirement, not only the passing tests.
6. Report the evidence and any check that could not be run. Never replace missing evidence with confidence language.
