export type ChangesLayout = "auto" | "sideBySide" | "stacked";
export type ToolbarAction = "toggleRepos" | "toggleCompare" | "fetchAll" | "showBehind" | "fetchAndPullAll" | "pullAllBehind" | "profileSwitch" | "profileSave"
  | "updateProject" | "pushAll" | "branchesAcross" | "aiConfigure" | "aiSwitch" | "aiRemove";

export interface ToolbarState {
  groupByRepo: boolean;
  compareShown: boolean;
  fetching: boolean;
  anyBehind: boolean;
}

/** Every old Log title action keeps its original command and implementation. */
export function toolbarCommand(action: unknown, state: ToolbarState): string | undefined {
  switch (action) {
    case "toggleRepos": return state.groupByRepo ? "linyra.hideRepos" : "linyra.showRepos";
    case "toggleCompare": return state.compareShown ? "linyra.compareHide" : "linyra.compareShow";
    case "fetchAll": return state.fetching ? "linyra.fetching" : "linyra.fetchAll";
    case "showBehind": return state.anyBehind ? "linyra.showBehind" : undefined;
    case "fetchAndPullAll": return state.fetching ? undefined : "linyra.fetchAndPullAll";
    case "pullAllBehind": return state.anyBehind && !state.fetching ? "linyra.pullAllBehind" : undefined;
    case "profileSwitch": return "linyra.profileSwitch";
    case "profileSave": return "linyra.profileSave";
    case "updateProject": return state.fetching ? undefined : "linyra.updateProject";
    case "pushAll": return "linyra.pushAll";
    case "branchesAcross": return "linyra.branchesAcross";
    case "aiConfigure": return "linyra.ai.configure";
    case "aiSwitch": return "linyra.ai.switchModel";
    case "aiRemove": return "linyra.ai.removeProfile";
    default: return undefined;
  }
}
