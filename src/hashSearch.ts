import { LOG_FORMAT, parseLog } from "./gitLog";
import { selectRepos } from "./filterModel";
import type { PageRequest, PageResult } from "./logQuery";
import { compareCommits, type RepoProgress } from "./mergeStream";
import { abortError, runPool } from "./pool";
import { isSha, type Commit, type RepoFailure } from "./types";

/** Git's object database resolves prefixes, including commits outside the current branch. */
export async function fetchHashPage(req: PageRequest, prefix: string): Promise<PageResult> {
  const repos = selectRepos(req.filter, req.repos);
  const progress = new Map<string, RepoProgress>(repos.map((repo) => [repo.id, { fetched: 0, pending: [], exhausted: true }]));
  const targets = req.prev ? [] : repos;
  const settled = await runPool(targets, req.concurrency, async (repo, signal) => {
    const p = progress.get(repo.id)!;
    const objects = [...new Set((await req.run(repo.root, ["rev-parse", `--disambiguate=${prefix}`], signal))
      .split(/\s+/).filter((sha) => isSha(sha) && sha.startsWith(prefix)))];
    if (objects.length === 0) return [];
    const candidates = new Set(objects);
    const types = await req.run(repo.root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], signal, { input: objects.join("\n") + "\n" });
    const hashes = types.split(/\r?\n/).flatMap((line) => {
      const [sha, type] = line.split(" ");
      return type === "commit" && candidates.has(sha) ? [sha] : [];
    }).sort();
    // Keep argv comfortably within Windows' process-command limit even for a short,
    // ambiguous prefix in a large repository. No history walk or per-object processes.
    const commits: Commit[] = [];
    for (let start = 0; start < hashes.length; start += 100) {
      const shas = hashes.slice(start, start + 100);
      commits.push(...parseLog(await req.run(repo.root, ["log", "--no-walk=unsorted", LOG_FORMAT, "--decorate=full", "--end-of-options", ...shas, "--"], signal), repo.id));
    }
    p.fetched = hashes.length;
    return commits;
  }, req.signal);
  if (req.signal.aborted) throw abortError();
  const rows: Commit[] = [];
  const failures: RepoFailure[] = [];
  settled.forEach((result, i) => {
    const repo = targets[i];
    if (result.status === "fulfilled") rows.push(...result.value);
    else {
      progress.get(repo.id)!.exhausted = true;
      failures.push({ repoId: repo.id, name: repo.name, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    }
  });
  return { rows: rows.sort(compareCommits), failures, done: [...progress.values()].every((p) => p.exhausted),
    state: { now: req.prev?.now ?? req.now, progress } };
}
