// Pull request query building, kept separate so it can be tested without
// starting a server or touching the network.

export function quote(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export type PrFilters = {
  state: string;
  author?: string;
  author_account_id?: string;
  destination_branch?: string;
  source_branch?: string;
};

/** Build the BBQL `q` value for the pull request list endpoint. */
export function buildPrQuery(f: PrFilters): string {
  const q = [`state = "${quote(f.state)}"`];
  if (f.author) q.push(`author.nickname = "${quote(f.author)}"`);
  if (f.author_account_id) q.push(`author.account_id = "${quote(f.author_account_id)}"`);
  if (f.destination_branch) q.push(`destination.branch.name = "${quote(f.destination_branch)}"`);
  // Substring match: a branch is rarely known in full.
  if (f.source_branch) q.push(`source.branch.name ~ "${quote(f.source_branch)}"`);
  return q.join(' AND ');
}
