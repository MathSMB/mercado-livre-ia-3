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


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def r(self, s, corpo, tipo="text/html; charset=utf-8", extra=None):
        d = corpo.encode() if isinstance(corpo, str) else corpo
        self.send_response(s); self.send_header("Content-Type", tipo); self.send_header("Content-Length", str(len(d)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers(); self.wfile.write(d)

    def do_GET(self):
        n, m = nota(self.headers, self.client_address[0])
        rota = urlparse(self.path)
        print(f"[{time.strftime('%H:%M:%S')}] GET {self.path:<24} nota={n} {'; '.join(m)} UA={self.headers.get('User-Agent','')[:50]}")
        if BLOQUEAR and n >= 4:
            return self.r(429, "Calma aí, robô.\n", "text/plain", {"Retry-After": "5"})
        if rota.path == "/sitemap.xml":
            urls = "".join(f"<url><loc>http://127.0.0.1:8000/catalogo?pagina={i}</loc></url>" for i in (1, 2, 3))
            return self.r(200, f'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>', "application/xml")
        if rota.path in ("/", "/catalogo"):
            return self.r(200, catalogo(int(parse_qs(rota.query).get("pagina", ["1"])[0])))
        if rota.path.startswith("/capas/"):
            i = int(rota.path.split("/")[-1].removesuffix(".svg"))
            return self.r(200, f'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="#2980b9"/><text x="60" y="95" fill="white" text-anchor="middle">#{i}</text></svg>', "image/svg+xml")
        return self.r(404, "não encontrado\n", "text/plain")


if __name__ == "__main__":
    print(f"Livraria Exemplo em http://127.0.0.1:{PORTA} (bloqueio {'LIGADO' if BLOQUEAR else 'desligado'})")
    ThreadingHTTPServer(("127.0.0.1", PORTA), H).serve_forever()
