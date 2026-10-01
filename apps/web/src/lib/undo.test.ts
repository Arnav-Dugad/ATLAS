import { afterEach, describe, expect, it, vi } from "vitest";
import { showUndo, undoNow, useUndo } from "./undo";

afterEach(() => vi.useRealTimers());

describe("undo toasts", () => {
  it("Undo restores and never commits", () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    const commit = vi.fn();
    showUndo("Removed", { undo, commit });
    undoNow();
    vi.advanceTimersByTime(10_000);
    expect(undo).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(useUndo.getState().toast).toBeNull();
  });

  it("commits a deferred action when the toast expires", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    showUndo("Key will be removed", { undo: () => undefined, commit }, 6000);
    vi.advanceTimersByTime(5999);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("a newer toast commits the previous one instead of dropping it", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    showUndo("First", { undo: () => undefined, commit: first });
    showUndo("Second", { undo: () => undefined });
    expect(first).toHaveBeenCalledOnce();
    expect(useUndo.getState().toast?.message).toBe("Second");
  });
});
