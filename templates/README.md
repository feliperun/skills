# templates

Playbook portável de engenharia — o que eu instalo num repositório novo.

Extraído dos meus repos públicos [phai](https://github.com/feliperun/phai) e
[cueme](https://github.com/feliperun/cueme), generalizado. Estrutura inspirada em
[tolaria](https://github.com/refactoringhq/tolaria); gate estrutural por
[Sentrux](https://github.com/sentrux/sentrux).

| Arquivo | Papel |
| --- | --- |
| `AGENTS.md` | Playbook canônico: privacidade, workflow, TDD, E2E, gates, ADRs, checklist de release. |
| `githooks/pre-commit` | Scan de secrets no diff staged + `sentrux check`/`gate`. |
| `githooks/commit-msg` | Valida Conventional Commits. |
| `commands/create-adr.md` | Slash command para criar ADR numerado e atualizar o índice. |

## Placeholders

Substituir ao instalar:

| Token | Valor |
| --- | --- |
| `{{PROJECT}}` | Nome do repositório. |
| `{{CHECK_SUITE}}` | Comandos de typecheck + teste da stack (`cargo fmt/clippy/test`, `xcodebuild`, `pnpm typecheck && pnpm test`, …). |

## Instalar num repo

```bash
cp templates/AGENTS.md          <repo>/AGENTS.md
cp -R templates/githooks        <repo>/githooks
cp templates/commands/create-adr.md <repo>/.claude/commands/create-adr.md

cd <repo>
for f in CLAUDE.md GEMINI.md CURSOR.md AGENT.md; do ln -sf AGENTS.md "$f"; done
git config core.hooksPath githooks
chmod +x githooks/*
```

Depois: preencher os placeholders, criar `docs/adr/README.md` com o índice, e rodar
`sentrux gate --save .` para gerar o baseline.

> Um instalador automatiza isso hoje fora deste repo (skill `init-harness`).
> Migrá-lo para cá é uma decisão pendente — a fonte atual vive num repo de trabalho.
