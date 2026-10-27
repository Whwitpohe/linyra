export type ChangesLayout = "auto" | "sideBySide" | "stacked";
export type ToolbarAction = "toggleRepos" | "toggleCompare" | "toggleUncommitted" | "fetchAll" | "showBehind" | "fetchAndPullAll" | "pullAllBehind" | "profileSwitch" | "profileSave" | "openChangesEditor";

export interface ToolbarState {
  groupByRepo: boolean;
  compareShown: boolean;
  uncommittedShown: boolean;
  fetching: boolean;
  anyBehind: boolean;
}

/** Every old Log title action keeps its original command and implementation. */
export function toolbarCommand(action: unknown, state: ToolbarState): string | undefined {
  switch (action) {
    case "toggleRepos": return state.groupByRepo ? "polylog.hideRepos" : "polylog.showRepos";
    case "toggleCompare": return state.compareShown ? "polylog.compareHide" : "polylog.compareShow";
    case "toggleUncommitted": return state.uncommittedShown ? "polylog.uncommittedHide" : "polylog.uncommittedShow";
    case "fetchAll": return state.fetching ? "polylog.fetching" : "polylog.fetchAll";
    case "showBehind": return state.anyBehind ? "polylog.showBehind" : undefined;
    case "fetchAndPullAll": return state.fetching ? undefined : "polylog.fetchAndPullAll";
    case "pullAllBehind": return state.anyBehind && !state.fetching ? "polylog.pullAllBehind" : undefined;
    case "profileSwitch": return "polylog.profileSwitch";
    case "profileSave": return "polylog.profileSave";
    case "openChangesEditor": return "polylog.openChangesEditor";
    default: return undefined;
  }
}
