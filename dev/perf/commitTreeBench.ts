// Times the Commit side bar's model with many uncommitted files: describing the tree (every store
// change and every check redraws it) and a check on a folder. The tree itself is VS Code's native
// one, which draws only the rows on screen. Dev-only.
//   npx esbuild dev/perf/commitTreeBench.ts --bundle --platform=node --outfile=out/perf/commitTreeBench.js && node out/perf/commitTreeBench.js
import { describeCommit, rowsById, setChecked, type CommitRow } from "../../src/commitModel";
import type { FileChange } from "../../src/types";
import type { RepoWork } from "../../src/uncommittedModel";

function works(files: number): RepoWork[] {
  return ["acme-web", "acme-api", "acme-libs"].map((name, r) => {
    const changes: FileChange[] = [];
    const staged: FileChange[] = [];
    for (let i = 0; i < Math.ceil(files / 3); i++) {
      const path = `src/module-${i % 40}/part-${i}.ts`;
      if (i % 9 === 0) changes.push({ path: `new/${i}.ts`, added: null, deleted: null, untracked: true });
      else if (i % 4 === 0) staged.push({ path, added: null, deleted: null, status: "M", staged: true });
      else changes.push({ path, added: null, deleted: null, status: i % 13 === 0 ? "D" : "M" });
    }
    return { repoId: `/work/${name}`, root: `/work/${name}`, name, head: "a".repeat(40), staged, changes, editedAt: null, canStage: true, branch: { name: "main", upstream: "origin/main", ahead: r, behind: 0 } } as RepoWork;
  });
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function time(fn: () => void, reps = 15): number {
  const out: number[] = [];
  for (let i = 0; i < reps; i++) { const t = performance.now(); fn(); out.push(performance.now() - t); }
  return median(out);
}

for (const files of [300, 1000, 3000]) {
  const w = works(files);
  let choices = new Map<string, boolean>();
  let roots: CommitRow[] = [];
  const describe = time(() => { roots = describeCommit(w, choices).roots; });
  const folder = [...rowsById(roots).values()].find((r) => r.kind === "folder")!;
  const check = time(() => { choices = setChecked(w, choices, [folder], false); describeCommit(w, choices); });
  const count = rowsById(roots).size;
  console.log(`${String(files).padStart(5)} files (${count} rows): describe ${describe.toFixed(2)} ms, check a folder and describe again ${check.toFixed(2)} ms`);
}
