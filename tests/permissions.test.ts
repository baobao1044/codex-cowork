import { describe, expect, it } from "vitest";

import { resolveWorkspace } from "../src/config.js";
import { isChannelAllowed, isUserAuthorized } from "../src/discord/permissions.js";
import { buildTestConfig } from "./helpers.js";

describe("permissions", () => {
  const config = buildTestConfig("C:\\workspace");

  it("authorizes the configured owner", () => {
    expect(isUserAuthorized("owner-1", [], config.discord)).toBe(true);
  });

  it("authorizes trusted roles", () => {
    expect(isUserAuthorized("user-1", ["role-1"], config.discord)).toBe(true);
  });

  it("rejects untrusted users", () => {
    expect(isUserAuthorized("user-1", ["role-2"], config.discord)).toBe(false);
  });

  it("allows parent channels for managed threads", () => {
    expect(isChannelAllowed("thread-1", "channel-1", config.discord.allowedChannelIds)).toBe(true);
  });

  it("rejects unknown workspace keys and raw paths", () => {
    expect(() => resolveWorkspace(config.workspaces, "C:\\raw-path")).toThrow("Unknown workspace key");
  });
});
