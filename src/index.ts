#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { readFileSync } from 'node:fs';
import { buildPrQuery } from './query.js';

// Bitbucket Cloud removed app passwords on 2026-07-28. Basic auth now takes the
// Atlassian account email plus an API token.
const EMAIL = process.env.ATLASSIAN_EMAIL;
const TOKEN = process.env.BITBUCKET_API_TOKEN;

if (!EMAIL || !TOKEN) {
  console.error(
    'Missing credentials. Set ATLASSIAN_EMAIL (your Atlassian account email) and ' +
      'BITBUCKET_API_TOKEN (create one at https://id.atlassian.com/manage-profile/security/api-tokens).'
  );
  process.exit(1);
}

const API = 'https://api.bitbucket.org/2.0';
const AUTH = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

const HINTS: Record<number, string> = {
  401:
    '\n  - ATLASSIAN_EMAIL must be your Atlassian account email, not your Bitbucket username and not the token name.' +
    '\n  - The API token must have scopes. A token created without any scope returns exactly this error, with an empty body.' +
    '\n    Needed: read:repository:bitbucket and read:pullrequest:bitbucket.' +
    '\n    read:pullrequest already covers commenting, so no write scope is required.' +
    '\n  - Use "Create API token with scopes" at https://id.atlassian.com/manage-profile/security/api-tokens' +
    '\n    and pick Bitbucket. The plain "Create API token" button makes a token with no scopes, which cannot work here.',
  403:
    '\n  - Authenticated, but not permitted. Either the token is missing the scope for this call,' +
    '\n    or your account has no access to this repository.',
  404:
    '\n  - Check workspace and repo_slug: they are the two segments in bitbucket.org/<workspace>/<repo_slug>.' +
    '\n  - A repository your token cannot see also answers 404, not 403.',
};

async function bb(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: AUTH, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    // Bitbucket answers some failures with a full HTML error page. Cap it so a
    // failed call cannot flood the model's context.
    const raw = (await res.text()).trim();
    const body = raw.length > 400 ? raw.slice(0, 400) + ` … [+${raw.length - 400} chars]` : raw;
    throw new Error(
      `Bitbucket ${res.status} ${res.statusText} on ${path}: ${body || '(empty body)'}` +
        (HINTS[res.status] ?? '')
    );
  }
  return res;
}

// Optional so a single-repo setup can pin them once in the client config
// instead of repeating them on every call.
const repo = {
  workspace: z
    .string()
    .optional()
    .describe('Bitbucket workspace ID, e.g. "acme". Defaults to BITBUCKET_WORKSPACE.'),
  repo_slug: z
    .string()
    .optional()
    .describe('Repository slug, e.g. "billing-api". Defaults to BITBUCKET_REPO_SLUG.'),
};

function target(a: { workspace?: string; repo_slug?: string }) {
  const workspace = a.workspace ?? process.env.BITBUCKET_WORKSPACE;
  const repo_slug = a.repo_slug ?? process.env.BITBUCKET_REPO_SLUG;
  if (!workspace || !repo_slug) {
    throw new Error(
      'No repository. Pass workspace and repo_slug, or set BITBUCKET_WORKSPACE and ' +
        'BITBUCKET_REPO_SLUG in the server environment. They are the two segments in ' +
        'bitbucket.org/<workspace>/<repo_slug>.'
    );
  }
  return { workspace, repo_slug };
}

const server = new McpServer({ name: 'bitbucket-mcp', version: '0.1.0' });

server.registerTool(
  'list_pull_requests',
  {
    title: 'List pull requests',
    description: 'List pull requests in a Bitbucket Cloud repository.',
    inputSchema: z.object({
      ...repo,
      state: z
        .enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'])
        .default('OPEN')
        .describe('Filter by PR state'),
      author: z
        .string()
        .optional()
        .describe(
          'Filter by author account nickname, exact match, e.g. "Enes Polovina". ' +
            'Bitbucket can only filter on the nickname, which is usually the display name ' +
            'but is absent on many bot and service accounts. Use author_account_id for those.'
        ),
      author_account_id: z
        .string()
        .optional()
        .describe('Filter by author account_id. Exact, and works for accounts with no nickname.'),
      destination_branch: z
        .string()
        .optional()
        .describe('Filter by target branch, exact match, e.g. "main" or "release/2.4"'),
      source_branch: z
        .string()
        .optional()
        .describe('Filter by source branch, substring match, e.g. "PROJ" matches "fix/PROJ-142"'),
      limit: z
        .number()
        .int()
        .max(200)
        .default(50)
        .describe('Maximum PRs to return. Pages are followed until this many are collected.'),
    }),
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const { workspace, repo_slug } = target(args);
    const { state, author, author_account_id, destination_branch, source_branch, limit } = args;
    // Bitbucket caps a page at 50, so anything past that needs the `next` cursor.
    // Filtering happens server-side through BBQL, which is what makes this usable
    // on a repository with thousands of pull requests.
    const q = buildPrQuery({
      state,
      author,
      author_account_id,
      destination_branch,
      source_branch,
    });

    const values: any[] = [];
    let url =
      `/repositories/${workspace}/${repo_slug}/pullrequests` +
      `?pagelen=50&q=${encodeURIComponent(q)}`;
    let more = false;

    while (url) {
      const page = (await (await bb(url)).json()) as { values?: any[]; next?: string };
      values.push(...(page.values ?? []));
      if (values.length >= limit) {
        more = values.length > limit || Boolean(page.next);
        break;
      }
      // `next` comes back absolute; bb() prefixes API, so strip it.
      url = page.next ? page.next.replace(API, '') : '';
    }

    const prs = values.slice(0, limit).map((pr) => ({
      id: pr.id,
      title: pr.title,
      author: pr.author?.display_name,
      source: pr.source?.branch?.name,
      destination: pr.destination?.branch?.name,
      created_on: pr.created_on,
      url: pr.links?.html?.href,
    }));

    const text = prs.length
      ? prs
          .map(
            (pr) =>
              `#${pr.id} ${pr.title}\n  ${pr.author} · ${pr.source} → ${pr.destination} · ${pr.created_on}\n  ${pr.url}`
          )
          .join('\n\n') + (more ? `\n\n(showing ${prs.length}, more match — raise limit or narrow the filters)` : '')
      : `No ${state} pull requests match.` +
        (author
          ? '\n\nNote: author matches the account nickname, which some accounts — bots and ' +
            'service accounts especially — do not have. Retry without author, or pass ' +
            'author_account_id, before concluding this person has no pull requests.'
          : '');

    return { content: [{ type: 'text', text }] };
  }
);

server.registerTool(
  'get_diff',
  {
    title: 'Get pull request diff',
    description: 'Fetch the unified diff for a pull request.',
    inputSchema: z.object({
      ...repo,
      pull_request_id: z.number().int().describe('Pull request number'),
      max_chars: z
        .number()
        .int()
        .default(100_000)
        .describe('Truncate the diff past this many characters'),
    }),
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const { workspace, repo_slug } = target(args);
    const { pull_request_id, max_chars } = args;
    // Bitbucket 302-redirects this to the diff blob; fetch follows by default.
    const res = await bb(`/repositories/${workspace}/${repo_slug}/pullrequests/${pull_request_id}/diff`);
    const diff = await res.text();
    const text =
      diff.length > max_chars
        ? diff.slice(0, max_chars) +
          `\n\n[truncated: ${diff.length} chars total, showing first ${max_chars}]`
        : diff;
    return { content: [{ type: 'text', text: text || '(empty diff)' }] };
  }
);

server.registerTool(
  'post_comment',
  {
    title: 'Comment on a pull request',
    description:
      'Post a comment on a pull request. Provide path and line to attach it to a specific line of the diff.',
    inputSchema: z.object({
      ...repo,
      pull_request_id: z.number().int().describe('Pull request number'),
      content: z.string().describe('Comment body, Markdown'),
      path: z.string().optional().describe('File path for an inline comment'),
      line: z
        .number()
        .int()
        .optional()
        .describe('Line number in the new version of the file, requires path'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (args) => {
    const { workspace, repo_slug } = target(args);
    const { pull_request_id, content, path, line } = args;
    const body: Record<string, unknown> = { content: { raw: content } };
    if (path) body.inline = line === undefined ? { path } : { path, to: line };

    const res = await bb(
      `/repositories/${workspace}/${repo_slug}/pullrequests/${pull_request_id}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const comment = (await res.json()) as any;
    return {
      content: [
        { type: 'text', text: `Posted comment ${comment.id}: ${comment.links?.html?.href ?? ''}` },
      ],
    };
  }
);

server.registerTool(
  'get_pull_request',
  {
    title: 'Get pull request details',
    description:
      'Title, description, author, state, and branches for one pull request. ' +
      'The description is what the change claims to do, which is what a review measures it against.',
    inputSchema: z.object({ ...repo, pull_request_id: z.number().int() }),
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const { workspace, repo_slug } = target(args);
    const pr = (await (
      await bb(`/repositories/${workspace}/${repo_slug}/pullrequests/${args.pull_request_id}`)
    ).json()) as any;

    const text = [
      `#${pr.id} ${pr.title}`,
      `${pr.author?.display_name} · ${pr.state} · ${pr.source?.branch?.name} → ${pr.destination?.branch?.name}`,
      `commit ${pr.source?.commit?.hash?.slice(0, 12) ?? '?'} · ${pr.links?.html?.href}`,
      '',
      pr.description?.trim() || '(no description)',
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  }
);

server.registerTool(
  'get_diffstat',
  {
    title: 'List files changed',
    description:
      'Which files a pull request touches and how many lines each gained or lost, without the ' +
      'diff itself. Use this first on a large pull request to decide what is worth reading.',
    inputSchema: z.object({ ...repo, pull_request_id: z.number().int() }),
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const { workspace, repo_slug } = target(args);
    const values: any[] = [];
    let url = `/repositories/${workspace}/${repo_slug}/pullrequests/${args.pull_request_id}/diffstat?pagelen=100`;
    while (url) {
      const page = (await (await bb(url)).json()) as { values?: any[]; next?: string };
      values.push(...(page.values ?? []));
      url = page.next ? page.next.replace(API, '') : '';
    }

    const rows = values.map((f) => {
      const path = f.new?.path ?? f.old?.path ?? '?';
      return `${f.status.padEnd(9)} +${f.lines_added ?? 0} -${f.lines_removed ?? 0}  ${path}`;
    });
    const total = values.reduce(
      (a, f) => ({ add: a.add + (f.lines_added ?? 0), del: a.del + (f.lines_removed ?? 0) }),
      { add: 0, del: 0 }
    );

    return {
      content: [
        {
          type: 'text',
          text: rows.length
            ? `${values.length} files, +${total.add} -${total.del}\n\n${rows.join('\n')}`
            : 'No file changes.',
        },
      ],
    };
  }
);

server.registerTool(
  'get_file',
  {
    title: 'Read a file as the pull request leaves it',
    description:
      "Read a whole file at the pull request's source commit. A diff shows changed lines but not " +
      'the code around them, so use this when a hunk cannot be judged on its own.',
    inputSchema: z.object({
      ...repo,
      pull_request_id: z.number().int().describe('Pull request number, used to resolve the commit'),
      path: z.string().describe('Path within the repository, as it appears in the diff'),
      max_chars: z.number().int().default(50_000).describe('Truncate past this many characters'),
    }),
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const { workspace, repo_slug } = target(args);
    const pr = (await (
      await bb(`/repositories/${workspace}/${repo_slug}/pullrequests/${args.pull_request_id}`)
    ).json()) as any;
    const commit = pr.source?.commit?.hash;
    if (!commit) throw new Error(`Pull request ${args.pull_request_id} has no source commit.`);

    const raw = await (
      await bb(
        `/repositories/${workspace}/${repo_slug}/src/${commit}/${args.path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`
      )
    ).text();

    const text =
      raw.length > args.max_chars
        ? raw.slice(0, args.max_chars) +
          `\n\n[truncated: ${raw.length} chars total, showing first ${args.max_chars}]`
        : raw;

    return {
      content: [{ type: 'text', text: `${args.path} @ ${commit.slice(0, 12)}\n\n${text}` }],
    };
  }
);

server.registerTool(
  'get_comments',
  {
    title: 'Read pull request comments',
    description:
      'Read existing comments on a pull request, so a review does not repeat points ' +
      'someone already raised. Inline comments carry the file and line they sit on.',
    inputSchema: z.object({
      ...repo,
      pull_request_id: z.number().int().describe('Pull request number'),
      limit: z.number().int().max(200).default(100).describe('Maximum comments to return'),
    }),
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const { workspace, repo_slug } = target(args);
    const { pull_request_id, limit } = args;

    const values: any[] = [];
    let url = `/repositories/${workspace}/${repo_slug}/pullrequests/${pull_request_id}/comments?pagelen=50`;
    while (url && values.length < limit) {
      const page = (await (await bb(url)).json()) as { values?: any[]; next?: string };
      values.push(...(page.values ?? []));
      url = page.next ? page.next.replace(API, '') : '';
    }

    // Deleted comments come back as tombstones with no content. Drop them.
    const comments = values.filter((c) => !c.deleted).slice(0, limit);

    const text = comments.length
      ? comments
          .map((c) => {
            const where = c.inline?.path
              ? `${c.inline.path}:${c.inline.to ?? c.inline.from ?? '?'}`
              : 'general';
            const resolved = c.resolution ? ' [resolved]' : '';
            return `${c.user?.display_name} · ${where}${resolved} · ${c.created_on}\n${c.content?.raw ?? ''}`;
          })
          .join('\n\n---\n\n')
      : 'No comments on this pull request.';

    return { content: [{ type: 'text', text }] };
  }
);

// Jira is optional. Registering a tool that cannot possibly authenticate is worse
// than not having one: the model sees it, calls it, and gets a 401 mid-task.
const JIRA_URL = process.env.JIRA_BASE_URL?.replace(/\/+$/, '');
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;

if (JIRA_URL && JIRA_TOKEN) {
  server.registerTool(
    'get_jira_issue',
    {
      title: 'Read a Jira issue',
      description:
        'Read the issue a pull request claims to resolve, so the change can be judged against ' +
        'what was actually asked for rather than against its own description. Issue keys usually ' +
        'appear in the pull request title or branch name, e.g. PROJ-142.',
      inputSchema: z.object({
        issue_key: z.string().describe('Issue key, e.g. "PROJ-142"'),
        max_comments: z
          .number()
          .int()
          .default(20)
          .describe('Most recent comments to include. 0 omits them.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ issue_key, max_comments }) => {
      // v2 returns the description and comment bodies as plain text. v3 returns
      // Atlassian Document Format, a JSON tree that would need flattening for no gain.
      const fields =
        'summary,description,status,resolution,issuetype,priority,labels,parent,subtasks,issuelinks,comment';
      const url = `${JIRA_URL}/rest/api/2/issue/${encodeURIComponent(issue_key)}?fields=${fields}`;
      const res = await fetch(url, {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${EMAIL}:${JIRA_TOKEN}`).toString('base64'),
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        const raw = (await res.text()).trim().slice(0, 400);
        throw new Error(
          `Jira ${res.status} ${res.statusText} on ${issue_key}: ${raw || '(empty body)'}` +
            (res.status === 401 || res.status === 403
              ? '\n  - JIRA_API_TOKEN is a separate token from the Bitbucket one. A Bitbucket-scoped' +
                '\n    token cannot read Jira. It needs a Jira scope such as read:jira-work.'
              : res.status === 404
                ? '\n  - Either the key does not exist, or your account cannot see that project.'
                : '')
        );
      }

      const i = (await res.json()) as any;
      const f = i.fields ?? {};
      const out: string[] = [
        `${i.key}: ${f.summary ?? '(no summary)'}`,
        `${f.issuetype?.name ?? '?'} · ${f.status?.name ?? '?'}` +
          (f.resolution?.name ? ` · resolved: ${f.resolution.name}` : '') +
          (f.priority?.name ? ` · ${f.priority.name}` : '') +
          (f.labels?.length ? ` · ${f.labels.join(', ')}` : ''),
        `${JIRA_URL}/browse/${i.key}`,
        '',
        (typeof f.description === 'string' ? f.description.trim() : '') || '(no description)',
      ];

      const brief = (x: any) =>
        `${x?.key} ${x?.fields?.summary ?? ''} [${x?.fields?.status?.name ?? '?'}]`.trim();

      if (f.parent) out.push('', `Parent: ${brief(f.parent)}`);

      // A ticket that says "same as X" or "regression from Y" only makes sense with
      // the other ticket in hand, so surface the links rather than making the model ask.
      const links = (f.issuelinks ?? []).map((l: any) =>
        l.outwardIssue
          ? `  ${l.type?.outward ?? 'relates to'} ${brief(l.outwardIssue)}`
          : `  ${l.type?.inward ?? 'relates to'} ${brief(l.inwardIssue)}`
      );
      if (links.length) out.push('', 'Linked issues:', ...links);

      const subs = (f.subtasks ?? []).map((s: any) => `  ${brief(s)}`);
      if (subs.length) out.push('', 'Subtasks:', ...subs);

      const all = f.comment?.comments ?? [];
      if (max_comments > 0 && all.length) {
        const shown = all.slice(-max_comments);
        out.push(
          '',
          `Comments (${shown.length} of ${all.length}, oldest first):`,
          ...shown.map((c: any) => {
            const body = (typeof c.body === 'string' ? c.body : '').trim();
            const capped = body.length > 1500 ? body.slice(0, 1500) + ' …[truncated]' : body;
            return `\n--- ${c.author?.displayName ?? '?'} · ${c.created ?? ''}\n${capped}`;
          })
        );
      }

      return { content: [{ type: 'text', text: out.join('\n') }] };
    }
  );
}

// The checklist below is a starting point, not a house style. A review standard
// worth having is specific to a codebase, and the specifics are usually the part
// nobody can publish. Point REVIEW_CHECKLIST_PATH at a file kept outside this
// repository and it replaces this text wholesale.
const DEFAULT_CHECKLIST = [
  '1. Correctness — does the change do what the title and description claim?',
  '2. Edge cases — nulls, empty collections, concurrent access, failure paths.',
  '3. Error handling — are failures surfaced, or swallowed?',
  '4. Security — input validated at trust boundaries, no secrets in the diff,',
  '   no new injection or authorization gaps.',
  '5. Tests — is the new behaviour covered, and would the test fail without the change?',
  '6. Scope — anything in the diff that the PR did not need to touch.',
].join('\n');

function checklist(): string {
  const path = process.env.REVIEW_CHECKLIST_PATH;
  if (!path) return DEFAULT_CHECKLIST;
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (text) return text;
    console.error(`REVIEW_CHECKLIST_PATH is empty: ${path}. Using the default checklist.`);
  } catch (e) {
    console.error(
      `Could not read REVIEW_CHECKLIST_PATH (${path}): ${(e as Error).message}. ` +
        'Using the default checklist.'
    );
  }
  return DEFAULT_CHECKLIST;
}

server.registerPrompt(
  'review_pull_request',
  {
    title: 'Review a pull request',
    description: 'Fetch a pull request diff and review it against the checklist.',
    argsSchema: z.object({
      pull_request_id: z.string().describe('Pull request number'),
      workspace: z.string().optional(),
      repo_slug: z.string().optional(),
    }),
  },
  ({ workspace, repo_slug, pull_request_id }) => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Review pull request #${pull_request_id}` +
              (workspace && repo_slug ? ` in ${workspace}/${repo_slug}.` : '.'),
            '',
            'Gather before judging:',
            '',
            '1. get_pull_request — what the change claims to do.',
            ...(JIRA_URL && JIRA_TOKEN
              ? [
                  '2. get_jira_issue — if the title or branch carries an issue key, read it.',
                  '   The ticket is what was asked for; the description is only what the author',
                  '   believes they did. Where the two disagree, the ticket wins.',
                ]
              : []),
            `${JIRA_URL && JIRA_TOKEN ? '3' : '2'}. get_comments — what colleagues already raised. Do not restate it.`,
            `${JIRA_URL && JIRA_TOKEN ? '4' : '3'}. get_diffstat, then get_diff. On a large change, read the diffstat first`,
            '   and pull the diff for what matters.',
            '',
            'Use get_file when a hunk cannot be judged from the diff alone. Changed lines',
            'often look fine until you see the function they sit in.',
            '',
            'Then work through this checklist:',
            '',
            ...(JIRA_URL && JIRA_TOKEN
              ? ['0. Does this actually resolve the ticket, all of it and nothing beyond it?']
              : []),
            checklist(),
            '',
            'Report findings most serious first. For each one give the file and line, what',
            'breaks, and the smallest fix. Skip style nits. If a finding is worth leaving on',
            'the PR, use post_comment with path and line.',
            '',
            'If the change is sound, say so plainly and stop. A review that manufactures',
            'findings to look thorough is worse than no review.',
          ].join('\n'),
        },
      },
    ],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('bitbucket-mcp listening on stdio');
