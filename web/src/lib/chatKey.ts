/** The chat id behind a `chat:` key. */
export function chatIdOf(key: string): string {
  return key.startsWith("chat:") ? key.slice(5) : key;
}
