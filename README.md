# bitbucket-mcp

An MCP server for reviewing Bitbucket Cloud pull requests. Claude Code, Cursor,
or any other MCP client can read a pull request, the ticket behind it, and the
comments already on it, then leave review comments, without you leaving the
editor.

It is deliberately small, and it cannot change your repository. There is no tool
to merge, approve, decline, push, delete a branch, or run a pipeline, so the
token it asks for is two read scopes. An agent using it can read code and write
comments. That is all it can do.

Authentication uses Atlassian API tokens, which replaced app passwords on
28 July 2026.

## Install

```bash
npm install
npm run build
```

## Credentials

Go to https://id.atlassian.com/manage-profile/security/api-tokens and use
**Create API token with scopes**, then pick Bitbucket. The plain Create API
token button produces a token with no scopes, and the Bitbucket REST API
answers those with a 401 and an empty body.

Two scopes, both read-only:

| Scope | Covers |
| --- | --- |
| `read:repository:bitbucket` | Reading the repository and its diffs |
| `read:pullrequest:bitbucket` | Listing pull requests, and commenting on them |

Commenting sits under the read scope, so the server never needs write access.
It cannot push, merge, approve, or delete anything. Add
`read:pipeline:bitbucket` if you want to be ready for pipeline support later.

Then set:

```bash
export ATLASSIAN_EMAIL="you@company.com"     # your Atlassian account email
export BITBUCKET_API_TOKEN="..."
```

The email is the one listed under Email aliases in Bitbucket personal settings,
not your Bitbucket username.

## Connect it

Claude Code:

```bash
claude mcp add bitbucket -- node /absolute/path/to/bitbucket-mcp/dist/index.js
```

Or add it to your client's config file directly:

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "node",
      "args": ["/absolute/path/to/bitbucket-mcp/dist/index.js"],
      "env": {
        "ATLASSIAN_EMAIL": "you@company.com",
        "BITBUCKET_API_TOKEN": "..."
      }
    }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_pull_requests` | Lists PRs, filtered by state, author, and branch |
| `get_pull_request` | Title, description, author, state, branches |
| `get_diffstat` | Which files changed and by how much, without the diff |
| `get_diff` | The unified diff, truncated past `max_chars` |
| `get_file` | A whole file at the PR's commit, for the context a diff omits |
| `get_comments` | Existing comments, with the file and line for inline ones |
| `post_comment` | Posts a comment, optionally pinned to a file and line |
| `get_jira_issue` | The ticket, its links and its comments. Only if Jira is configured |

They take `workspace` and `repo_slug`. If you work in one repository, set
`BITBUCKET_WORKSPACE` and `BITBUCKET_REPO_SLUG` alongside the credentials and
drop them from the calls.

`get_comments` is what keeps a review from restating what a colleague already
wrote three days ago, which is the fastest way to make an automated reviewer
annoying.

Filtering matters more than it sounds. A page from Bitbucket holds 50 pull
requests, and a long-lived repository has thousands, so an unfiltered list is
mostly noise from other teams. `list_pull_requests` filters server-side and
follows pages until it has `limit` results:

| Argument | Match | Example |
| --- | --- | --- |
| `state` | exact, defaults to `OPEN` | `MERGED` |
| `author` | exact account nickname | `Ada Lovelace` |
| `destination_branch` | exact | `main`, `release/2.4` |
| `source_branch` | substring | `PROJ` matches `fix/PROJ-142` |
| `limit` | up to 200, defaults to 50 | `120` |

## Jira, optional

A diff tells you what changed. It cannot tell you whether that was what somebody
asked for. Set these two and `get_jira_issue` appears, carrying the ticket, its
linked issues and its comments:

```bash
export JIRA_BASE_URL="https://yourcompany.atlassian.net"
export JIRA_API_TOKEN="..."     # separate token, scope read:jira-work
```

It needs its own token. A Bitbucket-scoped token cannot read Jira; it answers
401. `ATLASSIAN_EMAIL` is shared between the two.

Leave them unset and the tool is never registered. A tool that is present but
cannot authenticate is worse than an absent one, because the model finds it,
calls it, and fails halfway through a task.

The comments matter as much as the description. A ticket that was reopened, or
that carries a "this broke again in production" thread, means something
different from its original text.

## Prompt

`review_pull_request` reads the ticket and the existing comments, pulls the diff,
and works through a checklist: correctness, edge cases, error handling, security,
test coverage, and scope creep. Findings come back worst first, each with a file,
a line, and the smallest fix.

The checklist that ships here is a starting point. The one worth having is
specific to your codebase, and those specifics are usually the part you cannot
publish. Keep it in a file outside this repository:

```bash
export REVIEW_CHECKLIST_PATH="$HOME/.config/review-checklist.md"
```

Its contents replace the default. If the file is missing or empty the server logs
that to stderr and falls back, so a bad path degrades the review instead of
breaking it.

Write down failure modes, not incidents. "Anything writing to an audit trail has
to be idempotent" is a lesson you can share. The outage that taught it to you
usually is not.

## Tests

```bash
npm test
```

No framework and no network. They cover the parts that can break quietly: a
quote inside a filter cannot escape the query it is built into, the Jira tool is
absent unless Jira is configured, the checklist falls back when its file is
missing, and no registered tool can write to a repository.

## What this does not do

MCP exposes capabilities that an agent may choose to call. It cannot gate a
commit or force anyone through the checklist. If you want review standards
enforced rather than offered, that belongs in a git hook or in CI, with this
server alongside it.

## Not included yet

`get_pipeline_status`, and reading a pull request's approval state.

## Licence

MIT
