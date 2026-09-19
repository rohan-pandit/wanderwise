import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdownLite } from "./markdown-lite";

describe("parseInline", () => {
  it("splits plain text with no emphasis into one text segment", () => {
    expect(parseInline("just plain text")).toEqual([{ type: "text", text: "just plain text" }]);
  });

  it("parses bold segments", () => {
    expect(parseInline("check in at **Baixa Riverside Suites** today")).toEqual([
      { type: "text", text: "check in at " },
      { type: "bold", text: "Baixa Riverside Suites" },
      { type: "text", text: " today" },
    ]);
  });

  it("parses italic segments", () => {
    expect(parseInline("*Monday, October 6* is arrival day")).toEqual([
      { type: "italic", text: "Monday, October 6" },
      { type: "text", text: " is arrival day" },
    ]);
  });

  it("parses bold and italic in the same line", () => {
    expect(parseInline("**Flights** and *Hotel* sections")).toEqual([
      { type: "bold", text: "Flights" },
      { type: "text", text: " and " },
      { type: "italic", text: "Hotel" },
      { type: "text", text: " sections" },
    ]);
  });

  it("handles a whole-line emphasis with nothing before or after", () => {
    expect(parseInline("**Your Lisbon Adventure**")).toEqual([{ type: "bold", text: "Your Lisbon Adventure" }]);
  });
});

describe("parseMarkdownLite", () => {
  it("joins consecutive non-blank lines into one paragraph", () => {
    const source = "Get ready for a wonderful week exploring Lisbon.\nHere's how your trip comes together.";
    expect(parseMarkdownLite(source)).toEqual([
      {
        type: "paragraph",
        inline: [{ type: "text", text: "Get ready for a wonderful week exploring Lisbon. Here's how your trip comes together." }],
      },
    ]);
  });

  it("separates paragraphs on blank lines", () => {
    const source = "First paragraph.\n\nSecond paragraph.";
    expect(parseMarkdownLite(source)).toEqual([
      { type: "paragraph", inline: [{ type: "text", text: "First paragraph." }] },
      { type: "paragraph", inline: [{ type: "text", text: "Second paragraph." }] },
    ]);
  });

  it("parses a bold section header on its own line as a paragraph with a bold segment", () => {
    expect(parseMarkdownLite("**Flights**")).toEqual([
      { type: "paragraph", inline: [{ type: "bold", text: "Flights" }] },
    ]);
  });

  it("parses a real markdown heading line", () => {
    expect(parseMarkdownLite("## Day-by-Day Itinerary")).toEqual([
      { type: "heading", level: 2, inline: [{ type: "text", text: "Day-by-Day Itinerary" }] },
    ]);
  });

  it("groups consecutive bullet lines into one unordered list", () => {
    const source = "- Tram 28 ride\n- Alfama walking tour\n- Fado show";
    expect(parseMarkdownLite(source)).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          [{ type: "text", text: "Tram 28 ride" }],
          [{ type: "text", text: "Alfama walking tour" }],
          [{ type: "text", text: "Fado show" }],
        ],
      },
    ]);
  });

  it("groups consecutive ordered lines into one ordered list", () => {
    const source = "1. Arrive in Lisbon\n2. Check into hotel\n3. Explore Alfama";
    const blocks = parseMarkdownLite(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: true });
  });

  it("does not mistake a single-asterisk emphasis line for a bullet (no space after the leading asterisk)", () => {
    expect(parseMarkdownLite("*Monday, October 6 – Arrival Day*")).toEqual([
      { type: "paragraph", inline: [{ type: "italic", text: "Monday, October 6 – Arrival Day" }] },
    ]);
  });

  it("ends a list when a blank line or a plain paragraph line follows", () => {
    const source = "- First item\n- Second item\n\nBack to prose.";
    expect(parseMarkdownLite(source)).toEqual([
      {
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "First item" }], [{ type: "text", text: "Second item" }]],
      },
      { type: "paragraph", inline: [{ type: "text", text: "Back to prose." }] },
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseMarkdownLite("")).toEqual([]);
  });

  it("strips a leaked tool-call artifact already persisted in older trip data, instead of rendering raw tags", () => {
    const source = 'Enjoy your trip!</explanation>\n<parameter name="groundedIds">["a1"]';
    expect(parseMarkdownLite(source)).toEqual([
      { type: "paragraph", inline: [{ type: "text", text: "Enjoy your trip!" }] },
    ]);
  });
});
