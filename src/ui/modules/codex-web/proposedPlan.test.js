import { describe, expect, it } from "vitest";

import { extractProposedPlanArtifacts } from "./proposedPlan.js";

describe("proposedPlan", () => {
  it("extracts a proposed plan block into a plan card and local confirmation question", () => {
    const result = extractProposedPlanArtifacts(`
Before

<proposed_plan>
# Fix Pending State

Tighten cancellation cleanup.

- Clear working
- Remove stale commentary
</proposed_plan>
    `, {
      threadId: "thread-1",
      itemId: "assistant-1",
    });

    expect(result.cleanedText).toBe("Before");
    expect(result.plan).toEqual({
      threadId: "thread-1",
      turnId: "",
      title: "Fix Pending State",
      explanation: "Tighten cancellation cleanup.",
      steps: [
        { step: "Clear working", status: "pending" },
        { step: "Remove stale commentary", status: "pending" },
      ],
      kind: "proposed",
      markdownBody: "# Fix Pending State\n\nTighten cancellation cleanup.\n\n- Clear working\n- Remove stale commentary",
      deltaText: "",
    });
    expect(result.planMessage).toEqual(expect.objectContaining({
      kind: "planCard",
      role: "system",
      plan: expect.objectContaining({ title: "Fix Pending State" }),
    }));
    expect(result.pendingConfirmation).toEqual(expect.objectContaining({
      id: "plan_confirm:thread-1:assistant-1",
      threadId: "thread-1",
      prompt: "Implement this plan?",
    }));
  });

  it("extracts a markdown proposed plan section without xml tags", () => {
    const result = extractProposedPlanArtifacts(`
Context before plan.

Proposed Plan
## Fix Runtime Cleanup

Tighten interrupt handling.

- Clear stale pending
- Remove empty commentary archive

Implement this plan?
1. Yes, implement this plan
2. No, stay in Plan mode
    `, {
      threadId: "thread-2",
      itemId: "assistant-2",
    });

    expect(result.cleanedText).toBe("Context before plan.");
    expect(result.plan).toEqual(expect.objectContaining({
      threadId: "thread-2",
      title: "Fix Runtime Cleanup",
      explanation: "Tighten interrupt handling.",
      kind: "proposed",
      steps: [
        { step: "Clear stale pending", status: "pending" },
        { step: "Remove empty commentary archive", status: "pending" },
      ],
    }));
    expect(result.planMessage?.kind).toBe("planCard");
    expect(result.pendingConfirmation?.prompt).toBe("Implement this plan?");
  });

  it("extracts plan markdown when the response only contains the plan body plus the decision prompt", () => {
    const result = extractProposedPlanArtifacts(`
# Fix Plan Rendering

## Summary
Ensure the web client recognizes plan responses even when the wrapper heading is omitted.

### Changes
- Detect standalone plan markdown before the confirmation prompt
- Render the inline plan card and local confirmation question

### Test Plan
- Reproduce with a terminal plan response

Implement this plan?
1. Yes, implement this plan
2. No, stay in Plan mode
Press enter to confirm or esc to go back
    `, {
      threadId: "thread-3",
      itemId: "assistant-3",
    });

    expect(result.cleanedText).toBe("");
    expect(result.plan).toEqual(expect.objectContaining({
      threadId: "thread-3",
      title: "Fix Plan Rendering",
      explanation: "Ensure the web client recognizes plan responses even when the wrapper heading is omitted.",
      kind: "proposed",
    }));
    expect(result.planMessage?.kind).toBe("planCard");
    expect(result.pendingConfirmation?.prompt).toBe("Implement this plan?");
  });
});
