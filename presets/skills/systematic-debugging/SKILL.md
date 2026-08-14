---
name: systematic-debugging
description: Diagnose failures from runtime evidence before editing code.
whenToUse: Use for bugs, test failures, crashes, hangs, and unexpected behavior.
---

# Systematic debugging

1. Reproduce the exact symptom with the smallest safe command.
2. Capture the complete error, inputs, environment, and boundary where expected behavior diverges.
3. Form one falsifiable hypothesis at a time and test it with focused instrumentation or an existing diagnostic.
4. Follow values backward to the first incorrect state; do not patch the last visible exception unless it is the cause.
5. Add or identify a regression check that fails for the original bug.
6. Make the smallest causal fix, rerun the regression check, then run proportionate surrounding checks.
