import { describe, expect, it } from "vitest";

import { extractRequestUserInput } from "./runtimeUserInput.js";

describe("runtimeUserInput", () => {
  it("extracts request_user_input tool payloads into pending-question data", () => {
    expect(
      extractRequestUserInput({
        id: "tool-1",
        type: "toolCall",
        tool: "request_user_input",
        arguments: JSON.stringify({
          questions: [
            {
              id: "scope",
              header: "Question 1/1",
              question: "Which scope?",
              options: [
                { label: "Current chat", description: "Bind to current thread." },
              ],
            },
          ],
        }),
      })
    ).toEqual({
      id: "tool-1",
      prompt: "Which scope?",
      title: "",
      questions: [
        {
          id: "scope",
          header: "Question 1/1",
          question: "Which scope?",
          options: [
            { label: "Current chat", description: "Bind to current thread." },
          ],
        },
      ],
    });
  });
});
