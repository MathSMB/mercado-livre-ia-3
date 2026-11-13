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
  respeitar_robots: boolean
  auto_throttle: boolean
  max_tentativas: number
  user_agent: string
  hora_inicio?: number | null
  hora_fim?: number | null
  baixar_arquivos: boolean
  seletor_link_item?: string | null
  seletor_subpasta?: string | null
  extensoes: string[]
  max_tamanho_mb: number
  max_arquivos: number
  modo: 'completo' | 'descoberta'
  pasta_destino?: string | null
  consultar_tamanho: boolean
  salvar_json: boolean
  salvar_csv: boolean
}

export type Arquivo = {
  item: number
  item_titulo: string
  subpasta: string
  nome: string
  url: string
  status: 'encontrado' | 'baixado' | 'ignorado' | 'erro'
  motivo: string
  arquivo: string
  tamanho: number
  caminho: string
  tamanho_previsto: number | null
}

export type LinhaComparativo = {
  item: number
  item_titulo: string
  subpasta: string
  nome: string
  url: string
  previsto: 'sim' | 'não'
  resultado: 'baixado' | 'ignorado' | 'erro' | 'desmarcado' | 'pendente' | 'encontrado'
  motivo: string
  arquivo: string
  tamanho: number
  tamanho_previsto: number | null
  diferenca: number | null
  motivo_diferenca: string
}

export type Inconsistencia = { tipo: 'a menos' | 'a mais' | 'sumiu'; nome: string; onde: string; detalhe: string; url: string }

export type LinhaHistorico = {
  item: number
  item_titulo: string
  subpasta: string
  nome: string
  url: string
  tamanho_previsto: number | null
  situacao: 'feito' | 'pendente' | 'erro' | 'ignorado' | 'desmarcado'
  motivo: string
  caminho: string
  tamanho: number
  job: string | null
}
export type Historico = { plano: string; downloads: JobResumo[]; linhas: LinhaHistorico[]; pasta: string | null; rodando: boolean }
export type Site = { url: string; usos: number; primeiro_uso: string; ultimo_uso: string; ultimo_job: string; config: Config }

export type Check = { item: string; ok: boolean; detalhe: string }
export type Verificacao = {
  url: string
  latencia_ms: number
  crawl_delay: number | null
  robots_txt: string | null
  pode_raspar: boolean
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
  tipo: 'raspagem' | 'descoberta' | 'download_do_plano'
  plano_de: string | null
  total_previsto: number | null
  processados: number
  baixar_arquivos: boolean
  arquivos_baixados: number
  arquivos_ignorados: number
  arquivos_erro: number
  bytes_baixados: number
}

export type JobDetalhe = JobResumo & {
  config: Config
  eventos: Evento[]
  pausas: number[]
  latencias: number[]
  amostra: Record<string, unknown>[]
  crawl_delay: number | null
  arquivos: Arquivo[]
  pasta: string | null
  comparativo: LinhaComparativo[] | null
  downloads_do_plano: string[]
  inconsistencias: Inconsistencia[]
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
  baixarPlano: (id: string, selecionados: string[], pasta_destino: string | null) =>
    req<{ id: string }>(`/api/planos/${id}/baixar`, { method: 'POST', body: JSON.stringify({ selecionados, pasta_destino }) }),
  historico: (id: string) => req<Historico>(`/api/planos/${id}/historico`),
  continuar: (id: string, escopo: { item?: number; subpasta?: string; incluir_desmarcados?: boolean } = {}) =>
    req<{ id: string }>(`/api/planos/${id}/continuar`, { method: 'POST', body: JSON.stringify(escopo) }),
  sites: () => req<Site[]>('/api/sites'),
  esquecerSite: (url: string) => req(`/api/sites?url=${encodeURIComponent(url)}`, { method: 'DELETE' }),
  banco: () => req<{ banco: string; onde: string }>('/api/banco'),
  backupUrl: '/api/backup',
  restaurarBackup: (dados: unknown) =>
    req<{ jobs: number; arquivos: number; sites: number }>('/api/backup', { method: 'POST', body: JSON.stringify(dados) }),
  pastaPadrao: (url: string) => req<{ pasta: string }>(`/api/pasta-padrao?url=${encodeURIComponent(url)}`),
  arquivoUrl: (id: string, n: number) => `/api/jobs/${id}/arquivos/${n}`,
  exportarUrl: (id: string, formato: 'csv' | 'json' | 'arquivos' | 'comparativo' | 'inconsistencias') => `/api/jobs/${id}/exportar?formato=${formato}`,
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
  respeitar_robots: true,
  auto_throttle: true,
  max_tentativas: 4,
  user_agent: 'PainelRaspagemBot/0.1 (+mailto:seu-email@exemplo.com; dados abertos)',
  hora_inicio: null,
  hora_fim: null,
  baixar_arquivos: false,
  seletor_link_item: '',
  seletor_subpasta: '',
  extensoes: ['pdf', 'csv', 'xlsx', 'xls', 'ods', 'zip', 'json', 'xml', 'txt', 'doc', 'docx', 'odt'],
  max_tamanho_mb: 50,
  max_arquivos: 200,
  modo: 'completo',
  pasta_destino: '',
  consultar_tamanho: true,
  salvar_json: false,
  salvar_csv: true,
}

export const MODELOS: { nome: string; cfg: Partial<Config> }[] = [
  {
    nome: 'Livraria Exemplo (site local do guia)',
    cfg: {
      url: 'http://127.0.0.1:8000/catalogo?pagina=1',
      seletor_item: 'article.livro',
      seletor_proxima: 'a.proxima',
      baixar_arquivos: true,
      seletor_link_item: 'h3 a',
      campos: [
        { nome: 'titulo', seletor: 'h3 a' },
        { nome: 'autor', seletor: '.autor' },
        { nome: 'preco', seletor: '.preco' },
        { nome: 'capa', seletor: 'img.capa', atributo: 'src' },
      ],
    },
  },
  {
    nome: 'Cursos com módulos (site local: pastas e subpastas)',
    cfg: {
      url: 'http://127.0.0.1:8000/cursos',
      seletor_item: 'article.curso',
      campos: [{ nome: 'curso', seletor: 'h3 a' }],
      baixar_arquivos: true,
      seletor_link_item: 'h3 a',
      seletor_subpasta: 'a.modulo',
      max_paginas: 1,
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
