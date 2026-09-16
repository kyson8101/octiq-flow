Feature: Personal command board protects human attention
  Ideas, delegated execution and personal commitments share durable records
  while only deliberate actions admit work to the founder's attention.

  @PCB-001 @card-01
  Scenario: Existing work remains the same work after upgrade
    Given existing projects and tasks have conversations, results and running work
    When the command board becomes available
    Then their identities, ownership, evidence and progress are preserved
    And no additional work is started or accepted by the upgrade

  @PCB-002 @card-01
  Scenario: Opening an upgraded board again changes nothing
    Given an existing board has already been upgraded
    When the board is loaded again
    Then no task, decision, history entry or reward is duplicated
    And unsupported saved states remain recoverable instead of being silently reclassified

  @PCB-003 @card-01
  Scenario: Tracked assignment does not authorize agent execution
    Given a tracked task names an agent as its owner
    When the task is captured, opened or assigned
    Then no agent execution begins without a separate explicit execution action

  @PCB-004 @card-02
  Scenario: Capture an idea with only a title
    Given I have a new idea and have not selected a project
    When I capture its title
    Then it is stored in Inbox with me as owner and no current attention needed
    And it does not activate a task or project

  @PCB-005 @card-02
  Scenario: Captured ideas survive return and retry
    Given I submitted an idea and could not tell whether it was saved
    When I retry the same capture and later reopen Inbox
    Then the idea appears exactly once with the original saved content

  @PCB-006 @card-02
  Scenario: Track work without a configured agent or workspace
    Given I have no registered agent, provider account or project folder
    When I capture work and name a human or agent owner
    Then I can manage that tracked work without configuring execution

  @PCB-007 @card-03
  Scenario: A third focused project requires an explicit swap
    Given two projects are Active and the Active project limit is two
    When I try to activate another project
    Then I see the current commitments and the activation is refused
    And only an explicit valid swap or settings change can make capacity

  @PCB-008 @card-03
  Scenario: Background does not hide personal commitments
    Given an Active project has my Active execution tasks
    When I move it to Background
    Then I must explicitly choose what happens to those tasks
    And defined delegated work can continue without counting as my active execution

  @PCB-009 @card-03
  Scenario: Parking stops execution without deleting its evidence
    Given a project has in-flight work
    When I confirm parking it after seeing the affected work
    Then new and resumed execution is prevented and in-flight work is stopped
    And prior results and file-change evidence remain visible
    And unpark alone does not resume work

  @PCB-010 @card-03
  Scenario: Project detail describes its outcome and work
    Given a project has a goal, milestone, owner and tasks
    When I open it
    Then I see its status, goal, milestone, owner, active, blocked and review work
    And I can find recent completed work and stored Someday ideas

  @PCB-011 @card-03
  Scenario: Focus settings apply globally and persist
    Given I configure focus limits and an optional default project
    When I return through a different organization or project view
    Then the same personal limits apply across my projects
    And lowering a hard limit cannot silently discard current commitments

  @PCB-012 @card-04
  Scenario: Clarification precedes activation
    Given an Inbox idea has insufficient outcome, project or ownership information
    When I try to make it Ready or Active
    Then I am asked to supply the missing definition
    And a defined idea can become Ready without starting it

  @PCB-013 @card-04
  Scenario: A fourth personal execution task cannot start
    Given three tasks require my Active execution and my limit is three
    When I attempt to activate another personal execution task
    Then it remains queued for later and I see the three existing commitments
    And priority alone does not override the limit

  @PCB-014 @card-04
  Scenario: Delegated work uses separate execution capacity
    Given my three personal execution slots are full
    When a defined delegated task with no current personal attention starts
    Then it does not consume a personal execution slot
    And its other project and review gates still apply

  @PCB-015 @card-04
  Scenario: Simultaneous starts and swaps cannot overfill focus
    Given only one personal execution slot remains
    When two attempts to activate personal work happen at the same time
    Then at most one additional task becomes Active
    And an explicit swap either completes together or changes neither task

  @PCB-016 @card-04
  Scenario: A blocker states how it can be removed
    Given work cannot continue
    When I mark it Blocked
    Then a reason, required action and waiting-for party are recorded
    And a blocker needing my judgment carries decision attention

  @PCB-017 @card-04
  Scenario: Waiting and paused work must reacquire capacity
    Given a task is Waiting, Blocked or deliberately paused to Ready
    When I resume personal execution
    Then its project and current capacity are checked again
    And entering Waiting never presents it as work I am doing now

  @PCB-018 @card-04
  Scenario: Editing metadata cannot bypass focus rules
    Given active work is subject to project and attention rules
    When I change owner, attention, project, priority or due date
    Then the same commitment rules remain enforced
    And raising priority never promotes or starts work automatically

  @PCB-019 @card-04
  Scenario: Closing and reopening preserve the acceptance boundary
    Given a task has a result requiring review
    When I try to mark it Done without approving that result
    Then completion is refused
    And cancellation retains history while reopening requires a new ready-to-start work cycle

  @PCB-020 @card-05
  Scenario: Command collects personal needs across projects
    Given decisions, reviews and personal work exist in multiple projects and organizations I own
    When I open Command
    Then I can find My Decisions, My Reviews and My Active Work in one place
    And each item identifies its project

  @PCB-021 @card-05
  Scenario: Delegation stays quiet and attention is not duplicated
    Given an agent is executing without needing me and another task is blocked on my decision
    When I open Command
    Then the executing task is absent from my personal attention queues
    And the blocked question appears once in My Decisions
    And running and other blocked work remain available in a quiet monitor

  @PCB-022 @card-05
  Scenario: Large queues stay bounded without hiding their size
    Given more items need decisions or review than fit in the initial Command list
    When I open Command
    Then I see a small stable selection, truthful totals and access to all remaining items
    And older unresolved items remain discoverable
    And routine arrivals do not interrupt me

  @PCB-023 @card-05
  Scenario: Task context is usable on desktop and phone
    Given I am viewing Command on a desktop or a narrow phone screen
    When I open and close task details using pointer or keyboard controls
    Then I can read the task and perform its available actions
    And returning preserves my queue context and accessible focus

  @PCB-024 @card-06
  Scenario: Today has three primary and two minor slots
    Given Today already contains three primary and two minor selections
    When I try to add another selection to either group
    Then that group refuses the extra selection until I explicitly remove or replace one

  @PCB-025 @card-06
  Scenario: Selecting Today does not start the work
    Given a task belongs to a project and is Ready, Blocked, Active or Review
    When I select it for Today
    Then neither its task status nor its project status changes
    And starting it still requires the normal activation gates

  @PCB-026 @card-06
  Scenario: Today survives reload without becoming tomorrow's backlog
    Given I selected work for a date in my configured local timezone
    When I reload or open Today on the next date
    Then the original day's selection remains readable
    And unfinished selections are not automatically copied into the new day

  @PCB-027 @card-07
  Scenario: A decision carries enough context to answer
    Given only I can resolve a work question
    When the task enters My Decisions
    Then I can read its question, available context, options and recommendation
    And absent options or recommendations are not invented

  @PCB-028 @card-07
  Scenario: Resolving a blocker records a decision without claiming execution finished
    Given a task is blocked on my decision
    When I resolve it with a choice and rationale
    Then a dated decision entry links the project, owner and task
    And the execution task returns to Ready without starting work
    And a decision-only task can complete after its decision is recorded

  @PCB-029 @card-07
  Scenario: Changing a decision preserves the original rationale
    Given an earlier decision has a recorded choice and rationale
    When I revise that decision later
    Then the new decision identifies which earlier decision it supersedes
    And both dated decisions remain readable after the task is completed

  @PCB-030 @card-07
  Scenario: A Background project can queue a decision quietly
    Given delegated work in a Background project needs my judgment
    When its question is recorded
    Then it appears in My Decisions without activating the project
    And it does not create an urgent interruption or resume execution

  @PCB-031 @card-08
  Scenario: Record delegated results without starting an agent
    Given a tracked task belongs to a named human or agent
    When I record its result and supporting evidence
    Then the result and its version are saved without starting an execution process
    And its configured review policy determines whether it awaits review

  @PCB-032 @card-08
  Scenario: A submitted review remains unaccepted until I approve it
    Given delegated work requires my review
    When an output is submitted
    Then it enters Review with review attention
    And ordinary completion cannot bypass approval

  @PCB-033 @card-08
  Scenario: Process a batch of outputs with explicit outcomes
    Given several outputs await review
    When I review them in a focused session
    Then I can approve, request changes, reject or comment on each item
    And approval completes it, rejection cancels it with a reason, and comments alone do not change status
    And the session preserves my place

  @PCB-034 @card-08
  Scenario: Requested changes respect current capacity
    Given an output needs changes
    When I request changes and its start gates pass or fail
    Then its owner and previous evidence are retained
    And it becomes Active when admitted or Ready with the gating reason when not admitted

  @PCB-035 @card-08
  Scenario: An approval belongs to the output I actually saw
    Given an output changed after I opened its review
    When I attempt to approve the old version
    Then acceptance is refused until I inspect the current version
    And retrying an already accepted approval does not duplicate its history or rewards

  @PCB-036 @card-08
  Scenario: Review pressure prevents new work but never loses completed work
    Given five outputs await review and the threshold is five
    When a new review-producing task attempts to start and in-flight work also finishes
    Then the new start is held and the completed output is saved into Review
    And the overflow is visible rather than hidden or discarded

  @PCB-037 @card-08
  Scenario: Admitted work can finish while review pressure is high
    Given an existing authorized work cycle still has execution steps remaining
    When the pending review threshold is reached
    Then that cycle can finish its remaining steps and submit its result
    And new cycles and rework must pass the threshold gate
    And clearing the pressure does not automatically start waiting work

  @PCB-038 @card-09
  Scenario: Kanban reflects the shared lifecycle
    Given tasks exist in the supported workflow states
    When I open Kanban
    Then Inbox, Ready, Active, Blocked, Waiting, Review and Done show the same task records
    And Someday and Cancelled do not clutter the main columns

  @PCB-039 @card-09
  Scenario: Dragging cannot bypass lifecycle checks
    Given a task is missing clarification, capacity or a required review
    When I drag it to a state it cannot enter
    Then required information or the refusal reason is shown
    And its saved state and visible position remain consistent

  @PCB-040 @card-09
  Scenario: Keyboard and touch can perform the same guarded moves
    Given I cannot or do not want to drag a task
    When I use its move action by keyboard or touch
    Then I can perform the same permitted transitions with the same checks

  @PCB-041 @card-10
  Scenario: Store an idea in Someday deliberately
    Given I captured an idea into Inbox
    When I choose to shelve it in Someday
    Then I can save why it interests me and a possible future trigger
    And no task or project becomes Active

  @PCB-042 @card-10
  Scenario: Someday is quiet storage
    Given an idea is in Someday with a future trigger
    When I browse Command or the trigger becomes relevant
    Then the idea remains available in Someday without overdue-guilt or interruption
    And it is not automatically promoted or executed

  @PCB-043 @card-10
  Scenario: Revisit an idea through normal clarification
    Given I choose to revisit a Someday idea
    When I promote it
    Then it passes clarification to become Ready
    And activation still requires the current project and WIP gates

  @PCB-044 @card-11
  Scenario: Search finds durable work and decisions
    Given text exists in task titles, descriptions and notes, project goals, and resolved decisions
    When I search for that text
    Then matching records identify their type and project and open their preserved context
    And finished tasks do not make related decisions disappear

  @PCB-045 @card-11
  Scenario: Filters combine without changing capacity
    Given tasks have different projects, states, owners, attention, priorities, tags and due dates
    When I combine or clear those filters
    Then the result set matches the selected criteria
    And the global commitment counts do not change with the visible subset

  @PCB-046 @card-11
  Scenario: History explains how work reached its current state
    Given a task was created, assigned, blocked, answered, submitted, changed and approved
    When I open its history
    Then I see the saved actors, times and changes in order with links to decisions and reviews
    And retries do not duplicate events and unknown old history is not invented

  @PCB-047 @card-11
  Scenario: Search and history respect context boundaries
    Given saved notes and evidence include untrusted text and records from several contexts
    When I search or open history
    Then results are bounded and safely displayed within my permitted context
    And worker-specific access remains limited to its authorized projects

  @PCB-048 @card-12
  Scenario: Complete the daily attention loop
    Given captured ideas, two focused projects, delegated work and pending decisions and reviews
    When I open the finished command board for my daily session
    Then I can resolve decisions, review outputs, choose up to three primary tasks and identify my next work
    And the rest remains queued without forcing me to visit each project
    And a usability check records whether I can identify my next work within ten seconds

  @PCB-049 @card-12
  Scenario: Concurrent and interrupted actions preserve commitments
    Given the last project or personal work slot is contested and some requests are retried after interruption
    When those actions finish and I return to the board
    Then hard limits hold and accepted changes and histories appear exactly once
    And completed outputs remain available even above the review threshold

  @PCB-050 @card-12
  Scenario: The existing office workflow remains usable
    Given existing managed tasks, scopes, conversations and verification outcomes
    When I use Office or the new Command view after the upgrade
    Then both refer to the same work and preserve its execution and permission boundaries
    And incomplete tests or uncertain work are never presented as accepted results

  @PCB-051 @card-12
  Scenario: A full board can recover through deliberate review and pausing
    Given my work slots and review queue are full
    When I approve an output, pause selected work and explicitly resume an eligible task
    Then I can make progress without a hidden override
    And no paused, waiting or completed task restarts by itself

