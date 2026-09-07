import type { Message, World } from "./types";

export function Transcript({
  messages,
  world,
}: {
  messages: Message[];
  world: World;
}) {
  return (
    <div className="ow-transcript">
      {messages.length ? (
        messages.map((m) => (
          <article
            key={m.id}
            className={m.actor === "founder" ? "founder" : ""}
          >
            <header>
              <strong>
                {m.actor === "founder"
                  ? "You"
                  : m.actor === "system"
                    ? "OctiqOS"
                    : (world.agents.find((a) => a.id === m.actor)?.name ??
                      "Agent")}
              </strong>
              <time>
                {new Date(m.createdAt * 1000).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </header>
            <p>{m.body}</p>
          </article>
        ))
      ) : (
        <p className="ow-empty">No messages yet.</p>
      )}
    </div>
  );
}
