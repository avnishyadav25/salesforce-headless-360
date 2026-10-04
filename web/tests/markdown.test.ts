import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "@/lib/markdown";

describe("parseMarkdown", () => {
  it("parses the shapes the assistant uses: bold, lists, tables, headings", () => {
    const blocks = parseMarkdown(
      [
        "**Acme Global Tech** is rated **Watch**.",
        "",
        "- **Pipeline:** 2 open",
        "- **Cases:** 1 high",
        "",
        "| # | Opportunity | Amount |",
        "|---|---|---|",
        "| 1 | Acme Expansion | 125,000 |",
        "",
        "## Risks",
        "1. Close date",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "list", "table", "heading", "list"]);
    const table = blocks[2];
    expect(table?.type === "table" && table.rows[0]?.[1]).toEqual([{ type: "text", text: "Acme Expansion" }]);
    const list = blocks[4];
    expect(list?.type === "list" && list.ordered).toBe(true);
  });

  it("keeps fenced code verbatim, even unclosed while streaming", () => {
    expect(parseMarkdown("```sql\nSELECT Id FROM Case\n```")).toEqual([{ type: "code", text: "SELECT Id FROM Case" }]);
    expect(parseMarkdown("```\nSELECT")).toEqual([{ type: "code", text: "SELECT" }]);
  });

  it("never produces HTML: tags stay text", () => {
    const [para] = parseMarkdown('<img src=x onerror="alert(1)"> **hi**');
    expect(para).toEqual({
      type: "paragraph",
      children: [{ type: "text", text: '<img src=x onerror="alert(1)"> ' }, { type: "strong", children: [{ type: "text", text: "hi" }] }],
    });
  });
});

describe("parseInline", () => {
  it("allows only http(s) and mailto links", () => {
    expect(parseInline("[ok](https://example.com)")[0]).toMatchObject({ type: "link", href: "https://example.com" });
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ type: "text", text: "[x](javascript:alert(1))" }]);
  });

  it("handles code, italics and line breaks, and leaves Ids with underscores alone", () => {
    expect(parseInline("`soqlQuery` and *this*\nnext")).toEqual([
      { type: "code", text: "soqlQuery" },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "this" }] },
      { type: "br" },
      { type: "text", text: "next" },
    ]);
    expect(parseInline("Create_Follow_Up_Task_Flow")).toEqual([{ type: "text", text: "Create_Follow_Up_Task_Flow" }]);
  });
});
