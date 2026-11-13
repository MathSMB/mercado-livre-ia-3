"""
Persistência do painel (histórico de execuções, arquivos e sites usados).

Banco escolhido pela variável DATABASE_URL:
  - Postgres (docker compose up -d):  postgresql+psycopg://painel:painel@localhost:5433/painel
  - Por padrão tenta o Postgres do docker-compose (localhost:5433). Se ele estiver fora do ar,
    usa SQLite em backend/painel.db (zero configuração). Para forçar SQLite: DATABASE_URL=sqlite:///painel.db

Tabelas:
  jobs      uma linha por execução (prévia, raspagem, download). O estado completo vai em JSON.
  arquivos  uma linha por arquivo processado, gravada NA HORA. É o que permite retomar de onde parou.
  sites     um resumo por URL usada (última configuração, quantas vezes, quando).
"""
import json
import os
from datetime import datetime
from pathlib import Path

from sqlalchemy import (Column, Integer, MetaData, String, Table, Text, create_engine, delete, insert, select,
                        text, update)
from sqlalchemy.exc import OperationalError

SQLITE_URL = f"sqlite:///{Path(__file__).parent / 'painel.db'}"

meta = MetaData()
jobs = Table("jobs", meta,
             Column("id", String(16), primary_key=True),
             Column("tipo", String(32)), Column("status", String(32)), Column("url", Text),
             Column("criado_em", String(32)), Column("atualizado_em", String(32)),
             Column("dados", Text))  # Job em JSON (sem a lista de arquivos)
arquivos = Table("arquivos", meta,
                 Column("job_id", String(16), primary_key=True), Column("seq", Integer, primary_key=True),
                 Column("dados", Text))
sites = Table("sites", meta,
              Column("url", Text, primary_key=True), Column("usos", Integer),
              Column("primeiro_uso", String(32)), Column("ultimo_uso", String(32)),
              Column("ultimo_job", String(16)), Column("config", Text))


POSTGRES_PADRAO = "postgresql+psycopg://painel:painel@localhost:5433/painel"  # o do docker-compose.yml


def _conectar():
    url = os.environ.get("DATABASE_URL", POSTGRES_PADRAO)
    if url.startswith("postgresql"):
        try:
            eng = create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 3})
            with eng.connect() as c:
                c.execute(text("select 1"))
            return eng, url.split("@")[-1]
        except OperationalError as e:
            print(f"[db] Postgres indisponível ({e.__class__.__name__}); usando SQLite em {SQLITE_URL}")
    elif url.startswith("sqlite"):
        return create_engine(url), url
    return create_engine(SQLITE_URL), SQLITE_URL


engine, DESCRICAO = _conectar()
meta.create_all(engine)
print(f"[db] histórico em: {DESCRICAO}")


def agora():
    return datetime.now().isoformat(timespec="seconds")


def salvar_job(job) -> None:
    dados = job.model_dump(exclude={"arquivos"})
    dados["eventos"] = dados["eventos"][-300:]
    linha = {"tipo": job.tipo, "status": job.status, "url": job.config.url, "criado_em": job.criado_em,
             "atualizado_em": agora(), "dados": json.dumps(dados, ensure_ascii=False)}
    with engine.begin() as c:
        if c.execute(update(jobs).where(jobs.c.id == job.id).values(**linha)).rowcount == 0:
            c.execute(insert(jobs).values(id=job.id, **linha))


def salvar_arquivo(job_id: str, seq: int, reg: dict) -> None:
    with engine.begin() as c:
        c.execute(insert(arquivos).values(job_id=job_id, seq=seq, dados=json.dumps(reg, ensure_ascii=False)))


def registrar_site(job) -> None:
    url, cfg = job.config.url, job.config.model_dump(exclude={"selecionados", "plano_de"})
    with engine.begin() as c:
        atual = c.execute(select(sites).where(sites.c.url == url)).first()
        if atual:
            c.execute(update(sites).where(sites.c.url == url).values(
                usos=atual.usos + 1, ultimo_uso=agora(), ultimo_job=job.id, config=json.dumps(cfg, ensure_ascii=False)))
        else:
            c.execute(insert(sites).values(url=url, usos=1, primeiro_uso=agora(), ultimo_uso=agora(),
                                           ultimo_job=job.id, config=json.dumps(cfg, ensure_ascii=False)))


def listar_sites() -> list[dict]:
    with engine.connect() as c:
        rows = c.execute(select(sites).order_by(sites.c.ultimo_uso.desc())).all()
    return [{"url": r.url, "usos": r.usos, "primeiro_uso": r.primeiro_uso, "ultimo_uso": r.ultimo_uso,
             "ultimo_job": r.ultimo_job, "config": json.loads(r.config)} for r in rows]


def apagar_site(url: str) -> None:
    with engine.begin() as c:
        c.execute(delete(sites).where(sites.c.url == url))


def carregar_tudo() -> list[tuple[dict, list[dict]]]:
    """Lê todas as execuções e seus arquivos (usado quando o backend sobe)."""
    with engine.connect() as c:
        js = c.execute(select(jobs)).all()
        arqs = c.execute(select(arquivos).order_by(arquivos.c.job_id, arquivos.c.seq)).all()
    por_job: dict[str, list[dict]] = {}
    for a in arqs:
        por_job.setdefault(a.job_id, []).append(json.loads(a.dados))
    return [(json.loads(j.dados), por_job.get(j.id, [])) for j in js]


def exportar_backup() -> dict:
    """Tudo do banco em um JSON portátil (serve para Postgres e SQLite)."""
    with engine.connect() as c:
        return {
            "versao": 1, "gerado_em": agora(), "origem": DESCRICAO.split("/")[-1] if "sqlite" in DESCRICAO else "postgres",
            "jobs": [dict(r._mapping) for r in c.execute(select(jobs)).all()],
            "arquivos": [dict(r._mapping) for r in c.execute(select(arquivos)).all()],
            "sites": [dict(r._mapping) for r in c.execute(select(sites)).all()],
        }


def restaurar_backup(b: dict) -> dict:
    """Mescla um backup no banco atual (o que já existe com o mesmo id é substituído)."""
    with engine.begin() as c:
        for j in b.get("jobs", []):
            c.execute(delete(jobs).where(jobs.c.id == j["id"]))
            c.execute(delete(arquivos).where(arquivos.c.job_id == j["id"]))
            c.execute(insert(jobs).values(**j))
        for a in b.get("arquivos", []):
            c.execute(insert(arquivos).values(**a))
        for s in b.get("sites", []):
            c.execute(delete(sites).where(sites.c.url == s["url"]))
            c.execute(insert(sites).values(**s))
    return {"jobs": len(b.get("jobs", [])), "arquivos": len(b.get("arquivos", [])), "sites": len(b.get("sites", []))}
