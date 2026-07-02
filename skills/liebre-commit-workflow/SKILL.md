---
name: liebre-commit-workflow
description: Use when committing, pushing, or creating PRs in any Liebre repository — guides conventional commits, AgileFlow version bump behavior, multi-repo structure, and branch targeting for liebre-api, liebre-app, ms-cfdis, ms-permissions, ms-i18n, liebre-data-extraction-contpaqi
---

# Liebre Commit Workflow

## Overview

Liebre is a multi-repo monorepo. Each subdirectory under `~/code/lkmx/liebre/` is an **independent git repository**. Commits use Conventional Commits format — AgileFlow v0.21.0 reads them on push to `main` and automatically creates semantic version tags.

**Never run git at the top-level `liebre/` directory.** Always `cd` into the target service directory first.

---

## Repository Map

| Service | Directory | Scope |
|---------|-----------|-------|
| Main accounting API | `ant-liebre-api/` | `api` |
| Frontend | `ant-liebre-app/` | `app` |
| CFDI management | `ant-ms-cfdis/` | `cfdis` |
| Permissions/RBAC | `ant-ms-permissions/` | `permissions` |
| i18n/translations | `ant-ms-i18n/` | `i18n` |
| Data extraction | `ant-liebre-data-extraction-contpaqi/` | `data-extraction` |

---

## Conventional Commits Format

```
<type>(<scope>): <description>

[optional body]

[optional footer: BREAKING CHANGE: <description>]
```

**Examples:**
```bash
feat(i18n): add DUPLICATE_ENTRY to error catalog
fix(app): resolve login page crash on Safari
refactor(api): extract journal entry validator
chore(permissions): update dependencies
```

---

## AgileFlow Version Bumps

| Commit type | Version impact | Example |
|-------------|---------------|---------|
| `feat!:` or `BREAKING CHANGE:` footer | **major** bump | `v1.0.0 → v2.0.0` |
| `feat:` | **minor** bump | `v1.0.0 → v1.1.0` |
| `fix:` | **patch** bump | `v1.0.0 → v1.0.1` |
| `ci:`, `docs:`, `chore:`, `refactor:` | **no bump** | tag not created |

AgileFlow runs automatically on push to `main`. Highest-priority bump across all commits since last tag wins.

**Current baseline:** All repos tagged `v1.0.0`. Versions increment from there.

---

## Branch Strategy

```
feature branch → PR → main → AgileFlow tags → GitLab mirror
```

1. Work on a feature/fix branch (e.g. `feat/us027-i18n-gap-fixes`, `fix/safari-login`)
2. Push branch, open PR targeting **`main`** (never `release/0.1` — deleted)
3. On merge to main, AgileFlow creates version tag automatically
4. Tag is mirrored to GitLab at `code.logickernel.com/solutions/liebre/`

---

## Commit Checklist

- [ ] `cd` into the specific service directory, not the top-level `liebre/`
- [ ] Stage specific files by name (not `git add -A` or `git add .`)
- [ ] Commit message follows `<type>(<scope>): <description>` format
- [ ] Type chosen matches intent (see version bump table above)
- [ ] PR targets `main`
- [ ] Let commitizen hooks run — do NOT use `--no-verify`

---

## Multiple Repos in One Session

When changes span multiple repos, treat each as a separate commit operation:

```bash
# Repo 1
cd ant-ms-i18n
git add src/database/migrations/versions/seed_errors.py
git commit -m "feat(i18n): add DUPLICATE_ENTRY error code"
git push origin feat/my-branch

# Repo 2
cd ../ant-liebre-app
git add src/components/auth/LoginPage.tsx
git commit -m "fix(app): resolve Safari login crash"
git push origin fix/safari-login
```

Open separate PRs for each repo — independent histories, independent versioning.

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Running `git` from `liebre/` root | `cd` into service dir first |
| Using `git add .` | Stage specific files by name |
| PR targets `release/0.1` | Always target `main` |
| Generic message like "update stuff" | Use `fix(scope):` or `feat(scope):` |
| Using `--no-verify` to skip hooks | Fix the hook issue instead |
| One PR for changes across multiple repos | Separate PR per repo |
