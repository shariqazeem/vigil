import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE DIAGRAM IN THE README IS THE DIAGRAM IN THE REPO.
 *
 * The architecture drawing exists three times: as Mermaid source, as a rendered PNG, and inlined in
 * the README under a heading that says it is the same diagram. Two of those are generated from the
 * first and one was pasted — which is the defect shape this codebase keeps finding in itself, and it
 * had already drifted once: the README still showed a version with no console on it, under a
 * <summary> promising it was the same file.
 *
 * A judge reading the README and a developer reading docs/architecture.mmd should not be looking at
 * two different systems.
 */
const README = readFileSync("README.md", "utf8");
const MMD = readFileSync("docs/architecture.mmd", "utf8").trimEnd();

function embeddedDiagram(): string {
  const open = README.indexOf("```mermaid\n");
  expect(open, "the README should still embed the diagram").toBeGreaterThan(-1);
  const start = open + "```mermaid\n".length;
  const close = README.indexOf("```", start);
  return README.slice(start, close).trimEnd();
}

describe("the architecture diagram", () => {
  it("is embedded in the README exactly as the source file has it", () => {
    expect(embeddedDiagram()).toBe(MMD);
  });

  it("still draws the parts the README makes claims about", () => {
    // If one of these is renamed out of the diagram, the prose around it is describing something
    // the picture no longer shows.
    for (const piece of ["THE POLICY", "THE CONSOLE", "re-run the check that failed", "the catalogue", "a human"]) {
      expect(MMD, piece).toContain(piece);
    }
  });
});
