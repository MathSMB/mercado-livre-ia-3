"""Livraria Exemplo: site fictício local (baseado no guia de estudo) para testar o painel.
Uso: python site_ficticio.py [--bloquear]   -> http://127.0.0.1:8000
"""
import sys, time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORTA, POR_PAGINA = 8000, 10
BLOQUEAR = "--bloquear" in sys.argv
LIVROS = [{"id": i, "titulo": f"Livro Fictício nº {i}", "autor": ["Ana Lima", "Bruno Costa", "Carla Dias"][i % 3],
           "preco": round(19.9 + i * 3.5, 2), "estoque": (i * 7) % 13} for i in range(1, 31)]
acessos = defaultdict(deque)
# "Cursos": itens que abrem "pastas" (módulos), cada uma com vários arquivos
CURSOS = {"introducao": ("Introdução", {1: 5, 2: 6}), "avancado": ("Avançado", {1: 3, 2: 2, 3: 4})}
ROBOTS = "User-agent: *\nAllow: /catalogo\nAllow: /capas/\nDisallow: /admin\nCrawl-delay: 1\nSitemap: http://127.0.0.1:8000/sitemap.xml\n"


def nota(h, ip):
    n, m = 0, []
    ua = h.get("User-Agent", "")
    if not ua or any(x in ua for x in ("python-requests", "curl/", "HeadlessChrome", "python-urllib")):
        n += 3; m.append("UA de biblioteca")
    if "Accept-Language" not in h:
        n += 1; m.append("sem Accept-Language")
    agora = time.time(); f = acessos[ip]; f.append(agora)
    while f and agora - f[0] > 2:
        f.popleft()
    if len(f) > 5:
        n += 3; m.append(f"{len(f)} req em 2s")
    return n, m


def catalogo(p):
    itens = LIVROS[(p - 1) * POR_PAGINA: p * POR_PAGINA]
    cards = "\n".join(f'<article class="livro" data-id="{l["id"]}"><img class="capa" src="/capas/{l["id"]}.svg">'
                      f'<h3><a href="/produto/{l["id"]}">{l["titulo"]}</a></h3><p class="autor">{l["autor"]}</p>'
                      f'<p class="preco">R$ {l["preco"]:.2f}</p></article>' for l in itens)
    prox = f'<a class="proxima" href="/catalogo?pagina={p + 1}">próxima</a>' if p * POR_PAGINA < len(LIVROS) else ""
    return f'<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Livraria Exemplo — página {p}</title></head><body><h1>Livraria Exemplo</h1><section>{cards}</section><nav>{prox}</nav></body></html>'


def pdf_minimo(texto):
    """Gera um PDF de 1 página com uma linha de texto (só biblioteca padrão)."""
    texto = texto.encode("latin-1", "replace").decode("latin-1")
    stream = f"BT /F1 18 Tf 72 720 Td ({texto}) Tj ET".encode("latin-1")
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>stream\n" % len(stream) + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offs = b"%PDF-1.4\n", []
    for n, o in enumerate(objs, 1):
        offs.append(len(out)); out += b"%d 0 obj\n" % n + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % x for x in offs)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def r(self, s, corpo, tipo="text/html; charset=utf-8", extra=None, sem_tamanho=False):
        d = corpo.encode() if isinstance(corpo, str) else corpo
        self.send_response(s); self.send_header("Content-Type", tipo)
        if not sem_tamanho:  # alguns sites não informam o tamanho (vira "desconhecido" na prévia)
            self.send_header("Content-Length", str(len(d)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(d)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        n, m = nota(self.headers, self.client_address[0])
        rota = urlparse(self.path)
        print(f"[{time.strftime('%H:%M:%S')}] GET {self.path:<24} nota={n} {'; '.join(m)} UA={self.headers.get('User-Agent','')[:50]}")
        if BLOQUEAR and n >= 4 and rota.path != "/robots.txt":
            return self.r(429, "Calma aí, robô.\n", "text/plain", {"Retry-After": "5"})
        if rota.path == "/robots.txt":
            return self.r(200, ROBOTS, "text/plain")
        if rota.path == "/sitemap.xml":
            urls = "".join(f"<url><loc>http://127.0.0.1:8000/catalogo?pagina={i}</loc></url>" for i in (1, 2, 3))
            return self.r(200, f'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>', "application/xml")
        if rota.path in ("/", "/catalogo"):
            return self.r(200, catalogo(int(parse_qs(rota.query).get("pagina", ["1"])[0])))
        if rota.path.startswith("/produto/"):
            l = LIVROS[int(rota.path.split("/")[-1]) - 1]
            extra = '<li><a href="/arquivos/acervo_completo.zip">Acervo completo (ZIP, 80 MB)</a></li>' if l["id"] == 1 else ""
            return self.r(200, f'<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>{l["titulo"]}</title></head><body>'
                               f'<h1>{l["titulo"]}</h1><p>Estoque: {l["estoque"]}</p><h2>Arquivos para download</h2><ul>'
                               f'<li><a href="/arquivos/ficha_{l["id"]}.csv">Ficha técnica (CSV)</a></li>'
                               f'<li><a href="/arquivos/resumo_{l["id"]}.pdf">Resumo (PDF)</a></li>{extra}'
                               f'<li><a href="/admin/rascunho_{l["id"]}.pdf">Rascunho interno (PDF)</a></li></ul></body></html>')
        if rota.path == "/cursos":
            cards = "".join(f'<article class="curso"><h3><a href="/curso/{k}">{t}</a></h3><p>{len(m)} módulos</p></article>'
                            for k, (t, m) in CURSOS.items())
            return self.r(200, f'<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Cursos abertos</title></head><body><h1>Cursos abertos</h1>{cards}</body></html>')
        if rota.path.startswith("/curso/"):
            partes = rota.path.strip("/").split("/")
            titulo, modulos = CURSOS[partes[1]]
            if len(partes) == 2:
                links = "".join(f'<li><a class="modulo" href="/curso/{partes[1]}/modulo/{n}">Módulo {n}</a></li>' for n in modulos)
                return self.r(200, f'<!doctype html><html><head><meta charset="utf-8"><title>{titulo}</title></head><body><h1>{titulo}</h1>'
                                   f'<p><a href="/arquivos/curso_{partes[1]}_programa.pdf">Programa do curso (PDF)</a></p><ul>{links}</ul></body></html>')
            n = int(partes[3])
            arqs = "".join(f'<li><a href="/arquivos/curso_{partes[1]}_m{n}_aula{k}.pdf">Aula {k} (PDF)</a></li>' for k in range(1, modulos[n] + 1))
            if n == 2 and partes[1] == "introducao":
                arqs += f'<li><a href="/arquivos/curso_{partes[1]}_m2_removido.pdf">Material removido (PDF)</a></li>'
            return self.r(200, f'<!doctype html><html><head><meta charset="utf-8"><title>{titulo} — Módulo {n}</title></head><body><h1>{titulo} › Módulo {n}</h1><ul>{arqs}</ul></body></html>')
        if rota.path.startswith("/arquivos/"):
            nome = rota.path.split("/")[-1]
            if nome.startswith("curso_"):
                if "removido" in nome:
                    return self.r(404, "não encontrado\n", "text/plain")
                return self.r(200, pdf_minimo(nome.removesuffix(".pdf")), "application/pdf", sem_tamanho="aula3" in nome)
            if nome.endswith(".zip"):  # arquivo "grande" para testar o limite de tamanho
                return self.r(200, b"0" * (80 * 1024 * 1024), "application/zip")
            i = int(nome.split("_")[1].split(".")[0])
            l = LIVROS[i - 1]
            if nome.endswith(".csv"):
                return self.r(200, "id;titulo;autor;preco;estoque\n" + f'{l["id"]};{l["titulo"]};{l["autor"]};{l["preco"]};{l["estoque"]}\n', "text/csv; charset=utf-8")
            return self.r(200, pdf_minimo(f'Resumo do {l["titulo"]}'), "application/pdf")
        if rota.path.startswith("/capas/"):
            i = int(rota.path.split("/")[-1].removesuffix(".svg"))
            return self.r(200, f'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="#2980b9"/><text x="60" y="95" fill="white" text-anchor="middle">#{i}</text></svg>', "image/svg+xml")
        return self.r(404, "não encontrado\n", "text/plain")


if __name__ == "__main__":
    print(f"Livraria Exemplo em http://127.0.0.1:{PORTA} (bloqueio {'LIGADO' if BLOQUEAR else 'desligado'})")
    ThreadingHTTPServer(("127.0.0.1", PORTA), H).serve_forever()
