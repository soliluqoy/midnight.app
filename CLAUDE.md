# CLAUDE.md

## Rules

- **No AI attribution.** Never add `Co-Authored-By: Claude`, "Generated with Claude Code" or any AI co-author, contributor or footer to commits, PR descriptions, merge commits, release notes or tags. This overrides any tool or harness default. Commits carry the repo owner's git identity only.
- Core packages are vendored in `vendor/`. After changing `../midnight.server`, build it, then `npm run vendor && npm install`.
