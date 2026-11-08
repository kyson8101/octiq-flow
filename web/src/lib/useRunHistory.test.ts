import {expect,it,vi} from "vitest";
vi.mock("./bridge",()=>({bridge:{}}));
import {withRunHistory} from "./useRunHistory";
import {EMPTY_ORCHESTRATION, type OrchestrationSnapshot} from "./orchestration";
import {runWaits} from "./runWaits";
const view=(status:OrchestrationSnapshot["runs"][number]["status"],archivedAt?:number):OrchestrationSnapshot=>({
 ...EMPTY_ORCHESTRATION,summary:true,
 runs:[{id:"r",objective:"Work",workspaceId:"p",rootPath:"/fixture",maxConcurrent:1,createdAt:1,updatedAt:1,status,archivedAt,planApproval:{status:"pending",revision:1,requestedAt:1},coordinatorChatKey:"chat:main"}],
 tasks:[{id:"t",runId:"r",title:"Task",status:"pending",spec:"",dependsOn:[],createdAt:1,updatedAt:1}],runRevisions:{r:"old:1"},
});
it("never restores a formerly active run missing from the current reading",()=>{
 const result=withRunHistory({...EMPTY_ORCHESTRATION,summary:true},view("running"));expect(result.runs).toEqual([]);expect(result.tasks).toEqual([]);
});
it.each(["closed","stopped","archived"] as const)("keeps on-demand %s history and the one wait reading",status=>{
 const history=view(status==="archived"?"completed":status,status==="archived"?1:undefined);
 const result=withRunHistory({...EMPTY_ORCHESTRATION,summary:true},history);
 expect(result.runs).toHaveLength(1);expect(runWaits(result,result.runs[0]).person).toEqual([]);
});
it("uses the current revision and state when a historical run is restored",()=>{
 const history=view("closed",1),current=view("running");current.runs[0].planApproval!.revision=2;current.runRevisions={r:"new:2"};
 const result=withRunHistory(current,history);expect(result.runs).toEqual(current.runs);expect(result.tasks).toEqual(current.tasks);expect(result.runRevisions).toEqual({r:"new:2"});
});
