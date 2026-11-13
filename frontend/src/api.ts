export type Campo = { nome: string; seletor: string; atributo?: string | null }

export type Config = {
  url: string
  seletor_item: string
  campos: Campo[]
  seletor_proxima?: string | null
  max_paginas: number
  pausa_min: number
  pausa_max: number
  pausa_longa_cada: number
  pausa_longa_seg: number
  auto_throttle: boolean
  max_tentativas: number
  user_agent: string
  hora_inicio?: number | null
  hora_fim?: number | null
}

export type Check = { item: string; ok: boolean; detalhe: string }
export type Verificacao = {
  url: string
  latencia_ms: number
  checks: Check[]
  titulo: string | null
  sugestoes: { seletor: string; ocorrencias: number }[]
}

export type Evento = { t: string; tipo: string; msg: string; [k: string]: unknown }

export type JobResumo = {
  id: string
  url: string
  status: string
  criado_em: string
  paginas: number
  max_paginas: number
  itens: number
  requisicoes: number
  latencia_media: number | null
  pausa_media: number | null
  status_http: Record<string, number>
}

export type JobDetalhe = JobResumo & {
  config: Config
  eventos: Evento[]
  pausas: number[]
  latencias: number[]
  amostra: Record<string, unknown>[]
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init })
  if (!r.ok) {
    const corpo = await r.json().catch(() => ({}))
    throw new Error(corpo.detail ?? `HTTP ${r.status}`)
  }
  return r.json()
}

export const api = {
  verificar: (url: string, user_agent: string) =>
    req<Verificacao>('/api/verificar', { method: 'POST', body: JSON.stringify({ url, user_agent }) }),
  criarJob: (cfg: Config) => req<{ id: string }>('/api/jobs', { method: 'POST', body: JSON.stringify(cfg) }),
  listar: () => req<JobResumo[]>('/api/jobs'),
  detalhe: (id: string) => req<JobDetalhe>(`/api/jobs/${id}`),
  controlar: (id: string, acao: 'pausar' | 'retomar' | 'parar') =>
    req(`/api/jobs/${id}/${acao}`, { method: 'POST' }),
  exportarUrl: (id: string, formato: 'csv' | 'json') => `/api/jobs/${id}/exportar?formato=${formato}`,
}

export const PADRAO: Config = {
  url: '',
  seletor_item: 'article',
  campos: [],
  seletor_proxima: '',
  max_paginas: 5,
  pausa_min: 1,
  pausa_max: 2,
  pausa_longa_cada: 10,
  pausa_longa_seg: 15,
  auto_throttle: true,
  max_tentativas: 4,
  user_agent: 'PainelRaspagemBot/0.1 (+mailto:seu-email@exemplo.com; dados abertos)',
  hora_inicio: null,
  hora_fim: null,
}

export const MODELOS: { nome: string; cfg: Partial<Config> }[] = [
  {
    nome: 'Livraria Exemplo (site local do guia)',
    cfg: {
      url: 'http://127.0.0.1:8000/catalogo?pagina=1',
      seletor_item: 'article.livro',
      seletor_proxima: 'a.proxima',
      campos: [
        { nome: 'titulo', seletor: 'h3 a' },
        { nome: 'autor', seletor: '.autor' },
        { nome: 'preco', seletor: '.preco' },
        { nome: 'capa', seletor: 'img.capa', atributo: 'src' },
      ],
    },
  },
  {
    nome: 'books.toscrape.com',
    cfg: {
      url: 'https://books.toscrape.com/',
      seletor_item: 'article.product_pod',
      seletor_proxima: 'li.next a',
      campos: [
        { nome: 'titulo', seletor: 'h3 a', atributo: 'title' },
        { nome: 'preco', seletor: '.price_color' },
        { nome: 'link', seletor: 'h3 a', atributo: 'href' },
      ],
    },
  },
  {
    nome: 'quotes.toscrape.com',
    cfg: {
      url: 'https://quotes.toscrape.com/',
      seletor_item: 'div.quote',
      seletor_proxima: 'li.next a',
      campos: [
        { nome: 'frase', seletor: '.text' },
        { nome: 'autor', seletor: '.author' },
        { nome: 'tags', seletor: '.tags' },
      ],
    },
  },
]
