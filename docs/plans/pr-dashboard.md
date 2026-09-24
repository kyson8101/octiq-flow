# PR dashboard implementation contract

GitHub owns actual PR state. Local entries are committed branch comparisons, not persisted local PRs; a local comparison can also have a GitHub PR, and publication status is not inferred from local Git. Optional links connect a GitHub PR to one originating chat and one Workspace ticket. Agent study, review, publication, and ticket completion open separate durable chats. No merge, release, external ticket mutation, or publication happens while developing this feature.

All new command arguments and response fields use camelCase. Root paths are canonical primary repository paths; repository discovery deduplicates linked worktrees. Git/gh commands are argument arrays, noninteractive, bounded by deadlines and output caps. No checkout/fetch occurs for read operations. Git diff must disable external diff/textconv and use literal pathspecs.

## Data API

Types (TypeScript notation; nullable means actual null):
- PrRepository { root:string; name:string; branches:string[]; defaultBase:string }
- PrSummary { id:string; source:"local"|"github"; root:string; title:string; number:number|null; url:string|null; state:"local"|"open"|"draft"|"closed"|"merged"; branch:string; base:string; headSha:string; baseSha:string; author:string; updatedAt:string; commitCount:number; additions:number; deletions:number; changedFiles:number; reviewDecision:string; approved:boolean; worktreePath:string|null }
- PrList { items:PrSummary[]; warnings:string[] }
- PrFile { path:string; oldPath:string|null; status:string; additions:number; deletions:number; binary:boolean; patch:string|null; patchUnavailable:string|null }
- PrCommit { sha:string; title:string; author:string }
- PrDetail { pr:PrSummary; body:string; files:PrFile[]; commits:PrCommit[]; mergeBaseSha:string|null; warnings:string[] }
- PrPatch { text:string; binary:boolean; tooLarge:boolean }

Browser commands:
- pr_repositories {paths:string[]} -> PrRepository[]
- pr_local_list {root:string,base:string} -> PrList
- pr_remote_list {root:string,state:"open"|"closed"|"merged"|"all"} -> PrList
- pr_detail {root:string,source:"local"|"github",branch?:string,base?:string,number?:number} -> PrDetail
- pr_file_diff {root:string,baseSha:string,headSha:string,file:string,oldPath?:string|null} -> PrPatch

Local detail pins exact commit SHAs and merge-base. File diffs use mergeBaseSha to headSha. A branch moving after the detail was opened does not alter the displayed snapshot. Local files may have patch=null and are loaded lazily. GitHub detail includes available per-file patches. Missing/binary/truncated patches and list limits must be visible. Remote failure must never remove the local branch view. approved=true requires GitHub approval applicable to the current head, not approval of an older commit. Retain source differences and never silently match a fork PR to a same-named local branch.

Rust API lives in git::pull_requests. Public structs have names above, serde camelCase. Functions use matching names and ordered args as above; pr_detail(root,source,branch:Option<String>,base:Option<String>,number:Option<u64>), pr_file_diff(root,base_sha,head_sha,file,old_path:Option<String>). Backend data worker owns git.rs plus git/pull_requests.rs. Coordinator owns dispatch registrations.

## Links and completion API

- PrTicketLink { reference:string; url:string|null }
- PrTicketAction { id:string; headSha:string; status:"pending"|"running"|"confirmed"|"failed"; chatId:string|null; message:string; updatedAt:number }
- PrCompletion { state:"pending"|"completed"; trigger:"approved"|"merged"; headSha:string; completedAt:number|null; note:string }
- PrWorkflow { root:string; number:number; url:string; headSha:string; baseSha:string; chatId:string|null; ticket:PrTicketLink|null; completeOn:"approved"|"merged"; completion:PrCompletion; ticketAction:PrTicketAction|null; updatedAt:number }
- PrChatCompletion { root:string; number:number; url:string; headSha:string; trigger:"approved"|"merged"; completedAt:number }
- PrTicketLaunch { workflow:PrWorkflow; actionId:string; prompt:string; cwd:string; title:string }

Browser commands:
- pr_workflow_get {root,number} -> PrWorkflow|null
- pr_workflow_save {root,number,expectedHeadSha,chatId:string|null,ticket:PrTicketLink|null,completeOn:"approved"|"merged"} -> PrWorkflow
- pr_completion_refresh {root,number} -> PrWorkflow|null
- pr_ticket_prepare {root,number,expectedHeadSha} -> PrTicketLaunch
- pr_ticket_attach {actionId,chatId} -> PrWorkflow
- pr_ticket_confirm {actionId,confirmed:boolean,message:string} -> PrWorkflow

Lifecycle module is pr_workflow.rs. To allow independent work without depending on git worker source, define PrObservation {root,number,url,head_sha,base_sha,state,approved} (internal Rust names). The coordinator's dispatch wrappers obtain a fresh git::pull_requests::pr_detail, map verified metadata to this type, and pass it to save/refresh/prepare. NEVER expose an endpoint accepting client-supplied state or approved. Functions:
get(root:String,number:u64)->Result<Option<PrWorkflow>,String>;
save(observation:PrObservation,expected_head:String,chat_id:Option<String>,ticket:Option<PrTicketLink>,complete_on:String)->Result<PrWorkflow,String>;
refresh(observation:PrObservation)->Result<Option<PrWorkflow>,String>;
prepare_ticket(observation:PrObservation,expected_head:String)->Result<PrTicketLaunch,String>;
attach_ticket(action_id:String,chat_id:String)->Result<PrWorkflow,String>;
confirm_ticket(action_id:String,confirmed:bool,message:String)->Result<PrWorkflow,String>;
completion_for_chat(chat_id:&str)->Option<PrChatCompletion>.

Persist atomically under the profile chats directory with a mutex and schema version; errors must not silently overwrite unreadable state. Save validates linked chat exists and is not a worker controlled by orchestration, and belongs to same project as repository where possible (coordinator validates project if backend store cannot). No automatic worker task settlement. Successful trusted refresh at the configured event marks linked chat completed; later head/base changes or revoked approval reopen pending status. Merge remains separate from approval/release. Multiple links on a chat must not claim full completion while another linked PR is pending. Expose completion via optional TaskStatus.prCompletion from chat_task.rs. Emit chat-task/pull-request-workflow events after successful changes so existing views can refresh.

Ticket update is deliberately an explicit agent workflow in this iteration. prepare requires completion eligibility and a linked ticket; saves unique pending action and returns a prompt asking the agent to inspect the ticket, use Workspace tools/resolve-ticket workflow as appropriate, update development status/resolution and include the PR link with concrete verification. Respect actual ticket workflow rules and required confirmations. Do not falsely imply an automatic verified remote update. attach validates action and existing completion chat, marks running. User confirms actual update with pr_ticket_confirm (confirmed) or records failure (failed) after checking agent result. UI labels this status accurately as user-confirmed, not remotely verified. Duplicate clicks/retries must not create duplicate active actions; confirmed action for same head cannot rerun. A new PR head invalidates prior active/completed action for current completion, preserving history in storage. Old actions cannot confirm a newer head. User can retry failed actions.

Lifecycle worker owns pr_workflow.rs, lib.rs module registration, chat_task.rs addition. UI worker owns web files including chatTask.ts/ChatTaskBar.tsx rendering optional prCompletion; do not overwrite existing git delivery status.

## UI and agent launch

A first-class Pull requests button in shared topbar actions opens the full main-area dashboard. Preserve live chat state and support returning. Dashboard has project/repository selectors; Local/GitHub sources; search; remote state filter; local target branch selector; list with statuses and branch/base; selected detail Overview/Files changed/Commits; readable unified diffs with line numbers; responsive mobile list/detail navigation; meaningful loading/error/empty states; all existing Light/Dark/Fun theme tokens.

Study and Request review create independent chats with the selected model, repo/worktree cwd, exact selected head/base and PR URL. Local publish is a Create GitHub PR agent action with explicit user intent to publish that branch; no app backend git write is needed. Clearly instruct study/review agents to inspect refs without editing or posting. Link chat selector excludes orchestration workers; ticket reference and URL optional; completion trigger selector defaults merged and also supports approved. Saving and refreshing must show actual result/error.

Use existing App send/start path with an explicit new-chat context override or a carefully factored helper, never mutate active chat ID and immediately rely on stale closure state. New chat metadata must exist before process launch. Launch failures must remain visible and ticket action must be failed/retryable, never falsely confirmed. Ticket action connects returned actionId to successfully saved new chat. Main chat and running agents remain intact. Selected model/provider/access are visible and intentional; do not hardcode Astra/Fable or silently switch user's provider.

## Ownership, integration, verification

The combined review target and completed checks are recorded in
[PR dashboard integration verification](pr-dashboard-validation.md).

Workers use assigned host worktrees from local develop, never edit coordinator/other worker checkouts. No Astra or Fable subagents; use Sol only if any subdelegation were needed, but prefer none. Commit scoped changes locally (no push/deploy/restart) and report commit IDs, tests and limitations via orchestration_worker_report. Coordinator integrates commits, registers dispatch, runs end-to-end protocol tests and build into a temporary output folder (never web/dist during development), and arranges independent review. Tests should cover real parsing/snapshot/eligibility/race boundaries and useful rendered UI contracts. No production external writes or real ticket/PR mutations during verification.
