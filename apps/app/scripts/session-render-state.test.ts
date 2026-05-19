import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import {
  deriveRenderedSessionMessages,
  resolveRenderedSessionSnapshot,
} from "../src/react-app/domains/session/surface/session-render-state";
import { reconcileTranscriptMessages } from "../src/react-app/domains/session/sync/transcript-reconcile";

function snapshotWithMessages(
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>,
  sessionId = "ses_test",
): OpenworkSessionSnapshot {
  return {
    session: {
      id: sessionId,
      parentID: undefined,
      title: "Test session",
      time: { created: 1, updated: 2 },
      share: undefined,
      version: "0",
    },
    messages: messages.map((message, index) => ({
      info: {
        id: message.id,
        role: message.role,
        sessionID: sessionId,
        time: { created: index + 1 },
      },
      parts: [
        {
          id: `part_${message.id}`,
          type: "text",
          text: message.text,
          sessionID: sessionId,
          messageID: message.id,
        },
      ],
    })),
    todos: [],
    status: { type: "idle" },
  } as unknown as OpenworkSessionSnapshot;
}

function uiMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text, state: "done" }],
  };
}

function snapshotWithText(text: string, sessionId = "ses_test"): OpenworkSessionSnapshot {
  return snapshotWithMessages([{ id: "msg_user", role: "user", text }], sessionId);
}

describe("reconcileTranscriptMessages", () => {
  it("hydrates an empty transcript cache from the snapshot", () => {
    const snapshot = [uiMessage("msg_user", "user", "hello")];

    expect(reconcileTranscriptMessages({
      currentMessages: [],
      snapshotMessages: snapshot,
      reason: "snapshot",
    })).toBe(snapshot);
  });

  it("does not clear live messages when a snapshot is temporarily empty", () => {
    const current = [
      uiMessage("msg_user", "user", "latest prompt"),
      uiMessage("msg_assistant", "assistant", "latest answer"),
    ];

    expect(reconcileTranscriptMessages({
      currentMessages: current,
      snapshotMessages: [],
      reason: "snapshot",
    })).toBe(current);
  });

  it("keeps older cached messages when a busy snapshot only contains the active tail", () => {
    const merged = reconcileTranscriptMessages({
      snapshotMessages: [uiMessage("msg_current_user", "user", "latest prompt")],
      currentMessages: [
        uiMessage("msg_old_user", "user", "old prompt"),
        uiMessage("msg_old_assistant", "assistant", "old answer"),
        uiMessage("msg_current_user", "user", "latest"),
      ],
      reason: "snapshot",
    });

    expect(merged.map((message) => message.id)).toEqual([
      "msg_old_user",
      "msg_old_assistant",
      "msg_current_user",
    ]);
    expect(merged[2]?.parts[0]).toMatchObject({ text: "latest prompt" });
  });

  it("keeps snapshot history and live-only tail messages together", () => {
    const merged = reconcileTranscriptMessages({
      currentMessages: [
        uiMessage("msg_current_user", "user", "latest prompt"),
        uiMessage("msg_current_assistant", "assistant", "streaming answer"),
      ],
      snapshotMessages: [
        uiMessage("msg_old_user", "user", "old prompt"),
        uiMessage("msg_old_assistant", "assistant", "old answer"),
      ],
      reason: "snapshot",
    });

    expect(merged.map((message) => message.id)).toEqual([
      "msg_old_user",
      "msg_old_assistant",
      "msg_current_user",
      "msg_current_assistant",
    ]);
  });

  it("keeps longer live text when the snapshot lags the event stream", () => {
    const merged = reconcileTranscriptMessages({
      currentMessages: [
        uiMessage("msg_user", "user", "hello"),
        uiMessage("msg_assistant", "assistant", "finished answer"),
      ],
      snapshotMessages: [
        uiMessage("msg_user", "user", "hello"),
        uiMessage("msg_assistant", "assistant", "finished"),
      ],
      reason: "snapshot",
    });

    expect(merged[1]?.parts[0]).toMatchObject({ text: "finished answer" });
  });
});

describe("deriveRenderedSessionMessages", () => {
  it("falls back to snapshot messages when transcript cache is empty", () => {
    const messages = deriveRenderedSessionMessages({
      transcriptState: [],
      snapshot: snapshotWithText("still here"),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "still here",
    });
  });

  it("keeps live transcript cache when it covers the snapshot", () => {
    const cached: UIMessage[] = [
      {
        id: "msg_user",
        role: "assistant",
        parts: [{ type: "text", text: "live text", state: "done" }],
      },
    ];

    expect(deriveRenderedSessionMessages({
      transcriptState: cached,
      snapshot: snapshotWithText("snapshot text"),
    })).toBe(cached);
  });

  it("renders the canonical live cache without merging snapshot history", () => {
    const messages = deriveRenderedSessionMessages({
      transcriptState: [
        {
          id: "msg_current_user",
          role: "user",
          parts: [{ type: "text", text: "latest prompt", state: "done" }],
        },
        {
          id: "msg_current_assistant",
          role: "assistant",
          parts: [{ type: "text", text: "streaming answer", state: "streaming" }],
        },
      ],
      snapshot: snapshotWithMessages([
        { id: "msg_old_user", role: "user", text: "old prompt" },
        { id: "msg_old_assistant", role: "assistant", text: "old answer" },
      ]),
    });

    expect(messages.map((message) => message.id)).toEqual([
      "msg_current_user",
      "msg_current_assistant",
    ]);
  });

  it("keeps live-only tail messages instead of merging a stale snapshot during render", () => {
    const messages = deriveRenderedSessionMessages({
      transcriptState: [
        uiMessage("msg_current_user", "user", "latest prompt"),
        uiMessage("msg_current_assistant", "assistant", "latest answer"),
      ],
      snapshot: snapshotWithMessages([
        { id: "msg_old_user", role: "user", text: "old prompt" },
        { id: "msg_old_assistant", role: "assistant", text: "old answer" },
      ]),
    });

    expect(messages.map((message) => message.id)).toEqual([
      "msg_current_user",
      "msg_current_assistant",
    ]);
  });

  it("returns an empty list only when there is no cache or snapshot content", () => {
    expect(deriveRenderedSessionMessages({
      transcriptState: [],
      snapshot: null,
    })).toEqual([]);
  });

  it("does not use a cached snapshot from a different session", () => {
    const snapshot = resolveRenderedSessionSnapshot({
      sessionId: "ses_next",
      currentSnapshot: null,
      cachedRendered: {
        sessionId: "ses_previous",
        snapshot: snapshotWithText("previous session", "ses_previous"),
      },
    });

    expect(snapshot).toBeNull();
    expect(deriveRenderedSessionMessages({
      transcriptState: [],
      snapshot,
    })).toEqual([]);
  });

  it("keeps a cached snapshot for the current session while live cache is empty", () => {
    const cached = snapshotWithText("current session", "ses_current");
    const snapshot = resolveRenderedSessionSnapshot({
      sessionId: "ses_current",
      currentSnapshot: null,
      cachedRendered: {
        sessionId: "ses_current",
        snapshot: cached,
      },
    });

    expect(snapshot).toBe(cached);
    expect(deriveRenderedSessionMessages({
      transcriptState: [],
      snapshot,
    })[0]?.parts[0]).toMatchObject({ text: "current session" });
  });
});
