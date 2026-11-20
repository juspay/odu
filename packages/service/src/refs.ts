declare const SHA: unique symbol;
declare const BRANCH: unique symbol;

export type Sha = string & { readonly [SHA]: true };
export type BranchName = string & { readonly [BRANCH]: true };

export function parseSha(raw: string): Sha | null {
  return /^[0-9a-fA-F]{7,40}$/.test(raw) ? (raw as Sha) : null;
}

export type ParsedBranch =
  | { ok: true; name: BranchName }
  | { ok: false; problem: string };

export function parseBranchName(raw: string): ParsedBranch {
  const problem = branchNameProblem(raw);
  return problem === null
    ? { ok: true, name: raw as BranchName }
    : { ok: false, problem };
}

function branchNameProblem(name: string): string | null {
  if (name === "") return "it is empty";
  if (name.startsWith("-")) return "git reads a leading dash as an option";
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) {
    return "it holds a character git refuses in a ref (space, control, or one of ~^:?*[\\)";
  }
  if (name.includes("..")) return "`..` separates two refs";
  if (name.includes("@{")) return "`@{` names a reflog entry";
  if (name === "@") return "`@` is git's own name for HEAD";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return "a ref's path components cannot be empty";
  }
  if (name.endsWith(".") || name.endsWith(".lock")) {
    return "a ref cannot end with `.` or `.lock`";
  }
  if (name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    return "no path component may begin with `.` or end with `.lock`";
  }
  return null;
}
