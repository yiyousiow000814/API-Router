import { describe, expect, it } from "vitest";

import { extractPlanUpdate, renderPlanCardHtml } from "./runtimePlan.js";

describe("runtimePlan", () => {
  it("preserves markdown plan bodies from raw plan items", () => {
    const plan = extractPlanUpdate(
      {
        type: "plan",
        text: [
          "## Summary",
          "",
          "- Keep the plan readable.",
          "",
          "### Assumptions",
          "- Do not restore stale pending UI.",
        ].join("\n"),
      },
      {
        threadId: "thread-1",
        normalizeType(value) {
          return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
        },
      }
    );

    expect(plan).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        title: "Updated Plan",
        markdownBody: expect.stringContaining("## Summary"),
        steps: [],
      })
    );
  });

  it("renders markdown-backed updated plans as rich text instead of synthetic step bullets", () => {
    const html = renderPlanCardHtml(
      {
        threadId: "thread-1",
        title: "Updated Plan",
        markdownBody: "## Summary\n\n- Keep headings.\n- Keep nested lists.",
        steps: [{ step: "This should not render as a step", status: "pending" }],
      },
      {
        escapeHtml(value) {
          return String(value || "");
        },
        renderRichTextHtml(value) {
          return `<section>${String(value || "")}</section>`;
        },
      }
    );

    expect(html).toContain("Updated Plan");
    expect(html).toContain("<section>## Summary");
    expect(html).not.toContain("runtimePlanSteps");
    expect(html).not.toContain("This should not render as a step");
  });
});
