# Pull requests

Open **Pull requests** in the chat toolbar to review a project's work. The
dashboard preserves the chat you were reading and its running agents.

Choose a project and repository, then a source:

- **Local** compares committed branch changes with a selected target. These are
  unpublished changes, including branches in retained worktrees. The comparison
  starts at the merge base; it does not include uncommitted working-copy edits.
- **GitHub** lists actual pull requests through the server machine's `gh`
  installation and account. Local comparisons remain available when GitHub
  cannot be reached. Install and authenticate `gh` on that machine if needed.

The detail view contains the overview, changed files, and commits. File previews
belong to the selected commit snapshot. Binary files, unavailable patches, and
truncated results are identified rather than shown as empty changes.

## Agent actions

**Study** asks an agent to explain the change. **Request review** asks for concrete
correctness findings and validation gaps. Each action starts a separate chat with
the selected model, read-only access, and the PR's repository, commit, and base
in its instructions. The original work chat continues independently.

A local comparison can start **Create GitHub PR**, an agent action to publish the
selected branch and create its GitHub PR. Merely opening or refreshing the
dashboard does not publish branches or change the current checkout.

## Optional links

A GitHub PR can link to an originating chat, a Workspace ticket, both, or neither.
Save these links in the PR's completion controls. A linked chat must be an
ordinary chat in a project containing the repository; orchestration worker task
settlement remains the orchestrator's responsibility.

Choose whether **approval** or **merge** completes the linked chat. Merge is the
default. Refreshing completion obtains current evidence from GitHub. The chat's
Completed indicator is separate from its existing Git delivery and release
status. If several PRs link to one chat, all must satisfy their completion rule.

Approval applies to the reviewed commit. New head/base commits or revoked
approval can return completion to pending. The stored result records what was
verified; it is not a webhook subscription and does not continuously poll GitHub.

## Ticket completion

After the PR meets its completion rule, a linked ticket can start a completion
agent. The agent receives the ticket reference and PR evidence, inspects the
ticket through the available Workspace tools, and follows its required update
and confirmation process. A successful agent launch means the work started; it
does not mean the external ticket was updated.

The dashboard retains the completion chat and action status. After checking the
agent's result, confirm the ticket update or record a failure and retry. A
confirmed action is explicitly **user-confirmed**, not an independently verified
ticket-system receipt. Duplicate active actions are prevented, and an old action
cannot confirm completion for a newer PR snapshot.

Browsing, linking, studying, and reviewing do not merge PRs, restart the server,
delete worktrees, or settle orchestration tasks.
