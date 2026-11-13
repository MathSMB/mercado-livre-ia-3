"""
Backend do Painel de Raspagem Humanizada.

API (FastAPI) + motor de raspagem "educado":
  - verifica o site antes (API de dados abertos, tempo de resposta, sugestão de seletores)
  - pausas aleatórias entre requisições (jitter, ex.: 1 a 2 s)
  - pausas longas a cada N páginas ("pausa para o café")
  - auto-throttle: se o site fica lento, o robô desacelera
  - backoff exponencial em 429/503, respeitando o header Retry-After
  - User-Agent identificável com contato, 1 requisição por vez por domínio
  - janela de horário permitida (ex.: só de madrugada)
  - pausar / retomar / parar, eventos ao vivo via SSE, exportação CSV/JSON

Rodar:  uvicorn app:app --reload --port 8001
"""
import asyncio
import csv
import io
import json
import random
import time
import uuid
from datetime import datetime
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(title="Painel de Raspagem Humanizada")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DEFAULT_UA = "PainelRaspagemBot/0.1 (+mailto:seu-email@exemplo.com; dados abertos)"


# --------------------------------------------------------------------------- modelos
class Campo(BaseModel):
    nome: str
    seletor: str
    atributo: Optional[str] = None  # None = texto; "href", "src"...


class Config(BaseModel):
    url: str
    seletor_item: str = "article"
    campos: list[Campo] = []
    seletor_proxima: Optional[str] = None
    max_paginas: int = 5
    pausa_min: float = 1.0
    pausa_max: float = 2.0
    pausa_longa_cada: int = 10          # a cada N páginas...
    pausa_longa_seg: float = 15.0       # ...descansa X segundos
    auto_throttle: bool = True
    max_tentativas: int = 4
    user_agent: str = DEFAULT_UA
    hora_inicio: Optional[int] = None   # ex.: 0  -> só roda entre 0h e 6h
    hora_fim: Optional[int] = None


class VerificarReq(BaseModel):
    url: str
    user_agent: str = DEFAULT_UA


class Job(BaseModel):
    id: str
    config: Config
    status: str = "na_fila"   # na_fila | rodando | pausado | aguardando_horario | concluido | parado | erro
    criado_em: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    paginas: int = 0
    requisicoes: int = 0
    itens: list[dict] = []
    eventos: list[dict] = []
    pausas: list[float] = []
    latencias: list[float] = []
    status_http: dict[str, int] = {}


JOBS: dict[str, Job] = {}
CONTROLE: dict[str, dict] = {}   # id -> {"pausado": Event, "parar": bool}
OUVINTES: dict[str, list[asyncio.Queue]] = {}


# --------------------------------------------------------------------------- util
def emitir(job: Job, tipo: str, msg: str, **dados):
    ev = {"t": datetime.now().strftime("%H:%M:%S"), "tipo": tipo, "msg": msg, **dados}
    job.eventos.append(ev)
    for q in OUVINTES.get(job.id, []):
        q.put_nowait(ev)


def cliente(ua: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"User-Agent": ua, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
                 "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"},
        follow_redirects=True, timeout=20)


# --------------------------------------------------------------------------- verificação
@app.post("/api/verificar")
async def verificar(req: VerificarReq):
    """Checagem prévia: o site responde? existe um caminho oficial (API)?"""
    checks = []
    p = urlparse(req.url)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise HTTPException(400, "URL inválida")
    base = f"{p.scheme}://{p.netloc}"
    async with cliente(req.user_agent) as c:
        t0 = time.perf_counter()
        try:
            r = await c.get(req.url)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Não consegui acessar o site: {e}")
        lat = round((time.perf_counter() - t0) * 1000)
        checks.append({"item": "Site responde", "ok": r.status_code < 400,
                       "detalhe": f"HTTP {r.status_code} em {lat} ms · {r.headers.get('content-type', '?')}"})

        api = None
        await asyncio.sleep(random.uniform(1, 2))
        try:  # portais de dados abertos (CKAN, ex.: dados.gov.br) já têm API: melhor que raspar
            ra = await c.get(urljoin(base, "/api/3/action/status_show"), timeout=5)
            if ra.status_code == 200 and "ckan_version" in ra.text:
                api = "CKAN (/api/3/action)"
        except httpx.HTTPError:
            pass
        checks.append({"item": "API oficial de dados abertos", "ok": api is not None,
                       "detalhe": f"encontrada: {api}. Prefira a API!" if api else "não detectada"})

        soup = BeautifulSoup(r.text, "html.parser")
        sugestoes = sugerir_seletores(soup)
        checks.append({"item": "Precisa de JavaScript?", "ok": len(soup.get_text(strip=True)) > 200,
                       "detalhe": "HTML já traz o conteúdo" if len(soup.get_text(strip=True)) > 200
                       else "pouco texto no HTML: talvez precise de navegador (Playwright)"})
    return {"url": req.url, "latencia_ms": lat, "checks": checks,
            "titulo": (soup.title.string if soup.title else None), "sugestoes": sugestoes}


def sugerir_seletores(soup: BeautifulSoup) -> list[dict]:
    """Heurística simples: elementos com a mesma classe repetidos muitas vezes costumam ser os 'cards'."""
    cont: dict[str, int] = {}
    for el in soup.find_all(True):
        cls = el.get("class")
        if cls and el.name in ("article", "div", "li", "tr", "section"):
            k = f"{el.name}.{cls[0]}"
            cont[k] = cont.get(k, 0) + 1
    return [{"seletor": k, "ocorrencias": v} for k, v in sorted(cont.items(), key=lambda x: -x[1]) if v >= 3][:5]


# --------------------------------------------------------------------------- motor
def extrair(soup: BeautifulSoup, cfg: Config, url: str) -> list[dict]:
    itens = []
    for el in soup.select(cfg.seletor_item):
        linha = {}
        for campo in cfg.campos:
            alvo = el.select_one(campo.seletor) if campo.seletor else el
            if alvo is None:
                linha[campo.nome] = None
            elif campo.atributo:
                v = alvo.get(campo.atributo)
                linha[campo.nome] = urljoin(url, v) if campo.atributo in ("href", "src") and v else v
            else:
                linha[campo.nome] = alvo.get_text(" ", strip=True)
        if not cfg.campos:
            linha["texto"] = el.get_text(" ", strip=True)[:300]
        itens.append(linha)
    return itens


async def esperar(job: Job, segundos: float, motivo: str):
    emitir(job, "pausa", f"pausa de {segundos:.2f} s ({motivo})", segundos=round(segundos, 2))
    job.pausas.append(round(segundos, 2))
    fim = time.monotonic() + segundos
    while time.monotonic() < fim:
        if CONTROLE[job.id]["parar"]:
            return
        await asyncio.sleep(min(0.2, fim - time.monotonic()))


async def checar_controle(job: Job):
    ctl = CONTROLE[job.id]
    if not ctl["continuar"].is_set():
        job.status = "pausado"
        emitir(job, "info", "pausado pelo usuário")
        await ctl["continuar"].wait()
        job.status = "rodando"
        emitir(job, "info", "retomado")
    cfg = job.config
    if cfg.hora_inicio is not None and cfg.hora_fim is not None:
        while not ctl["parar"]:
            h = datetime.now().hour
            dentro = cfg.hora_inicio <= h < cfg.hora_fim if cfg.hora_inicio < cfg.hora_fim \
                else (h >= cfg.hora_inicio or h < cfg.hora_fim)
            if dentro:
                break
            job.status = "aguardando_horario"
            emitir(job, "info", f"fora da janela {cfg.hora_inicio}h–{cfg.hora_fim}h; aguardando")
            await asyncio.sleep(60)
        job.status = "rodando"


async def buscar(job: Job, c: httpx.AsyncClient, url: str) -> Optional[httpx.Response]:
    """GET com backoff exponencial + Retry-After em 429/5xx."""
    cfg = job.config
    for tentativa in range(1, cfg.max_tentativas + 1):
        t0 = time.perf_counter()
        try:
            r = await c.get(url)
        except httpx.HTTPError as e:
            r = None
            emitir(job, "erro", f"falha de rede: {e}")
        lat = (time.perf_counter() - t0) * 1000
        job.requisicoes += 1
        if r is not None:
            job.latencias.append(round(lat))
            job.status_http[str(r.status_code)] = job.status_http.get(str(r.status_code), 0) + 1
            emitir(job, "req", f"GET {url} → {r.status_code} ({lat:.0f} ms)", status=r.status_code, ms=round(lat))
            if r.status_code < 400:
                return r
            if r.status_code not in (429, 500, 502, 503, 504):
                return None
        if tentativa == cfg.max_tentativas:
            break
        retry_after = r.headers.get("Retry-After") if r is not None else None
        espera = float(retry_after) if retry_after and retry_after.isdigit() else 2 ** tentativa
        espera += random.uniform(0, 1)  # jitter para não "bater" em sincronia
        await esperar(job, espera, f"backoff tentativa {tentativa}/{cfg.max_tentativas}")
    emitir(job, "erro", f"desisti de {url} após {cfg.max_tentativas} tentativas")
    return None


async def executar(job: Job):
    cfg = job.config
    job.status = "rodando"
    emitir(job, "info", f"iniciando raspagem de {cfg.url}")
    try:
        async with cliente(cfg.user_agent) as c:
            fator = 1.0  # auto-throttle
            url: Optional[str] = cfg.url
            vistos = set()
            while url and job.paginas < cfg.max_paginas and url not in vistos:
                await checar_controle(job)
                if CONTROLE[job.id]["parar"]:
                    break
                vistos.add(url)
                r = await buscar(job, c, url)
                if r is None:
                    break
                soup = BeautifulSoup(r.text, "html.parser")
                novos = extrair(soup, cfg, str(r.url))
                job.itens.extend(novos)
                job.paginas += 1
                emitir(job, "dados", f"página {job.paginas}: {len(novos)} itens (total {len(job.itens)})",
                       itens=len(novos), total=len(job.itens))
                prox = soup.select_one(cfg.seletor_proxima) if cfg.seletor_proxima else None
                url = urljoin(str(r.url), prox["href"]) if prox and prox.get("href") else None
                if not url or job.paginas >= cfg.max_paginas:
                    break
                # ---- ritmo humano
                if cfg.auto_throttle and job.latencias:
                    media = sum(job.latencias[-5:]) / len(job.latencias[-5:])
                    fator = min(4.0, max(1.0, media / 800))  # site lento (>800 ms) => desacelera
                pausa = random.uniform(cfg.pausa_min, cfg.pausa_max) * fator
                motivo = "jitter humano" + (f", throttle ×{fator:.1f}" if fator > 1 else "")
                if cfg.pausa_longa_cada and job.paginas % cfg.pausa_longa_cada == 0:
                    pausa += cfg.pausa_longa_seg * random.uniform(0.8, 1.2)
                    motivo = "pausa longa (café)"
                await esperar(job, pausa, motivo)
        job.status = "parado" if CONTROLE[job.id]["parar"] else "concluido"
        emitir(job, "fim", f"{job.status}: {len(job.itens)} itens em {job.paginas} páginas")
    except Exception as e:  # noqa: BLE001
        job.status = "erro"
        emitir(job, "erro", f"erro inesperado: {e}")


# --------------------------------------------------------------------------- rotas
@app.post("/api/jobs")
async def criar_job(cfg: Config):
    if cfg.pausa_min < 0.5 or cfg.pausa_max < cfg.pausa_min:
        raise HTTPException(400, "Pausa mínima deve ser ≥ 0,5 s e menor que a máxima")
    job = Job(id=uuid.uuid4().hex[:8], config=cfg)
    JOBS[job.id] = job
    ev = asyncio.Event(); ev.set()
    CONTROLE[job.id] = {"continuar": ev, "parar": False}
    asyncio.create_task(executar(job))
    return {"id": job.id}


def resumo(j: Job):
    lat = j.latencias
    return {"id": j.id, "url": j.config.url, "status": j.status, "criado_em": j.criado_em, "paginas": j.paginas,
            "max_paginas": j.config.max_paginas, "itens": len(j.itens), "requisicoes": j.requisicoes,
            "latencia_media": round(sum(lat) / len(lat)) if lat else None,
            "pausa_media": round(sum(j.pausas) / len(j.pausas), 2) if j.pausas else None,
            "status_http": j.status_http}


@app.get("/api/jobs")
def listar():
    return [resumo(j) for j in sorted(JOBS.values(), key=lambda j: j.criado_em, reverse=True)]


@app.get("/api/jobs/{jid}")
def detalhe(jid: str):
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "job não existe")
    return {**resumo(j), "config": j.config, "eventos": j.eventos[-300:], "pausas": j.pausas,
            "latencias": j.latencias, "amostra": j.itens[:200]}


@app.post("/api/jobs/{jid}/{acao}")
def controlar(jid: str, acao: str):
    if jid not in JOBS:
        raise HTTPException(404)
    ctl = CONTROLE[jid]
    if acao == "pausar":
        ctl["continuar"].clear()
    elif acao == "retomar":
        ctl["continuar"].set()
    elif acao == "parar":
        ctl["parar"] = True; ctl["continuar"].set()
    else:
        raise HTTPException(400)
    return {"ok": True}


@app.get("/api/jobs/{jid}/eventos")
async def eventos(jid: str):
    if jid not in JOBS:
        raise HTTPException(404)
    q: asyncio.Queue = asyncio.Queue()
    OUVINTES.setdefault(jid, []).append(q)

    async def gen():
        try:
            while True:
                ev = await q.get()
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        finally:
            OUVINTES[jid].remove(q)
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/jobs/{jid}/exportar")
def exportar(jid: str, formato: str = "csv"):
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404)
    if formato == "json":
        return Response(json.dumps(j.itens, ensure_ascii=False, indent=2), media_type="application/json",
                        headers={"Content-Disposition": f"attachment; filename=raspagem_{jid}.json"})
    buf = io.StringIO()
    if j.itens:
        w = csv.DictWriter(buf, fieldnames=list(j.itens[0].keys())); w.writeheader(); w.writerows(j.itens)
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=raspagem_{jid}.csv"})
