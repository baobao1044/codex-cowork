export function sanitizeThreadName(goal: string): string {
  const collapsed = goal
    .replace(/[`*_~|>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return collapsed.length > 0 ? `codex ${collapsed}` : "codex task";
}

export function stripBotMention(content: string, botUserId: string): string {
  const mentionPatterns = [`<@${botUserId}>`, `<@!${botUserId}>`];
  let result = content;

  for (const pattern of mentionPatterns) {
    result = result.replace(pattern, "");
  }

  return result.trim();
}

export function renderBulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}
