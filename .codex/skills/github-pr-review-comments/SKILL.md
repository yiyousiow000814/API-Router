---
name: github-pr-review-comments
description: View GitHub PR inline review comments (including bot reviews like devin-ai-integration) and resolve review conversations from the CLI.
---

# GitHub PR Review Comments (CLI)

This repo often uses bot reviewers (e.g. `devin-ai-integration`) that leave **inline review comments**.
Note: `gh pr view --comments` may show only issue comments and miss inline review threads.

## View Inline Review Comments

PowerShell:

```powershell
$owner  = '<owner>'
$repo   = '<repo>'
$number = 10

gh api "repos/$owner/$repo/pulls/$number/comments" --paginate |
  ConvertFrom-Json |
  Select-Object user,path,line,created_at,body |
  Format-List
```

Quick count:

```powershell
gh api "repos/<owner>/<repo>/pulls/10/comments" --paginate |
  ConvertFrom-Json | Measure-Object | Select-Object -ExpandProperty Count
```

## Resolve All Unresolved Review Conversations

GitHub stores “Resolve conversation” as a GraphQL mutation on review threads.

PowerShell:

```powershell
$owner  = '<owner>'
$repo   = '<repo>'
$number = 10

$q = @'
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100){ nodes{ id isResolved } }
    }
  }
}
'@

$resp = gh api graphql -f query=$q -f owner=$owner -f name=$repo -F number=$number | ConvertFrom-Json
$ids  = $resp.data.repository.pullRequest.reviewThreads.nodes |
  Where-Object { -not $_.isResolved } |
  ForEach-Object { $_.id }

$m = @'
mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread{ id isResolved } }
}
'@

foreach ($id in $ids) {
  gh api graphql -f query=$m -f threadId=$id | Out-Null
}
```

## PowerShell Notes

- Prefer here-strings (`@' ... '@`) for multi-line GraphQL and PR bodies.
- Avoid backticks (`` ` ``) inside PowerShell double-quoted strings passed to `gh` (PowerShell treats backtick as an escape).

