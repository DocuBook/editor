// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../../../frontend/lib/ipc", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

import { pollGitStatus, useGitStatus } from "../../../frontend/stores/gitStatus";
import { useAuth } from "../../../frontend/stores/auth";
import { useVaultStore } from "../../../frontend/stores/vault";

/** The backend's git_status payload for a working repository. */
const repoPayload = () =>
  JSON.stringify({
    isRepo: true,
    hasRemote: true,
    branch: "main",
    upstream: "origin/main",
    status: "",
    ahead: 0,
    behind: 0,
    pushTarget: "origin",
    hasCommits: true,
    remotes: ["origin"],
    state: "clean",
  });

describe("git status polling", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    invoke.mockResolvedValue(repoPayload());
    useAuth.setState({ status: "ready" });
    useVaultStore.setState({ isOpen: true });
  });

  it("does not call the backend while unauthenticated", async () => {
    useAuth.setState({ status: "login" });
    await pollGitStatus(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not call the backend while no vault is open", async () => {
    useVaultStore.setState({ isOpen: false });
    await pollGitStatus(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stops re-polling a known non-repo vault, and a forced call re-probes it", async () => {
    // Learn repo-ness (forced), then plain events must not keep asking a vault
    // that has no .git — the continuous-request traffic the 3s timer caused.
    invoke.mockResolvedValue(JSON.stringify({ ...JSON.parse(repoPayload()), isRepo: false }));
    await pollGitStatus(true);
    expect(invoke).toHaveBeenCalledTimes(1);

    invoke.mockClear();
    await pollGitStatus();
    await pollGitStatus();
    expect(invoke).not.toHaveBeenCalled();

    // git init / vault reopen is a forced event — it probes again.
    await pollGitStatus(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("lets the next event re-probe after a transient backend failure", async () => {
    await pollGitStatus(true); // normalize: repo-ness known
    invoke.mockClear();

    invoke.mockRejectedValueOnce(new Error("backend down"));
    await pollGitStatus(true);
    expect(useGitStatus.getState().isRepo).toBe(false);

    // The failure reset the gate, so the next event asks again instead of being
    // stuck on the empty state.
    invoke.mockResolvedValueOnce(repoPayload());
    await pollGitStatus();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(useGitStatus.getState().branch).toBe("main");
  });
});