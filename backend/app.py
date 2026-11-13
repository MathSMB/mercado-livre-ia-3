"""
Backend do Painel de Raspagem Humanizada.

API (FastAPI) + motor de raspagem "educado":
  - verifica o site antes (robots.txt, Crawl-delay, sitemap, API de dados abertos, tempo de resposta)
  - pausas aleatórias entre requisições (jitter, ex.: 1 a 2 s) somadas ao Crawl-delay do site
  - pausas longas a cada N páginas ("pausa para o café")
  - auto-throttle: se o site fica lento, o robô desacelera
  - backoff exponencial em 429/503, respeitando o header Retry-After
  - User-Agent identificável com contato, 1 requisição por vez por domínio
  - janela de horário permitida (ex.: só de madrugada)
  - pausar / retomar / parar, eventos ao vivo via SSE, exportação CSV/JSON
  - opcional: entrar no link de cada item e baixar os arquivos (PDF, CSV, XLSX, ZIP...)
    com o mesmo ritmo, respeitando robots.txt e um limite de tamanho; salva em ./downloads/<job>/

Rodar:  uvicorn app:app --reload --port 8001
"""
import asyncio
import csv
import io
import json
import random
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

import db as banco

app = FastAPI(title="Painel de Raspagem Humanizada")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DEFAULT_UA = "PainelRaspagemBot/0.1 (+mailto:seu-email@exemplo.com; dados abertos)"
PASTA_DOWNLOADS = Path(__file__).parent / "downloads"
EXTENSOES_PADRAO = ["pdf", "csv", "xlsx", "xls", "ods", "zip", "json", "xml", "txt", "doc", "docx", "odt"]


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
    respeitar_robots: bool = True
    auto_throttle: bool = True
    max_tentativas: int = 4
    user_agent: str = DEFAULT_UA
    hora_inicio: Optional[int] = None   # ex.: 0  -> só roda entre 0h e 6h
    hora_fim: Optional[int] = None
    # ---- download de arquivos
    baixar_arquivos: bool = False
    seletor_link_item: Optional[str] = None  # link para a página de detalhe dentro do item (ex.: "h3 a").
    #                                          Vazio = procurar arquivos no próprio item da lista.
    extensoes: list[str] = EXTENSOES_PADRAO
    max_tamanho_mb: float = 50
    max_arquivos: int = 200
    seletor_subpasta: Optional[str] = None   # links na página do item que abrem "pastas" com mais arquivos
    max_subpastas: int = 30
    modo: str = "completo"   # "completo" = navega e baixa | "descoberta" = só navega e lista (prévia)
    plano_de: Optional[str] = None           # id da descoberta cujo plano será baixado
    selecionados: Optional[list[str]] = None  # URLs marcadas na prévia (None = todas)
    pasta_destino: Optional[str] = None       # vazio = backend/downloads/<site>_<data-hora>
    salvar_json: bool = False   # ao terminar, grava dados.json na pasta de destino
    salvar_csv: bool = True     # ao terminar, grava dados.csv (e os relatórios) na pasta de destino
    consultar_tamanho: bool = True  # na prévia, pergunta o tamanho de cada arquivo (HEAD), no mesmo ritmo


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
    crawl_delay: Optional[float] = None
    arquivos: list[dict] = []   # relatório: {item, item_titulo, subpasta, nome, url, status, motivo, arquivo, tamanho, caminho}
    pasta: Optional[str] = None
    tipo: str = "raspagem"   # raspagem | descoberta | download_do_plano
    total_previsto: Optional[int] = None   # nº de arquivos marcados (para a barra de progresso)


JOBS: dict[str, Job] = {}
CONTROLE: dict[str, dict] = {}   # id -> {"pausado": Event, "parar": bool}
OUVINTES: dict[str, list[asyncio.Queue]] = {}


# --------------------------------------------------------------------------- util
def emitir(job: Job, tipo: str, msg: str, **dados):
    ev = {"t": datetime.now().strftime("%H:%M:%S"), "tipo": tipo, "msg": msg, **dados}
    job.eventos.append(ev)
    for q in OUVINTES.get(job.id, []):
        q.put_nowait(ev)
    if tipo in ("info", "dados", "fim", "erro"):  # marcos importantes vão para o banco na hora
        try:
            banco.salvar_job(job)
        except Exception as e:  # noqa: BLE001
            print(f"[db] falha ao salvar job {job.id}: {e}")


def cliente(ua: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"User-Agent": ua, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
                 "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"},
        follow_redirects=True, timeout=20)


async def carregar_robots(c: httpx.AsyncClient, url: str) -> tuple[RobotFileParser, Optional[str]]:
    base = f"{urlparse(url).scheme}://{urlparse(url).netloc}"
    rp = RobotFileParser()
    try:
        r = await c.get(urljoin(base, "/robots.txt"))
        texto = r.text if r.status_code == 200 else ""
    except httpx.HTTPError:
        texto = ""
    rp.parse(texto.splitlines())
    return rp, texto or None


# --------------------------------------------------------------------------- verificação
@app.post("/api/verificar")
async def verificar(req: VerificarReq):
    """Checagem prévia: o site deixa? em que ritmo? existe um caminho oficial (API/sitemap)?"""
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

        await asyncio.sleep(random.uniform(1, 2))  # até a verificação respeita o ritmo
        rp, robots_txt = await carregar_robots(c, req.url)
        pode = rp.can_fetch(req.user_agent, req.url)
        checks.append({"item": "robots.txt", "ok": robots_txt is not None,
                       "detalhe": "encontrado" if robots_txt else "não encontrado (seguiremos ritmo conservador)"})
        checks.append({"item": "Permissão para esta URL", "ok": pode,
                       "detalhe": "permitido pelo robots.txt" if pode else "BLOQUEADO pelo robots.txt"})
        cd = rp.crawl_delay(req.user_agent) or rp.crawl_delay("*")
        checks.append({"item": "Crawl-delay", "ok": True,
                       "detalhe": f"{cd} s pedido pelo site" if cd else "não definido (usaremos 1 a 2 s)"})
        sitemaps = rp.site_maps() or []
        checks.append({"item": "Sitemap", "ok": bool(sitemaps),
                       "detalhe": ", ".join(sitemaps[:2]) if sitemaps else "não declarado"})

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
    return {"url": req.url, "latencia_ms": lat, "crawl_delay": cd, "robots_txt": robots_txt,
            "pode_raspar": pode, "checks": checks, "titulo": (soup.title.string if soup.title else None),
            "sugestoes": sugestoes}


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
def extrair(soup: BeautifulSoup, cfg: Config, url: str) -> list[tuple[dict, object]]:
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
        itens.append((linha, el))
    return itens


def links_de_arquivo(raiz, base_url: str, extensoes: list[str]) -> list[tuple[str, str]]:
    """Links <a href> cujo caminho termina com uma das extensões (ou que têm o atributo download)."""
    exts = tuple("." + e.lower().lstrip(".") for e in extensoes)
    achados = []
    for a in raiz.select("a[href]"):
        url = urljoin(base_url, a["href"])
        caminho = urlparse(url).path.lower()
        if (caminho.endswith(exts) or a.has_attr("download")) and url not in [u for u, _ in achados]:
            achados.append((url, a.get_text(" ", strip=True) or Path(caminho).name))
    return achados


RESERVADOS_WINDOWS = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def limpar_nome(nome: str, tamanho: int = 80) -> str:
    """Deixa um nome válido como pasta/arquivo no Windows (e no Linux/Mac)."""
    nome = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", nome).strip().rstrip(". ")
    nome = re.sub(r"\s+", " ", nome)[:tamanho].rstrip(". ") or "sem nome"
    return f"_{nome}" if nome.split(".")[0].upper() in RESERVADOS_WINDOWS else nome


def pasta_padrao(url: str) -> Path:
    host = limpar_nome(urlparse(url).netloc.replace(":", "_"))
    return PASTA_DOWNLOADS / f"{host}_{datetime.now():%Y-%m-%d_%H%M}"


def pasta_do_arquivo(job: Job, ctx: dict) -> Path:
    """<destino>/<título do item>/<subpasta>/ — repete a hierarquia encontrada no site."""
    pasta = Path(job.pasta) / limpar_nome(ctx["titulo"])
    if ctx.get("subpasta"):
        pasta = pasta / limpar_nome(ctx["subpasta"])
    pasta.mkdir(parents=True, exist_ok=True)
    return pasta


def nome_seguro(url: str, pasta: Path) -> Path:
    nome = limpar_nome(unquote(Path(urlparse(url).path).name) or "arquivo", 150)
    destino, n = pasta / nome, 1
    while destino.exists():  # não sobrescreve: arquivo.pdf, arquivo (2).pdf...
        destino = pasta / f"{Path(nome).stem} ({n + 1}){Path(nome).suffix}"
        n += 1
    return destino


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


async def pausa_humana(job: Job, contador: int):
    """Pausa sorteada entre requisições; usada entre páginas, páginas de detalhe e downloads."""
    cfg = job.config
    fator = 1.0
    if cfg.auto_throttle and job.latencias:
        media = sum(job.latencias[-5:]) / len(job.latencias[-5:])
        fator = min(4.0, max(1.0, media / 800))  # site lento (>800 ms) => desacelera
    base = random.uniform(cfg.pausa_min, cfg.pausa_max) * fator
    pausa = max(base, (job.crawl_delay or 0) + random.uniform(0, 0.5))
    motivo = "jitter humano" + (f", throttle ×{fator:.1f}" if fator > 1 else "")
    if cfg.pausa_longa_cada and contador and contador % cfg.pausa_longa_cada == 0:
        pausa += cfg.pausa_longa_seg * random.uniform(0.8, 1.2)
        motivo = "pausa longa (café)"
    await esperar(job, pausa, motivo)


def registrar(job: Job, ctx: dict, url: str, nome_link: str, status: str, motivo: str = "", **extra) -> dict:
    """Uma linha do relatório: item › subpasta › arquivo, com status e motivo."""
    reg = {"item": ctx["item"], "item_titulo": ctx["titulo"], "subpasta": ctx.get("subpasta", ""),
           "nome": nome_link, "url": url, "status": status, "motivo": motivo,
           "arquivo": "", "tamanho": 0, "caminho": "", "tamanho_previsto": None, **extra}
    job.arquivos.append(reg)
    banco.salvar_arquivo(job.id, len(job.arquivos) - 1, reg)  # cada arquivo é gravado na hora: permite retomar
    icone = {"baixado": "arquivo", "encontrado": "arquivo", "ignorado": "aviso", "erro": "erro"}[status]
    emitir(job, icone, f"[{ctx['titulo'][:40]}] {nome_link}: {status}" + (f" ({motivo})" if motivo else ""))
    return reg


async def tamanho_remoto(job: Job, c: httpx.AsyncClient, url: str) -> Optional[int]:
    """HEAD só para ler o Content-Length. Sem tamanho informado => None ("desconhecido")."""
    try:
        r = await c.head(url)
        job.requisicoes += 1
        job.status_http[str(r.status_code)] = job.status_http.get(str(r.status_code), 0) + 1
        emitir(job, "req", f"HEAD {url} → {r.status_code}", status=r.status_code)
        v = r.headers.get("Content-Length")
        return int(v) if r.status_code < 400 and v and v.isdigit() else None
    except httpx.HTTPError:
        return None


async def baixar(job: Job, c: httpx.AsyncClient, url: str, nome_link: str, ctx: dict) -> dict:
    """Baixa um arquivo em streaming, parando se passar do limite de tamanho."""
    cfg = job.config
    limite = int(cfg.max_tamanho_mb * 1024 * 1024)
    pasta = pasta_do_arquivo(job, ctx)
    for tentativa in range(1, cfg.max_tentativas + 1):
        t0 = time.perf_counter()
        try:
            async with c.stream("GET", url) as r:
                job.requisicoes += 1
                job.status_http[str(r.status_code)] = job.status_http.get(str(r.status_code), 0) + 1
                job.latencias.append(round((time.perf_counter() - t0) * 1000))
                if r.status_code in (429, 500, 502, 503, 504) and tentativa < cfg.max_tentativas:
                    ra = r.headers.get("Retry-After")
                    espera = (float(ra) if ra and ra.isdigit() else 2 ** tentativa) + random.uniform(0, 1)
                    emitir(job, "req", f"GET {url} → {r.status_code}", status=r.status_code)
                    await esperar(job, espera, f"backoff tentativa {tentativa}/{cfg.max_tentativas}")
                    continue
                if r.status_code >= 400:
                    return registrar(job, ctx, url, nome_link, "erro", f"HTTP {r.status_code}")
                declarado = int(r.headers.get("Content-Length") or 0)
                if declarado > limite:
                    return registrar(job, ctx, url, nome_link, "ignorado",
                                     f"{declarado / 1048576:.1f} MB, acima do limite de {cfg.max_tamanho_mb:g} MB",
                                     tamanho=declarado)
                destino = nome_seguro(str(r.url), pasta)
                total = 0
                with open(destino, "wb") as f:
                    async for bloco in r.aiter_bytes(64 * 1024):
                        total += len(bloco)
                        if total > limite:
                            break
                        f.write(bloco)
                if total > limite:
                    destino.unlink(missing_ok=True)
                    return registrar(job, ctx, url, nome_link, "ignorado",
                                     f"passou do limite de {cfg.max_tamanho_mb:g} MB durante o download")
                return registrar(job, ctx, url, nome_link, "baixado", f"{total / 1024:.0f} KB",
                                 arquivo=destino.name, caminho=str(destino), tamanho=total)
        except httpx.HTTPError as e:
            return registrar(job, ctx, url, nome_link, "erro", f"falha de rede: {e}")
    return registrar(job, ctx, url, nome_link, "erro", f"desisti após {cfg.max_tentativas} tentativas")


async def abrir_pagina(job: Job, c: httpx.AsyncClient, rp: RobotFileParser, url: str, contador: list[int],
                       ctx: dict) -> Optional[tuple[BeautifulSoup, str]]:
    cfg = job.config
    if cfg.respeitar_robots and not rp.can_fetch(cfg.user_agent, url):
        registrar(job, ctx, url, "(página) " + url, "ignorado", "página proibida pelo robots.txt")
        return None
    contador[0] += 1
    await pausa_humana(job, contador[0])
    r = await buscar(job, c, url)
    if r is None:
        registrar(job, ctx, url, "(página) " + url, "erro", "não consegui abrir a página")
        return None
    return BeautifulSoup(r.text, "html.parser"), str(r.url)


async def baixar_links(job: Job, c: httpx.AsyncClient, rp: RobotFileParser, raiz, base: str,
                       ctx: dict, contador: list[int], vistos: set[str]) -> list[dict]:
    cfg = job.config
    regs = []
    for u, nome_link in links_de_arquivo(raiz, base, cfg.extensoes):
        if u in vistos:
            continue
        vistos.add(u)
        if CONTROLE[job.id]["parar"]:
            break
        if sum(1 for a in job.arquivos if a["status"] in ("baixado", "encontrado")) >= cfg.max_arquivos:
            regs.append(registrar(job, ctx, u, nome_link, "ignorado", f"máximo de {cfg.max_arquivos} arquivos atingido"))
            continue
        if cfg.respeitar_robots and not rp.can_fetch(cfg.user_agent, u):
            regs.append(registrar(job, ctx, u, nome_link, "ignorado", "proibido pelo robots.txt"))
            continue
        if cfg.modo == "descoberta":  # prévia: só lista (e pergunta o tamanho), não baixa
            tamanho = None
            if cfg.consultar_tamanho:
                contador[0] += 1
                await pausa_humana(job, contador[0])
                tamanho = await tamanho_remoto(job, c, u)
            limite = cfg.max_tamanho_mb * 1024 * 1024
            if tamanho is not None and tamanho > limite:
                regs.append(registrar(job, ctx, u, nome_link, "ignorado",
                                      f"{tamanho / 1048576:.1f} MB, acima do limite de {cfg.max_tamanho_mb:g} MB",
                                      tamanho_previsto=tamanho))
            else:
                regs.append(registrar(job, ctx, u, nome_link, "encontrado", "será baixado", tamanho_previsto=tamanho))
            continue
        await checar_controle(job)
        contador[0] += 1
        await pausa_humana(job, contador[0])
        regs.append(await baixar(job, c, u, nome_link, ctx))
    return regs


async def processar_arquivos(job: Job, c: httpx.AsyncClient, rp: RobotFileParser,
                             novos: list[tuple[dict, object]], url_pagina: str, inicio_idx: int, contador: list[int]):
    """Item › (página de detalhe) › (subpastas) › arquivos. Tudo vai para o relatório, baixado ou não."""
    cfg = job.config
    vistos = {a["url"] for a in job.arquivos}
    for i, (linha, el) in enumerate(novos):
        if CONTROLE[job.id]["parar"]:
            return
        await checar_controle(job)
        a_item = el.select_one(cfg.seletor_link_item) if cfg.seletor_link_item else None
        titulo = next((str(v) for v in linha.values() if v), None) \
            or (a_item.get_text(" ", strip=True) if a_item else "") or f"item {inicio_idx + i + 1}"
        ctx = {"item": inicio_idx + i + 1, "titulo": titulo, "subpasta": ""}
        regs: list[dict] = []
        raiz, base = el, url_pagina
        if cfg.seletor_link_item:
            if not a_item or not a_item.get("href"):
                registrar(job, ctx, "", "(sem link)", "ignorado", f"seletor '{cfg.seletor_link_item}' não achou link no item")
                continue
            linha["pagina_detalhe"] = urljoin(url_pagina, a_item["href"])
            aberta = await abrir_pagina(job, c, rp, linha["pagina_detalhe"], contador, ctx)
            if aberta is None:
                continue
            raiz, base = aberta
        regs += await baixar_links(job, c, rp, raiz, base, ctx, contador, vistos)
        # subpastas: links dentro da página do item que abrem outras páginas com mais arquivos
        if cfg.seletor_subpasta:
            subs = []
            for a in raiz.select(cfg.seletor_subpasta):
                if a.get("href"):
                    u = urljoin(base, a["href"])
                    if u not in subs:
                        subs.append((u, a.get_text(" ", strip=True) or u))
            for u, nome_sub in subs[: cfg.max_subpastas]:
                if CONTROLE[job.id]["parar"]:
                    break
                sctx = {**ctx, "subpasta": nome_sub}
                aberta = await abrir_pagina(job, c, rp, u, contador, sctx)
                if aberta is None:
                    continue
                regs += await baixar_links(job, c, rp, aberta[0], aberta[1], sctx, contador, vistos)
        baixados = [r for r in regs if r["status"] in ("baixado", "encontrado")]
        linha["arquivos_encontrados"] = len(regs)
        linha["arquivos_baixados"] = len(baixados)
        linha["arquivos"] = "; ".join(r["arquivo"] or r["nome"] for r in baixados)
        if not regs:
            registrar(job, ctx, "", "(nenhum arquivo)", "ignorado", "nenhum link de arquivo encontrado")


def definir_pasta(job: Job, reaproveitar: Optional[str] = None):
    cfg = job.config
    pasta = Path(cfg.pasta_destino) if cfg.pasta_destino else Path(reaproveitar) if reaproveitar else pasta_padrao(cfg.url)
    pasta.mkdir(parents=True, exist_ok=True)
    job.pasta = str(pasta.resolve())
    emitir(job, "info", f"pasta de destino: {job.pasta}")


def csv_texto(linhas: list[dict], colunas: Optional[list[str]] = None) -> str:
    buf = io.StringIO()
    colunas = colunas or list(dict.fromkeys(k for l in linhas for k in l))
    w = csv.DictWriter(buf, fieldnames=colunas, delimiter=";", extrasaction="ignore")
    w.writeheader(); w.writerows(linhas)
    return "\ufeff" + buf.getvalue()  # BOM: o Excel abre com acentos corretos


COLS_ARQ = ["item", "item_titulo", "subpasta", "nome", "status", "motivo", "tamanho_previsto", "arquivo", "tamanho",
            "caminho", "url"]
COLS_COMP = ["item", "item_titulo", "subpasta", "nome", "previsto", "resultado", "motivo", "tamanho_previsto",
             "tamanho", "diferenca", "motivo_diferenca", "arquivo", "caminho", "url"]


def salvar_saidas(job: Job):
    """Grava na pasta de destino o que estiver ligado: dados.csv, dados.json e os relatórios."""
    if not job.pasta:
        return
    cfg, pasta, gravados = job.config, Path(job.pasta), []

    def gravar(nome: str, conteudo: str):
        (pasta / nome).write_text(conteudo, encoding="utf-8")
        gravados.append(nome)

    if job.tipo != "download_do_plano" and job.itens:
        if cfg.salvar_csv:
            gravar("dados.csv", csv_texto(job.itens))
        if cfg.salvar_json:
            gravar("dados.json", json.dumps(job.itens, ensure_ascii=False, indent=2))
    if job.arquivos:
        nome = "previa_arquivos.csv" if job.tipo == "descoberta" else "relatorio_arquivos.csv"
        gravar(nome, csv_texto(job.arquivos, COLS_ARQ))
        if cfg.salvar_json:
            gravar(nome.replace(".csv", ".json"), json.dumps(job.arquivos, ensure_ascii=False, indent=2))
    if cfg.plano_de:
        gravar("comparativo_previsto_x_feito.csv", csv_texto(comparativo(job), COLS_COMP))
        gravar("inconsistencias.csv", csv_texto(inconsistencias(job), ["tipo", "nome", "onde", "detalhe", "url"]))
    if gravados:
        emitir(job, "info", f"salvo em {job.pasta}: {', '.join(gravados)}")


async def executar_plano(job: Job):
    """Baixa só os arquivos marcados na prévia (descoberta), sem navegar de novo."""
    cfg = job.config
    plano = JOBS[cfg.plano_de]
    marcados = set(cfg.selecionados) if cfg.selecionados is not None else None
    job.itens = [dict(i) for i in plano.itens]
    definir_pasta(job, plano.pasta)
    previstos = [a for a in plano.arquivos if a["status"] == "encontrado"]
    escolhidos = [a for a in previstos if marcados is None or a["url"] in marcados]
    job.total_previsto = len(escolhidos)
    emitir(job, "info", f"baixando {len(escolhidos)} de {len(previstos)} arquivos da prévia em {job.pasta}")
    async with cliente(cfg.user_agent) as c:
        rp, _ = await carregar_robots(c, cfg.url)
        job.crawl_delay = rp.crawl_delay(cfg.user_agent) or rp.crawl_delay("*")
        for n, a in enumerate(escolhidos, 1):
            await checar_controle(job)
            if CONTROLE[job.id]["parar"]:
                break
            ctx = {"item": a["item"], "titulo": a["item_titulo"], "subpasta": a["subpasta"]}
            if cfg.respeitar_robots and not rp.can_fetch(cfg.user_agent, a["url"]):
                registrar(job, ctx, a["url"], a["nome"], "ignorado", "proibido pelo robots.txt")
                continue
            if n > 1:
                await pausa_humana(job, n)
            await baixar(job, c, a["url"], a["nome"], ctx)


async def executar(job: Job):
    cfg = job.config
    job.status = "rodando"
    if cfg.plano_de:
        try:
            await executar_plano(job)
            job.status = "parado" if CONTROLE[job.id]["parar"] else "concluido"
            salvar_saidas(job)
            emitir(job, "fim", f"{job.status}: {sum(1 for a in job.arquivos if a['status'] == 'baixado')} arquivos baixados")
        except Exception as e:  # noqa: BLE001
            job.status = "erro"
            emitir(job, "erro", f"erro inesperado: {e}")
        return
    emitir(job, "info", f"iniciando raspagem de {cfg.url}")
    try:
        async with cliente(cfg.user_agent) as c:
            rp, _ = await carregar_robots(c, cfg.url)
            job.crawl_delay = rp.crawl_delay(cfg.user_agent) or rp.crawl_delay("*")
            if job.crawl_delay:
                emitir(job, "info", f"robots.txt pede Crawl-delay de {job.crawl_delay} s")
            if cfg.baixar_arquivos or cfg.salvar_csv or cfg.salvar_json or cfg.modo == "descoberta":
                definir_pasta(job)
            contador = [0]  # nº de requisições "de navegação" para a pausa longa
            url: Optional[str] = cfg.url
            vistos = set()
            while url and job.paginas < cfg.max_paginas and url not in vistos:
                await checar_controle(job)
                if CONTROLE[job.id]["parar"]:
                    break
                if cfg.respeitar_robots and not rp.can_fetch(cfg.user_agent, url):
                    emitir(job, "aviso", f"robots.txt proíbe {url}; parando")
                    break
                vistos.add(url)
                r = await buscar(job, c, url)
                if r is None:
                    break
                soup = BeautifulSoup(r.text, "html.parser")
                novos = extrair(soup, cfg, str(r.url))
                inicio = len(job.itens)
                job.itens.extend(linha for linha, _ in novos)
                job.paginas += 1
                contador[0] += 1
                emitir(job, "dados", f"página {job.paginas}: {len(novos)} itens (total {len(job.itens)})",
                       itens=len(novos), total=len(job.itens))
                if cfg.baixar_arquivos or cfg.modo == "descoberta":
                    await processar_arquivos(job, c, rp, novos, str(r.url), inicio, contador)
                prox = soup.select_one(cfg.seletor_proxima) if cfg.seletor_proxima else None
                url = urljoin(str(r.url), prox["href"]) if prox and prox.get("href") else None
                if not url or job.paginas >= cfg.max_paginas:
                    break
                await pausa_humana(job, contador[0])
        job.status = "parado" if CONTROLE[job.id]["parar"] else "concluido"
        salvar_saidas(job)
        baixados = sum(1 for a in job.arquivos if a["status"] == "baixado")
        emitir(job, "fim", f"{job.status}: {len(job.itens)} itens em {job.paginas} páginas"
               + (f", {sum(1 for a in job.arquivos if a['status'] == 'encontrado')} arquivos encontrados para baixar"
                  if cfg.modo == "descoberta" else f", {baixados} arquivos baixados" if cfg.baixar_arquivos else ""))
    except Exception as e:  # noqa: BLE001
        job.status = "erro"
        emitir(job, "erro", f"erro inesperado: {e}")


# --------------------------------------------------------------------------- rotas
@app.post("/api/jobs")
async def criar_job(cfg: Config):
    if cfg.pausa_min < 0.5 or cfg.pausa_max < cfg.pausa_min:
        raise HTTPException(400, "Pausa mínima deve ser ≥ 0,5 s e menor que a máxima")
    return iniciar(Job(id=uuid.uuid4().hex[:8], config=cfg,
                       tipo="descoberta" if cfg.modo == "descoberta" else "raspagem"))


def iniciar(job: Job):
    JOBS[job.id] = job
    banco.salvar_job(job)
    if job.tipo != "download_do_plano":
        banco.registrar_site(job)
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
            "status_http": j.status_http, "tipo": j.tipo, "plano_de": j.config.plano_de,
            "total_previsto": j.total_previsto, "processados": len(j.arquivos), "baixar_arquivos": j.config.baixar_arquivos,
            "arquivos_baixados": sum(1 for a in j.arquivos if a["status"] == "baixado"),
            "arquivos_ignorados": sum(1 for a in j.arquivos if a["status"] == "ignorado"),
            "arquivos_erro": sum(1 for a in j.arquivos if a["status"] == "erro"),
            "bytes_baixados": sum(a["tamanho"] for a in j.arquivos if a["status"] == "baixado")}


class Selecao(BaseModel):
    selecionados: list[str]
    pasta_destino: Optional[str] = None


@app.post("/api/planos/{jid}/baixar")
async def baixar_plano(jid: str, sel: Selecao):
    """Cria o download a partir da prévia, só com as URLs marcadas."""
    plano = JOBS.get(jid)
    if not plano or plano.tipo != "descoberta":
        raise HTTPException(404, "prévia não encontrada")
    if plano.status not in ("concluido", "parado"):
        raise HTTPException(400, "espere a prévia terminar")
    cfg = plano.config.model_copy(update={"modo": "completo", "plano_de": jid, "selecionados": sel.selecionados,
                                         "pasta_destino": sel.pasta_destino or plano.config.pasta_destino})
    return iniciar(Job(id=uuid.uuid4().hex[:8], config=cfg, tipo="download_do_plano"))


def motivo_dif(prev: Optional[int], feito: int, resultado: str) -> str:
    if resultado == "desmarcado":
        return "você desmarcou: não entrou no download"
    if resultado in ("ignorado", "erro", "pendente"):
        return f"não foi baixado ({resultado})"
    if resultado != "baixado":
        return ""
    if prev is None:
        return "o site não informou o tamanho na prévia"
    if prev == feito:
        return "igual ao previsto"
    return "o arquivo mudou no site entre a prévia e o download, ou o tamanho informado estava errado"


def comparativo(j: Job) -> list[dict]:
    """Previsto (prévia) × feito (download): uma linha por arquivo encontrado na prévia, com tamanhos."""
    plano = JOBS[j.config.plano_de]
    feitos = {a["url"]: a for a in j.arquivos}
    marcados = set(j.config.selecionados or [])
    antes = {a["url"]: a for x in JOBS.values() if x.config.plano_de == j.config.plano_de and x.criado_em < j.criado_em
             and x.id != j.id for a in x.arquivos if a["status"] == "baixado"}
    linhas = []
    for a in plano.arquivos:
        base = {k: a[k] for k in ("item", "item_titulo", "subpasta", "nome", "url")}
        prev = a.get("tamanho_previsto")
        if a["status"] != "encontrado":
            l = {**base, "previsto": "não", "resultado": a["status"], "motivo": a["motivo"], "arquivo": "", "tamanho": 0, "caminho": ""}
        elif a["url"] not in feitos and a["url"] in antes:
            f = antes[a["url"]]
            l = {**base, "previsto": "sim", "resultado": "baixado", "motivo": "já baixado numa execução anterior",
                 "arquivo": f["arquivo"], "tamanho": f["tamanho"], "caminho": f["caminho"]}
        elif j.config.selecionados is not None and a["url"] not in marcados:
            l = {**base, "previsto": "sim", "resultado": "desmarcado", "motivo": "desmarcado por você", "arquivo": "", "tamanho": 0, "caminho": ""}
        elif (f := feitos.get(a["url"])) is None:
            l = {**base, "previsto": "sim", "resultado": "pendente",
                 "motivo": "ainda não processado" if j.status in ("rodando", "pausado") else "interrompido antes",
                 "arquivo": "", "tamanho": 0, "caminho": ""}
        else:
            l = {**base, "previsto": "sim", "resultado": f["status"], "motivo": f["motivo"],
                 "arquivo": f["arquivo"], "tamanho": f["tamanho"] if f["status"] == "baixado" else 0, "caminho": f["caminho"]}
        l["tamanho_previsto"] = prev
        l["diferenca"] = (l["tamanho"] - prev) if prev is not None and l["resultado"] == "baixado" else None
        l["motivo_diferenca"] = motivo_dif(prev, l["tamanho"], l["resultado"]) if l["previsto"] == "sim" else "fora da prévia"
        linhas.append(l)
    return linhas


SAIDAS_DO_PAINEL = {"dados.csv", "dados.json", "previa_arquivos.csv", "previa_arquivos.json", "relatorio_arquivos.csv",
                    "relatorio_arquivos.json", "comparativo_previsto_x_feito.csv", "inconsistencias.csv"}


def inconsistencias(j: Job) -> list[dict]:
    """O que não bate entre a prévia, o relatório e o que está de fato na pasta."""
    if not j.config.plano_de or not j.pasta:
        return []
    raiz = Path(j.pasta)
    probs = []
    for l in comparativo(j):
        if l["previsto"] == "sim" and l["resultado"] in ("ignorado", "erro", "pendente"):
            esperado = raiz / limpar_nome(l["item_titulo"])
            if l["subpasta"]:
                esperado = esperado / limpar_nome(l["subpasta"])
            probs.append({"tipo": "a menos", "nome": l["nome"], "onde": str(esperado),
                          "detalhe": f"marcado na prévia, mas {l['resultado']}: {l['motivo']}", "url": l["url"]})
    # arquivos baixados por qualquer execução desta mesma prévia (retomadas contam como parte do download)
    irmaos = [x for x in JOBS.values() if x.config.plano_de == j.config.plano_de]
    registrados = {str(Path(a["caminho"]).resolve()) for x in irmaos for a in x.arquivos if a["status"] == "baixado"}
    for a in j.arquivos:
        if a["status"] == "baixado" and not Path(a["caminho"]).exists():
            probs.append({"tipo": "sumiu", "nome": a["nome"], "onde": a["caminho"],
                          "detalhe": "consta como baixado, mas não está mais na pasta", "url": a["url"]})
    if raiz.exists():
        for f in sorted(raiz.rglob("*")):
            if f.is_file() and f.name not in SAIDAS_DO_PAINEL and str(f.resolve()) not in registrados:
                probs.append({"tipo": "a mais", "nome": f.name, "onde": str(f),
                              "detalhe": "está na pasta, mas não faz parte deste download", "url": ""})
    return probs


def historico_plano(plano: Job) -> dict:
    """Situação acumulada de cada arquivo da prévia, somando todos os downloads feitos a partir dela."""
    downloads = sorted((x for x in JOBS.values() if x.config.plano_de == plano.id), key=lambda x: x.criado_em)
    ultimo: dict[str, dict] = {}
    selecionados_algum_dia: set[str] = set()
    for d in downloads:
        selecionados_algum_dia |= set(d.config.selecionados or [a["url"] for a in plano.arquivos])
        for a in d.arquivos:
            if ultimo.get(a["url"], {}).get("status") != "baixado":  # "baixado" vale mais que tentativas depois
                ultimo[a["url"]] = {**a, "job": d.id}
    linhas = []
    for a in plano.arquivos:
        base = {k: a.get(k) for k in ("item", "item_titulo", "subpasta", "nome", "url", "tamanho_previsto")}
        u = ultimo.get(a["url"])
        if a["status"] != "encontrado":
            situacao, motivo = "ignorado", a["motivo"]
        elif u:
            situacao = {"baixado": "feito", "erro": "erro", "ignorado": "ignorado"}.get(u["status"], "pendente")
            motivo = u["motivo"]
        elif downloads and a["url"] not in selecionados_algum_dia:
            situacao, motivo = "desmarcado", "nunca foi marcado para baixar"
        else:
            situacao, motivo = "pendente", "ainda não baixado"
        linhas.append({**base, "situacao": situacao, "motivo": motivo,
                       "caminho": u["caminho"] if u else "", "tamanho": u["tamanho"] if u else 0, "job": u["job"] if u else None})
    ultimo_dl = downloads[-1] if downloads else None
    return {"plano": plano.id, "downloads": [resumo(d) for d in downloads], "linhas": linhas,
            "pasta": (ultimo_dl.pasta if ultimo_dl else None) or plano.pasta,
            "rodando": any(d.status in ("rodando", "pausado", "aguardando_horario", "na_fila") for d in downloads)}


@app.get("/api/planos/{jid}/historico")
def historico(jid: str):
    plano = JOBS.get(jid)
    if not plano or plano.tipo != "descoberta":
        raise HTTPException(404, "prévia não encontrada")
    return historico_plano(plano)


class Continuar(BaseModel):
    item: Optional[int] = None        # só este item (pasta mãe)...
    subpasta: Optional[str] = None    # ...e, se informado, só esta subpasta
    incluir_desmarcados: bool = False


@app.post("/api/planos/{jid}/continuar")
async def continuar(jid: str, req: Continuar):
    """Continuar de onde parou: baixa só o que está pendente ou deu erro (pula o que já foi baixado)."""
    plano = JOBS.get(jid)
    if not plano or plano.tipo != "descoberta":
        raise HTTPException(404, "prévia não encontrada")
    h = historico_plano(plano)
    if h["rodando"]:
        raise HTTPException(400, "já existe um download desta prévia rodando ou pausado: retome ou pare ele primeiro")
    no_escopo = req.item is not None
    faltam = [l["url"] for l in h["linhas"]
              if l["situacao"] in ("pendente", "erro") or (l["situacao"] == "desmarcado" and (no_escopo or req.incluir_desmarcados))
              if req.item is None or (l["item"] == req.item and (req.subpasta is None or l["subpasta"] == req.subpasta))]
    if not faltam:
        raise HTTPException(400, "nada pendente aqui: tudo já foi baixado")
    cfg = plano.config.model_copy(update={"modo": "completo", "plano_de": jid, "selecionados": faltam,
                                         "pasta_destino": h["pasta"] or plano.config.pasta_destino})
    return iniciar(Job(id=uuid.uuid4().hex[:8], config=cfg, tipo="download_do_plano"))


@app.get("/api/sites")
def sites_usados():
    return banco.listar_sites()


@app.delete("/api/sites")
def esquecer_site(url: str):
    banco.apagar_site(url)
    return {"ok": True}


@app.get("/api/banco")
def info_banco():
    return {"banco": "Postgres" if "postgres" in str(banco.engine.url) else "SQLite", "onde": banco.DESCRICAO}


@app.get("/api/backup")
def baixar_backup():
    nome = f"backup_painel_{datetime.now():%Y-%m-%d_%H%M}.json"
    return Response(json.dumps(banco.exportar_backup(), ensure_ascii=False), media_type="application/json",
                    headers={"Content-Disposition": f"attachment; filename={nome}"})


@app.post("/api/backup")
async def restaurar(backup: dict):
    r = banco.restaurar_backup(backup)
    carregar_do_banco()
    return {"ok": True, **r}


def carregar_do_banco():
    """Ao subir o backend: recria o histórico. O que estava rodando vira 'interrompido'."""
    for dados, arqs in banco.carregar_tudo():
        if dados["id"] in JOBS and JOBS[dados["id"]].status in ("rodando", "pausado", "aguardando_horario", "na_fila"):
            continue
        job = Job(**{**dados, "arquivos": arqs})
        if job.status in ("rodando", "pausado", "aguardando_horario", "na_fila"):
            job.status = "interrompido"
            job.eventos.append({"t": datetime.now().strftime("%H:%M:%S"), "tipo": "aviso",
                                "msg": "o painel foi fechado no meio da execução; use 'Continuar de onde parou'"})
            banco.salvar_job(job)
        JOBS[job.id] = job
        ev = asyncio.Event(); ev.set()
        CONTROLE[job.id] = {"continuar": ev, "parar": True}


carregar_do_banco()


@app.get("/api/pasta-padrao")
def sugerir_pasta(url: str):
    return {"pasta": str(pasta_padrao(url).resolve())}


@app.get("/api/jobs")
def listar():
    return [resumo(j) for j in sorted(JOBS.values(), key=lambda j: j.criado_em, reverse=True)]


@app.get("/api/jobs/{jid}")
def detalhe(jid: str):
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "job não existe")
    return {**resumo(j), "config": j.config, "eventos": j.eventos[-300:], "pausas": j.pausas,
            "latencias": j.latencias, "amostra": j.itens[:200], "crawl_delay": j.crawl_delay,
            "arquivos": j.arquivos, "pasta": j.pasta,
            "comparativo": comparativo(j) if j.config.plano_de else None,
            "inconsistencias": inconsistencias(j) if j.status in ("concluido", "parado") else [],
            "downloads_do_plano": [x.id for x in JOBS.values() if x.config.plano_de == j.id]}


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
    if formato == "arquivos":  # lista de arquivos baixados (CSV)
        return Response(csv_texto(j.arquivos, COLS_ARQ), media_type="text/csv",
                        headers={"Content-Disposition": f"attachment; filename=arquivos_{jid}.csv"})
    if formato == "comparativo":
        if not j.config.plano_de:
            raise HTTPException(400, "comparativo só existe para downloads feitos a partir de uma prévia")
        return Response(csv_texto(comparativo(j), COLS_COMP), media_type="text/csv",
                        headers={"Content-Disposition": f"attachment; filename=comparativo_{jid}.csv"})
    if formato == "inconsistencias":
        return Response(csv_texto(inconsistencias(j), ["tipo", "nome", "onde", "detalhe", "url"]), media_type="text/csv",
                        headers={"Content-Disposition": f"attachment; filename=inconsistencias_{jid}.csv"})
    if formato == "json":
        return Response(json.dumps(j.itens, ensure_ascii=False, indent=2), media_type="application/json",
                        headers={"Content-Disposition": f"attachment; filename=raspagem_{jid}.json"})
    buf = io.StringIO()
    if j.itens:
        colunas = list(dict.fromkeys(k for linha in j.itens for k in linha))
        w = csv.DictWriter(buf, fieldnames=colunas, delimiter=";"); w.writeheader(); w.writerows(j.itens)
    return Response("\ufeff" + buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=raspagem_{jid}.csv"})


@app.get("/api/jobs/{jid}/arquivos/{n}")
def abrir_arquivo(jid: str, n: int):
    """Entrega um arquivo baixado (para abrir direto pelo painel)."""
    j = JOBS.get(jid)
    if not j or n >= len(j.arquivos) or not j.arquivos[n]["caminho"]:
        raise HTTPException(404)
    return FileResponse(j.arquivos[n]["caminho"], filename=j.arquivos[n]["nome"])
