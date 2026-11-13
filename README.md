# Painel de Raspagem Humanizada

Plataforma para raspar **sites de dados abertos** no ritmo de uma pessoa: você informa a URL, o painel verifica o site e só então raspa, com pausas aleatórias e backoff.

## Tecnologias

| Camada | Escolha | Por quê |
|---|---|---|
| Frontend | React + TypeScript + Vite | Rápido de desenvolver, tipado, build leve |
| Backend | Python + FastAPI | Mesmo ecossistema do guia de estudo (BeautifulSoup) |
| HTTP | httpx (async) | Uma requisição por vez, timeouts e redirecionamentos |
| Extração | BeautifulSoup + seletores CSS | Igual aos scripts do guia |
| Tempo real | Server-Sent Events (SSE) | Log ao vivo sem WebSocket |
| Próximos passos | SQLite/Postgres, fila (Celery/RQ ou APScheduler), Playwright para sites com JavaScript, Docker Compose |

## Funcionalidades

1. **Verificação prévia**: status HTTP e latência, API oficial (CKAN, usada em portais como dados.gov.br), se o HTML depende de JavaScript, sugestão automática de seletores.
2. **Ritmo humano**: pausa sorteada (padrão 1 a 2 s), pausa longa a cada N páginas, auto-throttle quando o site fica lento, backoff exponencial com jitter em 429/503 (respeita Retry-After), uma requisição por vez, janela de horário, User-Agent identificável com contato.
3. **Execução ao vivo**: pausar, retomar, parar; gráfico do ritmo; códigos HTTP; log em tempo real.
4. **Resultados**: tabela dos itens e exportação CSV/JSON.
5. **Modelos prontos**: Livraria Exemplo (site local do guia), books.toscrape.com, quotes.toscrape.com.

Deliberadamente **não** inclui mascaramento de fingerprint/stealth: o foco é raspar dados abertos de forma transparente.

## Como rodar

```bash
# terminal 1: site de teste do guia
cd backend && python site_ficticio.py

# terminal 2: API
cd backend && pip install -r requirements.txt && uvicorn app:app --reload --port 8001

# terminal 3: painel
cd frontend && npm install && npm run dev   # http://localhost:5173
```
