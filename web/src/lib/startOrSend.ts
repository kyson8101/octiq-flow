// The page's start-or-send for one message, with the host's start/send
// flip-flop dealt with in one place.
//
// While another start of the same chat is in progress (its claim is held, its
// session is not in the table yet) the host answers `chat_start` with
// "already running" and `chat_send` with "no such chat". Both are refusals
// that record nothing, so the message was NOT delivered, and the other start
// usually finishes within a moment. The page therefore starts again after a
// short wait, a few times, and only then says the message was not taken.

const ALREADY_RUNNING = "already running";
const NO_SUCH_CHAT = "no such chat";

/** Rounds of start + send before the page gives up (the first one included). */
export const START_ROUNDS = 3;
/** Wait before round 2 and round 3. Kept short: the other start is under way. */
export const START_BACKOFF_MS = [400, 800] as const;

/** What the person is told when the host kept refusing: the message was not
 * taken, so it can be restored and sent again without a duplicate. */
export const STARTED_ELSEWHERE =
  "The agent was starting elsewhere and did not take this message. Restore it and send again.";

const said = (error: unknown) => String((error as Error)?.message ?? error);

export type StartOutcome =
  | { ok: true }
  /** `refused`: the host definitely did not take the message (it recorded
   * nothing), as opposed to an error whose outcome is not known. */
  | { ok: false; error: unknown; refused: boolean };

export async function startOrSend(io: {
  start: () => Promise<unknown>;
  /** Absent when the message must not go to a running process (a model switch). */
  send?: () => Promise<unknown>;
  /** False when this send is no longer the current one (the lead changed). */
  current?: () => boolean;
  wait?: (ms: number) => Promise<void>;
}): Promise<StartOutcome> {
  const wait = io.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const stale: StartOutcome = {
    ok: false, error: "Checking with the server. Send again in a moment.", refused: false,
  };
  for (let round = 0; round < START_ROUNDS; round++) {
    if (round > 0) {
      await wait(START_BACKOFF_MS[Math.min(round - 1, START_BACKOFF_MS.length - 1)]);
      if (io.current && !io.current()) return stale;
    }
    try {
      await io.start();
      return { ok: true };
    } catch (err) {
      // The process is already up, or is being started elsewhere: talk to it.
      if (!io.send || !said(err).includes(ALREADY_RUNNING)) return { ok: false, error: err, refused: false };
    }
    if (io.current && !io.current()) return stale;
    try {
      await io.send();
      return { ok: true };
    } catch (second) {
      if (!said(second).includes(NO_SUCH_CHAT)) return { ok: false, error: second, refused: false };
      // Start refused it ("already running") and send refused it ("no such
      // chat"): the session is not in the table yet. Go round again.
    }
  }
  return { ok: false, error: new Error(STARTED_ELSEWHERE), refused: true };
}
