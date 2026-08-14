---
name: review-changes
description: Review local code changes for concrete correctness, regression, security, and test gaps before shipping.
whenToUse: Use when the user asks for review or before declaring a substantial implementation ready.
---

# Review changes

1. Establish the intended behavior from the request and repository guidance.
2. Inspect the complete relevant diff, including staged, unstaged, and newly added files.
3. Trace changed data and control flow into callers and tests.
4. Report only actionable findings caused by the change. Rank them by impact and cite exact files and lines.
5. Verify suspected bugs against code or a focused reproduction; do not report style preferences as defects.
6. If there are no findings, state that directly and name any verification gap that remains.
