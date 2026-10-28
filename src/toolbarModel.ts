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
    case "toggleRepos": return state.groupByRepo ? "linyra.hideRepos" : "linyra.showRepos";
    case "toggleCompare": return state.compareShown ? "linyra.compareHide" : "linyra.compareShow";
    case "toggleUncommitted": return state.uncommittedShown ? "linyra.uncommittedHide" : "linyra.uncommittedShow";
    case "fetchAll": return state.fetching ? "linyra.fetching" : "linyra.fetchAll";
    case "showBehind": return state.anyBehind ? "linyra.showBehind" : undefined;
    case "fetchAndPullAll": return state.fetching ? undefined : "linyra.fetchAndPullAll";
    case "pullAllBehind": return state.anyBehind && !state.fetching ? "linyra.pullAllBehind" : undefined;
    case "profileSwitch": return "linyra.profileSwitch";
    case "profileSave": return "linyra.profileSave";
    case "openChangesEditor": return "linyra.openChangesEditor";
    default: return undefined;
  }
}
