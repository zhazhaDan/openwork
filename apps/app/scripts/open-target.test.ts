import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";

import {
  classifyOpenTarget,
  deriveOpenTargets,
  isCollectibleArtifactTarget,
  selectAutoOpenTarget,
  shouldAutoOpenTarget,
} from "../src/react-app/domains/session/artifacts/open-target";

function message(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text, state: "done" }] };
}

describe("open target classification", () => {
  it("routes common artifact formats to deterministic previews", () => {
    expect(classifyOpenTarget("report.md", "file")).toBe("markdown");
    expect(classifyOpenTarget("customers.csv", "file")).toBe("sheet");
    expect(classifyOpenTarget("forecast.xlsx", "file")).toBe("sheet");
    expect(classifyOpenTarget("diagram.svg", "file")).toBe("image");
    expect(classifyOpenTarget("dist/index.html", "file")).toBe("html");
    expect(classifyOpenTarget("http://localhost:5173", "url")).toBe("browser");
  });
});

describe("deriveOpenTargets", () => {
  it("extracts file and localhost URL targets from recent assistant output", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "Created reports/revenue.xlsx and started http://localhost:5173 for preview."),
    ]);

    expect(targets.map((target) => target.value)).toContain("reports/revenue.xlsx");
    expect(targets.map((target) => target.value)).toContain("http://localhost:5173");
    expect(targets.find((target) => target.value === "reports/revenue.xlsx")?.preview).toBe("sheet");
  });

  it("extracts websocket URLs so local socket/dev-server hints stay visible", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "Socket open at ws://localhost:5173/socket and preview at dist/index.html"),
    ]);

    expect(targets.map((target) => target.value)).toContain("ws://localhost:5173/socket");
    expect(targets.map((target) => target.value)).toContain("dist/index.html");
  });

  it("normalizes Workspace/<id>/ prefixes from artifact paths", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "See Workspace/32423/reports/artifact-eval.md and Workspace/32423/reports/artifact-eval.csv"),
    ]);

    expect(targets.map((target) => target.value)).toContain("reports/artifact-eval.md");
    expect(targets.map((target) => target.value)).toContain("reports/artifact-eval.csv");
  });

  it("prefers explicit dynamic tool metadata over prose guesses", () => {
    const targets = deriveOpenTargets([
      {
        id: "msg_tool",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "write",
          toolCallId: "tool_1",
          state: "output-available",
          input: { path: "summary.md" },
          output: { path: "summary.md" },
        } as any],
      },
    ]);

    expect(targets[0]).toMatchObject({ value: "summary.md", preview: "markdown", confidence: 95 });
  });

  it("does not turn package search results into artifacts", () => {
    const targets = deriveOpenTargets([
      {
        id: "msg_tool",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "glob",
          toolCallId: "tool_1",
          state: "output-available",
          input: { pattern: "**/package.json" },
          output: {
            files: [
              "package.json",
              "apps/app/package.json",
              "packages/ui/package.json",
              "reports/revenue.csv",
            ],
          },
        } as any],
      },
      message("msg_2", "assistant", "Found package.json, apps/app/package.json, and reports/revenue.csv"),
    ]);

    expect(targets.map((target) => target.value)).not.toContain("package.json");
    expect(targets.map((target) => target.value)).not.toContain("apps/app/package.json");
    expect(targets.map((target) => target.value)).not.toContain("packages/ui/package.json");
    expect(targets.map((target) => target.value)).toContain("reports/revenue.csv");
  });

  it("does not turn discovery tool markdown listings into artifacts", () => {
    const targets = deriveOpenTargets([
      {
        id: "msg_tool",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "glob",
          toolCallId: "tool_1",
          state: "output-available",
          input: { pattern: "**/*.md" },
          output: {
            files: [
              "README.md",
              ".opencode/skills/example/SKILL.md",
              "reports/created-report.md",
            ],
          },
        } as any],
      },
      message("msg_2", "assistant", "Created reports/created-report.md as the deliverable."),
    ]);

    expect(targets.map((target) => target.value)).toContain("reports/created-report.md");
    expect(targets.map((target) => target.value)).not.toContain("README.md");
    expect(targets.map((target) => target.value)).not.toContain(".opencode/skills/example/SKILL.md");
  });

  it("does not collect server-verified missing file targets", () => {
    const target = deriveOpenTargets([
      message("msg_1", "assistant", "Preview file: index.html"),
    ])[0];

    expect(target).toMatchObject({ value: "index.html", preview: "html" });
    expect(isCollectibleArtifactTarget({ ...target, exists: false })).toBe(false);
    expect(isCollectibleArtifactTarget({ ...target, exists: true })).toBe(true);
  });

  it("prefers localhost browser previews over generated html files", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "Created public/index.html. API: `http://localhost:3000/api/info`. App: `http://localhost:3000`."),
    ]).map((target) => ({ ...target, exists: target.kind === "url" || target.value === "public/index.html" }));

    expect(targets.map((target) => target.value)).toContain("http://localhost:3000/api/info");
    expect(targets.map((target) => target.value)).toContain("http://localhost:3000");
    expect(selectAutoOpenTarget(targets)?.value).toBe("http://localhost:3000");
  });

  it("normalizes escaped localhost root URL variants into one target", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "App: `http://localhost:3000/\\` and also http://localhost:3000//"),
    ]);

    expect(targets.filter((target) => target.value === "http://localhost:3000")).toHaveLength(1);
    expect(targets.map((target) => target.name)).not.toContain("\\");
  });

  it("keeps accessible targets from earlier session messages", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "Created reports/earlier.csv"),
      ...Array.from({ length: 12 }, (_, index) => message(`msg_noise_${index}`, "assistant", `Status update ${index + 1}`)),
      message("msg_last", "assistant", "Server running at http://localhost:3000"),
    ]);

    expect(targets.map((target) => target.value)).toContain("reports/earlier.csv");
    expect(targets.map((target) => target.value)).toContain("http://localhost:3000");
  });

  it("auto-opens high-confidence deliverables and localhost previews only", () => {
    const targets = deriveOpenTargets([
      message("msg_1", "assistant", "Created data/customers.csv and see https://example.com for docs."),
    ]);
    const csv = targets.find((target) => target.value === "data/customers.csv");
    const externalUrl = targets.find((target) => target.value === "https://example.com");

    expect(csv && shouldAutoOpenTarget({ ...csv, exists: true })).toBe(true);
    expect(csv && shouldAutoOpenTarget({ ...csv, exists: false })).toBe(false);
    expect(externalUrl && shouldAutoOpenTarget(externalUrl)).toBe(false);
  });
});
