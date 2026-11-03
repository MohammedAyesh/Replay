import { describe, expect, it } from "vitest";
import { splitMentions } from "./chat-mentions";

describe("splitMentions", () => {
  it("separates mentions from the words around them", () => {
    expect(splitMentions("Hi @962795550003 and @962795550099 ok")).toEqual([
      { text: "Hi ", phone: null },
      { text: "@962795550003", phone: "962795550003" },
      { text: " and ", phone: null },
      { text: "@962795550099", phone: "962795550099" },
      { text: " ok", phone: null },
    ]);
  });

  it("ignores an @ that isn't followed by a phone number", () => {
    expect(splitMentions("See you at 5 @ the pitch")).toEqual([{ text: "See you at 5 @ the pitch", phone: null }]);
  });
});
