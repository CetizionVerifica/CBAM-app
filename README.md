# CBAM app starter kit

Copy the contents of this folder into the root of your CBAM app repository (new or existing).

## What goes where

```
cbam-app/                                   ← your repo root
├── CLAUDE.md                               ← Claude Code reads this every session
├── docs/
│   ├── cbam-spec.md                        ← functional spec (build plan)
│   ├── cbam-ui-design-system.md            ← UI design system
│   └── reviews/README.md                   ← review reports land here
├── templates/README.md                     ← put the official EU Excel template here
└── .claude/
    └── skills/
        └── cbam-module-reviewer/           ← module review skill
            ├── SKILL.md
            └── references/
                ├── spec-overview.md
                ├── calculation-reference.md
                ├── review-report-template.md
                ├── cbam-ui-design-system.md
                └── modules/M01 … M13.md
```

## Setup (macOS)

```bash
# 1. Go to your project folder (create it if new)
mkdir -p ~/Projects/cbam-app && cd ~/Projects/cbam-app
git init            # skip if the repo already exists

# 2. Unzip the kit into the repo root
unzip ~/Downloads/cbam-app-starter.zip -d /tmp/
cp -R /tmp/cbam-app-starter/. .      # the dot copies hidden .claude folder too

# 3. Add the official EU template
cp ~/Downloads/<official-template>.xlsx templates/

# 4. Check
ls -a                          # should show .claude, CLAUDE.md, docs, templates
ls .claude/skills/cbam-module-reviewer

# 5. Commit
git add . && git commit -m "Add CBAM spec, design system, review skill"

# 6. Start Claude Code
claude
```

If the repo already has a `CLAUDE.md`, merge the two instead of overwriting.

## First prompts in Claude Code

**New project:**
```
Read CLAUDE.md, docs/cbam-spec.md and docs/cbam-ui-design-system.md.
Propose the scaffold for the repository layout in CLAUDE.md (apps/web, apps/api,
packages/engine, packages/shared, db/migrations) and the Phase 1 database schema
for M1–M4 and M13. Don't write code until I approve the plan.
```

**Existing app:**
```
Read CLAUDE.md and map the current codebase to modules M1–M13 using the
cbam-module-reviewer skill. List files, routes and tables per module and mark what's
missing. Save to docs/reviews/00-module-map.md. Don't review yet.
```

Then work module by module, and after each: `/cbam-module-reviewer review M<n>`.
