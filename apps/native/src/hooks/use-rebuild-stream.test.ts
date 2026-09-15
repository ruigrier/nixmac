import type { DarwinApplyEndEvent } from "@/ipc/types";
import { REBUILD_ERROR_CODES } from "@/lib/errors";
import { initialUiState, uiActions, useUiState, viewModelActions } from "@nixmac/state";
import { retryLastRebuild, setRebuildRetry, useCanRetryRebuild } from "@/viewmodel/rebuild-retry";
import { useHistoryRestore } from "./use-history-restore";
import { useRollback } from "./use-rollback";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRebuildStream } from "./use-rebuild-stream";

const mocks = vi.hoisted(() => ({
  applyStreamStart: vi.fn(),
  activateStorePath: vi.fn(),
  captureEvent: vi.fn(),
  refreshGitStatus: vi.fn(),
  on: vi.fn(),
  unlisten: vi.fn(),
  rollbackErase: vi.fn(),
  finalizeRollback: vi.fn(),
  prepareRestore: vi.fn(),
  finalizeRestore: vi.fn(),
  abortRestore: vi.fn(),
}));

vi.mock("@/ipc/api", () => ({
  ipcRenderer: {
    on: mocks.on,
  },
}));

vi.mock("@/lib/orpc", () => ({
  client: {
    darwin: {
      applyStreamStart: mocks.applyStreamStart,
      activateStorePath: mocks.activateStorePath,
      rollbackErase: mocks.rollbackErase,
      finalizeRollback: mocks.finalizeRollback,
      prepareRestore: mocks.prepareRestore,
      finalizeRestore: mocks.finalizeRestore,
      abortRestore: mocks.abortRestore,
    },
  },
}));

vi.mock("@/lib/telemetry/instance", () => ({
  getTelemetry: () => ({
    captureEvent: mocks.captureEvent,
  }),
}));

vi.mock("./use-git-operations", () => ({
  useGitOperations: () => ({
    refreshGitStatus: mocks.refreshGitStatus,
  }),
}));

vi.mock("@/viewmodel/history", () => ({ invalidateHistory: vi.fn() }));

function applyEndPayload(overrides: Partial<DarwinApplyEndEvent> = {}): DarwinApplyEndEvent {
  return {
    ok: false,
    code: 1,
    error_type: null,
    error: null,
    system_untouched: null,
    log_file: null,
    etc_clobber: null,
    app_management: null,
    ...overrides,
  };
}

describe("useRebuildStream", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setRebuildRetry(null);
    uiActions.setState({ ...initialUiState, rebuildPanelDismissed: false });
    mocks.on.mockResolvedValue(mocks.unlisten);
    mocks.applyStreamStart.mockResolvedValue(undefined);
    mocks.activateStorePath.mockResolvedValue(undefined);
    mocks.refreshGitStatus.mockResolvedValue(null);
    mocks.prepareRestore.mockResolvedValue(undefined);
    mocks.abortRestore.mockResolvedValue(undefined);
    mocks.finalizeRestore.mockResolvedValue(undefined);
    mocks.finalizeRollback.mockResolvedValue(undefined);
  });

  async function triggerAndFinish(payload: DarwinApplyEndEvent) {
    const { result } = renderHook(() => useRebuildStream());

    await act(async () => {
      await result.current.triggerRebuild({ context: "apply" });
    });

    const listener = mocks.on.mock.calls[0]?.[1] as
      | ((event: { payload: DarwinApplyEndEvent }) => Promise<void>)
      | undefined;
    expect(listener).toBeDefined();

    await act(async () => {
      await listener?.({ payload });
    });
  }

  it("dismisses the rebuild panel for probeable Full Disk Access failures", async () => {
    await triggerAndFinish(
      applyEndPayload({
        error_type: REBUILD_ERROR_CODES.FULL_DISK_ACCESS,
        error: "Full Disk Access required",
      }),
    );

    expect(useUiState.getState().rebuildPanelDismissed).toBe(true);
    expect(mocks.refreshGitStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps the rebuild panel visible for unprobeable App Management failures", async () => {
    await triggerAndFinish(
      applyEndPayload({
        error_type: REBUILD_ERROR_CODES.APP_MANAGEMENT,
        error: "App Management required",
      }),
    );

    expect(useUiState.getState().rebuildPanelDismissed).toBe(false);
    expect(mocks.refreshGitStatus).toHaveBeenCalledTimes(1);
  });

  async function finishLast(ok = false, errorType: DarwinApplyEndEvent["error_type"] = null) {
    const listener = mocks.on.mock.calls[mocks.on.mock.calls.length - 1][1];
    await act(async () => {
      await listener({ payload: applyEndPayload({ ok, error_type: errorType }) });
    });
  }

  it("retries the captured rollback generation and finalizes without erasing again", async () => {
    viewModelActions.setState({
      evolve: {
        backupBranch: "backup",
        committable: true,
        currentChangesetId: 2,
        evolutionId: 1,
        rollbackBranch: "rollback",
        rollbackChangesetId: 1,
        rollbackStorePath: "/nix/store/old-system",
        step: "commit",
      },
    });
    mocks.rollbackErase.mockResolvedValue({
      rollbackStorePath: "/nix/store/old-system",
      rollbackChangesetId: 1,
    });
    const { result } = renderHook(() => useRollback());
    await act(async () => {
      await result.current.handleRollback();
    });
    await finishLast();
    await act(async () => {
      await retryLastRebuild();
    });
    await finishLast(true);
    expect(mocks.activateStorePath.mock.calls).toEqual([
      [{ storePath: "/nix/store/old-system" }],
      [{ storePath: "/nix/store/old-system" }],
    ]);
    expect(mocks.rollbackErase).toHaveBeenCalledTimes(1);
    expect(mocks.applyStreamStart).not.toHaveBeenCalled();
    expect(mocks.finalizeRollback).toHaveBeenCalledWith({
      storePath: "/nix/store/old-system",
      changesetId: 1,
    });
    await retryLastRebuild();
    expect(mocks.activateStorePath).toHaveBeenCalledTimes(2);
  });

  it("prepares the same history target before each retry and preserves cleanup and finalization", async () => {
    viewModelActions.setState({ git: null });
    const calls: string[] = [];
    mocks.prepareRestore.mockImplementation(async ({ targetHash }) => {
      calls.push(`prepare:${targetHash}`);
    });
    mocks.applyStreamStart.mockImplementation(async () => {
      calls.push("build");
    });
    mocks.abortRestore.mockImplementation(async () => {
      calls.push("abort");
    });
    mocks.finalizeRestore.mockImplementation(async ({ targetHash }) => {
      calls.push(`finalize:${targetHash}`);
    });
    const { result } = renderHook(() => useHistoryRestore([], vi.fn()));
    act(() => result.current.handleRequestRestore("target-hash"));
    await act(async () => {
      result.current.handleConfirmRestore();
    });
    await finishLast(false, REBUILD_ERROR_CODES.USER_CANCELLED);
    await act(async () => {
      await retryLastRebuild();
    });
    await finishLast(false, REBUILD_ERROR_CODES.AUTHORIZATION_DENIED);
    await act(async () => {
      await retryLastRebuild();
    });
    await finishLast(true);
    expect(calls).toEqual([
      "prepare:target-hash",
      "build",
      "abort",
      "prepare:target-hash",
      "build",
      "abort",
      "prepare:target-hash",
      "build",
      "finalize:target-hash",
    ]);
  });

  it("does not expose retry until failure cleanup completes or launch two retries", async () => {
    let finishCleanup!: () => void;
    const onFailure = () =>
      new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
    const { result } = renderHook(() => ({
      ...useRebuildStream(),
      canRetry: useCanRetryRebuild(),
    }));
    await act(async () => {
      await result.current.triggerRebuild({
        context: "rollback",
        storePath: "/nix/store/old",
        onFailure,
      });
    });
    const listener = mocks.on.mock.calls[mocks.on.mock.calls.length - 1][1];
    const pending = listener({ payload: applyEndPayload() });
    expect(result.current.canRetry).toBe(false);
    await retryLastRebuild();
    expect(mocks.activateStorePath).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishCleanup();
      await pending;
    });
    expect(result.current.canRetry).toBe(true);
    await act(async () => {
      await Promise.all([retryLastRebuild(), retryLastRebuild()]);
    });
    expect(mocks.activateStorePath).toHaveBeenCalledTimes(2);
    expect(result.current.canRetry).toBe(false);
  });

  it("clears a previous rollback retry when an apply begins, including after apply failure", async () => {
    const { result } = renderHook(() => useRebuildStream());
    await act(async () => {
      await result.current.triggerRebuild({ context: "rollback", storePath: "/nix/store/old" });
    });
    await finishLast();
    await act(async () => {
      await result.current.triggerRebuild({ context: "apply" });
    });
    await finishLast();
    await retryLastRebuild();
    expect(mocks.activateStorePath).toHaveBeenCalledTimes(1);
    expect(mocks.applyStreamStart).toHaveBeenCalledTimes(1);
  });
  it.each(["history", "rollback"])(
    "clears old retry while %s preparation is pending",
    async (kind) => {
      const stale = vi.fn();
      let release!: () => void;
      const preparation = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.prepareRestore.mockReturnValueOnce(preparation);
      mocks.rollbackErase.mockImplementationOnce(async () => {
        await preparation;
        return { rollbackStorePath: null, rollbackChangesetId: null };
      });
      const { result } = renderHook(() => ({
        history: useHistoryRestore([], vi.fn()),
        rollback: useRollback(),
        canRetry: useCanRetryRebuild(),
      }));
      act(() => {
        setRebuildRetry(stale);
      });
      let pending: Promise<void> | undefined;
      await act(async () => {
        if (kind === "history") {
          result.current.history.handleRequestRestore("new-target");
        } else {
          pending = result.current.rollback.handleRollback();
        }
      });
      if (kind === "history") {
        await act(async () => {
          result.current.history.handleConfirmRestore();
        });
      }
      const availableDuringPreparation = result.current.canRetry;
      await act(async () => {
        await retryLastRebuild();
        release();
        await pending;
      });
      expect(availableDuringPreparation).toBe(false);
      expect(stale).not.toHaveBeenCalled();
    },
  );

  it.each(["event", "start rejection"])(
    "does not replace a newer retry after delayed %s cleanup",
    async (failure) => {
      let release!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        release = resolve;
      });
      const onFailure = vi.fn(() => cleanup);
      const { result } = renderHook(() => useRebuildStream());
      if (failure === "start rejection") {
        mocks.activateStorePath.mockRejectedValueOnce(new Error("start failed"));
      }
      let pending!: Promise<void>;
      await act(async () => {
        const started = result.current.triggerRebuild({
          context: "rollback",
          storePath: "/nix/store/older",
          onFailure,
        });
        if (failure === "start rejection") pending = started;
        else await started;
      });
      if (failure === "event") {
        await act(async () => {
          pending = mocks.on.mock.calls[0][1]({ payload: applyEndPayload() });
        });
      }
      expect(onFailure).toHaveBeenCalledTimes(1);
      await act(async () => {
        await result.current.triggerRebuild({ context: "rollback", storePath: "/nix/store/newer" });
      });
      await finishLast();
      await act(async () => {
        release();
        await pending;
        await retryLastRebuild();
      });
      expect(mocks.activateStorePath.mock.calls).toEqual([
        [{ storePath: "/nix/store/older" }],
        [{ storePath: "/nix/store/newer" }],
        [{ storePath: "/nix/store/newer" }],
      ]);
    },
  );

  async function startHistory() {
    viewModelActions.setState({ git: null });
    const hook = renderHook(() => ({
      ...useHistoryRestore([], vi.fn()),
      canRetry: useCanRetryRebuild(),
    }));
    act(() => {
      hook.result.current.handleRequestRestore("target-hash");
    });
    await act(async () => {
      hook.result.current.handleConfirmRestore();
    });
    return hook;
  }

  it.each(["command", "listener"])(
    "aborts prepared history after %s registration/start rejection and can retry",
    async (failure) => {
      const error = new Error(`${failure} unavailable`);
      if (failure === "command") mocks.applyStreamStart.mockRejectedValueOnce(error);
      else mocks.on.mockRejectedValueOnce(error);
      const { result } = await startHistory();
      expect(mocks.abortRestore).toHaveBeenCalledTimes(1);
      expect(useUiState.getState().isProcessing).toBe(false);
      expect(result.current.canRetry).toBe(true);
      await act(async () => {
        await retryLastRebuild();
      });
      expect(mocks.prepareRestore).toHaveBeenCalledTimes(2);
      await finishLast(true);
      expect(mocks.finalizeRestore).toHaveBeenCalledWith({ targetHash: "target-hash" });
    },
  );

  it("reports abort rejection without exposing an unsafe history retry", async () => {
    mocks.abortRestore.mockRejectedValueOnce(new Error("abort failed"));
    const { result } = await startHistory();
    await finishLast();
    expect(result.current.canRetry).toBe(false);
    expect(useUiState.getState().error).toContain("abort failed");
    await act(async () => {
      await retryLastRebuild();
    });
    expect(mocks.prepareRestore).toHaveBeenCalledTimes(1);
  });

  it("reports finalize rejection without replaying an already successful activation", async () => {
    mocks.finalizeRestore.mockRejectedValueOnce(new Error("finalize failed"));
    const { result } = await startHistory();
    await finishLast(true);
    expect(useUiState.getState().error).toContain("finalize failed");
    expect(result.current.canRetry).toBe(false);
    await act(async () => {
      await retryLastRebuild();
    });
    expect(mocks.applyStreamStart).toHaveBeenCalledTimes(1);
  });

  it("does not abort twice if an end event precedes command rejection", async () => {
    let reject!: (error: Error) => void;
    mocks.applyStreamStart.mockImplementationOnce(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    await startHistory();
    await finishLast();
    await act(async () => {
      reject(new Error("late command rejection"));
    });
    expect(mocks.abortRestore).toHaveBeenCalledTimes(1);
  });

  it("does not revive old retry while a new history preparation is pending", async () => {
    let releaseCleanup!: () => void;
    let releasePreparation!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    mocks.prepareRestore.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePreparation = resolve;
        }),
    );
    const { result } = renderHook(() => ({
      ...useRebuildStream(),
      canRetry: useCanRetryRebuild(),
    }));
    await act(async () => {
      await result.current.triggerRebuild({
        context: "rollback",
        storePath: "/nix/store/old",
        onFailure: () => cleanup,
      });
    });
    let pending!: Promise<void>;
    await act(async () => {
      pending = mocks.on.mock.calls[0][1]({ payload: applyEndPayload() });
    });
    await startHistory();
    await act(async () => {
      releaseCleanup();
      await pending;
    });
    const availableDuringPreparation = result.current.canRetry;
    await act(async () => {
      await retryLastRebuild();
      releasePreparation();
    });
    expect(availableDuringPreparation).toBe(false);
    expect(mocks.activateStorePath).toHaveBeenCalledTimes(1);
  });
});
