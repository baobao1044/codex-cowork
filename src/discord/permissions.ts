import type { AppConfig } from "../types.js";

export function isUserAuthorized(
  userId: string,
  roleIds: string[],
  config: AppConfig["discord"],
): boolean {
  if (config.ownerUserIds.includes(userId)) {
    return true;
  }

  return roleIds.some((roleId) => config.trustedRoleIds.includes(roleId));
}

export function isChannelAllowed(
  channelId: string,
  parentChannelId: string | null,
  allowedChannelIds: string[],
): boolean {
  if (allowedChannelIds.length === 0) {
    return true;
  }

  return allowedChannelIds.includes(channelId) || (parentChannelId !== null && allowedChannelIds.includes(parentChannelId));
}
