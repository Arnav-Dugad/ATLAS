import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseSseBlock } from "./ai";
import { Markdown } from "./markdown";

describe("parseSseBlock", () => {
  it("parses named events and ignores pings", () => {
    expect(parseSseBlock('event: token\ndata: {"text":"Hi"}')).toEqual({ event: "token", data: { text: "Hi" } });
    expect(parseSseBlock(": ping")).toBeNull();
    expect(parseSseBlock("event: ping\ndata: 1")).toBeNull();
    expect(parseSseBlock("event: token\ndata: {broken")).toBeNull();
  });
});

describe("Markdown", () => {
  const ref = (id: string, key: string) => (
    <button key={key} data-ref={id}>
      {id}
    </button>
  );

  it("renders lists, emphasis and incident references", () => {
    const { container } = render(<Markdown text={"**Two** events:\n- M6.1 [ATL-EQ-2026-ABCD1234]\n- *quiet* `code`"} renderRef={ref} />);
    expect(container.querySelector("strong")?.textContent).toBe("Two");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("[data-ref]")?.getAttribute("data-ref")).toBe("ATL-EQ-2026-ABCD1234");
    expect(container.querySelector("em")?.textContent).toBe("quiet");
  });

  it("never turns model output into HTML", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> <script>bad()</script> [link](javascript:alert(1))'} renderRef={ref} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<script>");
  });
});
