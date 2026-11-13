# Painel de Raspagem Humanizada

Plataforma local para raspar **sites de dados abertos** no ritmo de uma pessoa e baixar os arquivos que eles oferecem (PDF, CSV, XLSX, ZIP…), mantendo a hierarquia de pastas do site, com prévia, relatórios e histórico que permite **continuar de onde parou**.

## Como subir (Windows)

Pré-requisitos: Python 3.11+, Node 20+ e, opcional, Docker Desktop.

**Jeito rápido:** dê dois cliques em `iniciar.bat`. Ele sobe o banco (se o Docker estiver aberto), o site de teste, o backend e abre o painel em http://localhost:5173.

**Passo a passo (3 terminais):**

```bash
docker compose up -d                 # banco Postgres (opcional; sem Docker usa SQLite)

cd backend
python site_ficticio.py              # terminal 1: site de teste em http://127.0.0.1:8000

cd backend
pip install -r requirements.txt
uvicorn app:app --reload --port 8001 # terminal 2: API

cd frontend
npm install
npm run dev                          # terminal 3: painel em http://localhost:5173
```

## Fluxo recomendado

1. **Nova raspagem** → informe a URL (ou clique num site de "Sites usados recentemente") → **Verificar site** (robots.txt, Crawl-delay, sitemap, API oficial).
2. Diga o que extrair (seletor do item e campos) e, em **O que salvar**, ative os botões **JSON**, **CSV** e/ou **Arquivos**.
   - *Link do item para abrir*: o link dentro de cada item que leva à página dele (ex.: `h3 a`).
   - *Links de subpastas*: links dentro da página do item que abrem "pastas" com mais arquivos (ex.: `a.modulo`).
   - *Pasta de destino*: vazio = `backend\downloads\<site>_<data-hora>`.
3. **Descobrir arquivos (prévia)**: navega com pausas humanas, **não baixa nada**, consulta o tamanho de cada arquivo e mostra a árvore *Pasta mãe › Subpasta › arquivo*, tudo marcado. Desmarque o que não quiser.
4. **Baixar N arquivos marcados**: barra de progresso em %, "12 de 40 arquivos", pausar / retomar / parar.
5. **Previsto × feito**: comparativo por arquivo e por pasta, tamanho previsto × baixado com o motivo das diferenças, e a seção **Inconsistências** (a menos, a mais, sumiu) com o caminho de cada um.
6. **Histórico** (na página da prévia): verde = feito, cinza = pendente, vermelho = erro, amarelo = ignorado/desmarcado. Botão **Continuar de onde parou** e, em cada pasta, **▶ continuar daqui**.

Se o painel for fechado no meio (ou o PC desligar), a execução aparece como **Interrompido** e o "Continuar de onde parou" baixa só o que falta.

## O que é salvo na pasta de destino

```
<pasta de destino>\
  Introdução\
    Módulo 1\  aula1.pdf, aula2.pdf…
    Módulo 2\  …
  Avançado\…
  dados.csv / dados.json              (com CSV / JSON ativos)
  previa_arquivos.csv                 (a prévia)
  relatorio_arquivos.csv              (o que aconteceu com cada arquivo)
  comparativo_previsto_x_feito.csv
  inconsistencias.csv
```

Os CSVs usam `;` e acentuação compatível com o Excel. Nomes de pastas e arquivos são limpos para o Windows (`: ? * " < > |` viram `_`). Arquivos com o mesmo nome não se sobrescrevem: o segundo vira `arquivo (2).pdf`.

## Banco de dados e histórico

- **Postgres (Docker):** `docker compose up -d`. O backend encontra o banco sozinho em `localhost:5433`.
- **SQLite:** se o Postgres não estiver no ar, o backend usa `backend\painel.db` automaticamente. Para forçar: `set DATABASE_URL=sqlite:///painel.db`.
- A tela **Banco e backup** mostra qual banco está em uso.

O que fica guardado: sites usados (com a configuração), cada execução e o status de **cada arquivo**, gravado no momento em que é processado.

> Use sempre o mesmo banco: se um dia o Docker estiver desligado, o histórico daquele dia vai para o SQLite. Dá para juntar depois com backup e restauração.

## Levar para outro notebook

1. **Pelo painel:** em **Banco e backup**, clique em **Baixar backup** (um `.json` com todo o histórico). No notebook novo, suba o projeto e use **Restaurar backup**. Funciona entre Postgres e SQLite.
2. **Pelo Postgres:** `backup.bat` gera `backups\painel_<data>.sql`. No novo PC: `docker compose up -d` e
   `type backups\painel_<data>.sql | docker exec -i painel-raspagem-db psql -U painel -d painel`.
3. **SQLite:** copie `backend\painel.db`.

Copie também a pasta dos downloads. Se ela ficar no mesmo caminho, tudo continua batendo. Se o caminho mudar, os arquivos antigos aparecem como "sumiu" nas inconsistências, mas o histórico continua lá.

## Tecnologias

| Camada | Escolha |
|---|---|
| Frontend | React + TypeScript + Vite |
| Backend | Python + FastAPI, httpx (async), BeautifulSoup |
| Banco | Postgres 16 (Docker) ou SQLite, via SQLAlchemy |
| Tempo real | Server-Sent Events |

## Boas práticas embutidas

Pausa sorteada (padrão 1 a 2 s, nunca abaixo do Crawl-delay), pausa longa a cada N requisições, uma requisição por vez, auto-throttle quando o site fica lento, backoff exponencial em 429/503 respeitando o `Retry-After`, `robots.txt` respeitado inclusive para cada arquivo, User-Agent identificável e limite de tamanho por arquivo. Não há mascaramento de fingerprint: o foco é raspar dados abertos de forma transparente.

## Site de teste (`backend/site_ficticio.py`)

- `/catalogo`: 30 livros. Cada livro tem uma ficha CSV, um resumo PDF, um rascunho em `/admin` (proibido pelo robots.txt) e, no livro 1, um ZIP de 80 MB (para testar o limite de tamanho).
- `/cursos`: cursos › módulos › aulas em PDF. Algumas aulas não informam o tamanho e um material dá 404, para você ver "desconhecido", "erro" e as inconsistências.
