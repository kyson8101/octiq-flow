// A suggestion only: reading still requires the founder's explicit button click.
export function suggestedWorkspacePath(message: string): string {
  const quoted = message.match(/["'`]((?:\/Users\/|\/Volumes\/|\/home\/|\/mnt\/|\/tmp\/|\/private\/)[^"'`\n]+)["'`]/u)?.[1];
  const path = quoted ?? message.match(/\/(?:Users|Volumes|home|mnt|tmp|private)\/[^\s,，;；"'`<>]+/u)?.[0] ?? "";
  return path.replace(/[。.!?]+$/u, "").replace(/\/[^/]+\.(?:md|txt|json|ya?ml|toml)$/iu, "");
}
