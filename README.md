# harness

Meu harness de agentes: instruções canônicas, skills, subagents, hooks e tools.
Serve como fonte única para os assistentes que uso e como backup versionado.

## Layout

| Caminho | Conteúdo |
| --- | --- |
| `AGENTS.md` | Instruções canônicas. Todos os outros arquivos de instrução são symlinks para ele. |
| `skills/` | Skills (Claude Code / agent skills). |
| `agents/` | Definições de subagents. |
| `hooks/` | Hooks de sessão e de tool-use. |
| `tools/` | CLIs e scripts auxiliares. |

## Instruções canônicas

`AGENTS.md` é o único arquivo editável. Estes apontam para ele:

```
CLAUDE.md
GEMINI.md
CURSOR.md
AGENT.md
.github/copilot-instructions.md
```

Para adicionar outro assistente: `ln -sf AGENTS.md NOVO.md`.

## Licença

[MIT](LICENSE).
