# Route and handover name cards

Moved verbatim from AGENTS.md on 2026-11-24.

### The route and handover cards are name cards

`RouteCard` and `SourceCard` (`components/HandoverCards`) say who the work
goes to before anything else: the agent's face at 44px and its name as the
title. What the card used to be headed with (`routeHeadline`,
`handoverHeadline`: the question while it is undecided, then what is
happening) is still what the card is called (`aria-label`), and while it is
undecided its primary answer names the action and the agent. `docs/mocks/
handover-cards-namecard.html` is the mock they were built from.

- **Facts are sentences, not rows.** What kind of chat and where is one line
  (`handover.routeFact`: `Discussion · starfall`, `New chat · starfall · new
  worktree`), a handover's is two (`Takes over this task ·
  <project>`, then `handover.handoverWhere`), the files a route carries are
  `With 3 files: a, b, c`, and the chat's settings are one line of small
  print (`settingsLine`), never chips.
- **The folder is not on the card.** It is on the project's name (`Place`: a
  tip, set against its sentence so it is never wider than the card), and
  inside the opened brief (`Opens in`, or a handover's `Checkout`) for a
  screen with no pointer. A route that plans across every project has no
  one folder and shows neither.
- **That tip is shown by a state, never by `:hover` or `:focus`**
  (`lib/placeTip`, drawn from `data-open`). A pointer over the name asks for
  it, and so does the focus on it (a tap gives the name the focus; a finger
  does not hover). Escape, or a press anywhere else, sends away whatever is
  asking, and each stays away until it asks again: the pointer by leaving
  and coming back, the focus by leaving and returning. A press on the name
  asks again too. A pseudo-class is true for as long as the pointer or the focus
  stays, so Escape could not shut the tip under a pointer that had not
  moved. While the tip is shown Escape is heard on the document and always
  shuts it. It goes no further only when it is nobody else's
  (`placeTip.keepsEscape`): the focus is on the tip's own name or on
  nothing, where the same press would also leave focus mode. With the focus
  anywhere else (a form, a dialog, a field, another card) the tip shuts and
  the Escape goes on to that surface, which answers it by its own rules:
  a tip opened by a pointer must not cost a form its cancel. Two tips shown
  at once (one name focused, another hovered) both shut on the one press.
- **The envelope is the card's one disclosure**, and it is `CardFold`'s own
  line and control dressed in `HandoverCards.css` (the whole row is the
  target, the icon is a mask on the line). It keeps both labels of a route
  (`Brief · N characters`, `Exact first message · N lines`): they are two
  texts. Do not draw a second control for it; `notePress` is in the shared
  one.
- **`is-waiting` is the card that waits on the person** (`waitsOnPerson`:
  undecided, or a start that failed), and that class, not the status class
  `is-pending`, takes the decision colour and the raised quiet text.
  **Nothing on the card is the accent.** One rule is a colour the scan in
  `lib/decideColour.test.ts` forbids, on purpose, and that test names it:
  `Not passed on` (amber, a problem). The ring that breathes round the face
  while a confirmed chat is being started or gone to (`is-opening`, never on
  a card that waits) is the grey of the card's own text, `--fg-1`: opening a
  chat is not a turn in flight (the page may only be finding it), the accent
  is the model's colour (gold under Claude and in 中国风), and nothing waits
  on the person by then, so it is not `--decide` either. That test scans the
  card by the class of each part (`NAME_CARD_PARTS`): a part added to the
  card is added there, or the scan does not see it.
- **A brief too long to show cannot be handed over** (`briefOver`): the parts
  of a handover's brief are counted together against `cardFold.WHOLE_MAX`,
  the envelope gives way to the sentence, and `Hand over` and `Try again` are
  off (`aria-disabled`) while `Keep it here` and `Give up` answer. The host
  stops each part at 8,000 characters (`handover.rs`, `FIELD_MAX`), so this
  is the page's own bound, as the route card's is.
- **Confirmed, the face and the name go on to where the agent is named next**
  (`lib/identityTravel`): a route's to the composer of the chat it opened
  (`composerLanding`), a handover's into the line it leaves (`lineLanding`;
  that line shows the face at 16px in place of its mark). The top bar is not
  part of it. Copies on `document.body`, one movement of 200ms on
  `--enter-ease`, each landing unseen until its copy arrives. A card says it
  was confirmed (`rememberIdentity`) and where it is as it is drawn and as
  it leaves (`refreshIdentity`, `leaveIdentity`); whoever draws the landing
  asks (`landIdentity`).
  - **A route's travel belongs to the one confirmation that started it.**
    Its landing is found by the chat, never by the agent's name: the
    composer writes the chat it is the composer of on its identity chip
    (`data-chat`, from `session`), and `composerLanding` takes the id the
    host said the route opened (`chatIdOf(targetChatKey)`, the same id the
    page goes to). The same agent has other chats, and another project may
    have an agent of the same name; finding the landing by name sent the
    face into whichever of them the person opened. `App` keeps the travel
    (`routeTravel`: the confirmation, the chat it was pressed in, the chat
    it opened, whether the page has got there) and calls it off
    (`forgetIdentity`) the moment `routeAfter` says so, and when the card's
    hold runs out (`GOING_MS`). So a chat picked by hand, one a
    notification or the address bar brought, and a reload (the travel is
    in memory) all end it with nothing drawn. The travel is asked for only
    if the page still shows the chat it was confirmed in when the host
    answers.
  - **It stands in one chat at a time, and only while that chat is what
    the page shows** (`identityTravel.routeAfter`, one pure rule; its table
    is in `identityTravel.test.ts`). Waiting to go, that is the chat it was
    confirmed in. The first time the page shows the chat it opened it has
    arrived, and from then on that chat is the only one: back in the chat
    it was confirmed in, the copies are taken away and the landing shown
    again, as for any other chat (the composer is one element the page
    reuses, so a travel left standing hid the returning chat's own face and
    name). The open chat's id does not say the chat is on screen: `App`'s
    `chatShown` does, the one value for the five things drawn in a chat's
    place (the phone's project list, a main-area page such as Settings or
    Agents, the run panel and the task chat where
    there is no room beside them). Off screen calls the travel off, waiting or in flight, and
    nothing brings it back. The rule hangs on that value and the open chat
    in one effect, never on the callers that change them; a new thing drawn
    in the chat's place joins `chatShown`. A panel laid over the chat is
    not such a thing and does not call a travel off.
    `identityTravel.wiring.test.ts` reads `App.tsx` and `Composer.tsx` as
    text for the steps of the hand-off; its head says what that can and
    cannot show. It is not where this rule is tested.
  - **Nothing is put on the page until the frame the landing is drawn.** So
    motion that is reduced, a face with nowhere to land that can be seen
    whole (off screen, or clipped by its scroller), a chat that never
    opens, and a card that left the page more than `FRESH_MS` ago all draw
    nothing and hide nothing. The face travels or nothing does. The name
    goes with it when all of it can be read where it lands: its box can be
    seen whole, and its words are not cut short inside that box
    (`cutShort`: wider than it is drawn, which is how the composer ends a
    long name in an ellipsis; the box is whole then, so the box alone
    cannot say it). Otherwise the face goes alone and the name is where it
    now is, not hidden: a whole name flown into a place that shows half of
    it would jump as it landed. A copy and the hiding of what it lands on
    begin together and end together.
  - **What a copy lands on is shown again as it was, however that ends**:
    finished, cancelled, called off (`forgetIdentity` ends a travel in
    flight where it is), or never run (a clock clears up after three times
    the movement). A second travel to an element another is still flying
    to ends the first before it reads how the landing is drawn
    (`landingOn`), so two travels to one landing, in any order, leave it as
    it was before either.
- **The page that confirmed a route keeps its card until it has left the
  chat** (`handover.handoverTail`, `App`'s `goingRoute`). The record says
  confirmed at once, and `handoverPlaces` then drops the card, but the page
  gets to the new chat only when `onOpenChat` has found it, which may be a
  request to the host: without the hold the card was gone and the chat not
  yet there. Held, the card says `Opening the chat.`, asks nothing, and goes
  with the chat, after `GOING_MS`, or when the chat is called unavailable.
  No other page keeps it, and a handover's card is never kept.
- **A face is never the colour of a warning or an error**
  (`agentPersona.personaHue`, `WARM_HUES`): no hue from 345° round to 80°. A
  hue outside that band is the hash's own, as before; one inside takes its
  place along the band as its place along the rest of the wheel
  (`awayFromWarm`). Green and teal are not avoided: too few colours would be
  left to tell agents apart.
