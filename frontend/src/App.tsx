import { useEffect, useMemo, useState } from 'react'
import { api, MODELOS, PADRAO } from './api'
import type { Arquivo, Campo, Config, Evento, Historico as THistorico, Inconsistencia, JobDetalhe, JobResumo, LinhaComparativo, LinhaHistorico, Site, Verificacao } from './api'

type Rota = { tela: 'visao' } | { tela: 'nova' } | { tela: 'job'; id: string } | { tela: 'praticas' } | { tela: 'dados' }

function lerRota(): Rota {
  const h = location.hash.replace('#/', '')
  if (h.startsWith('job/')) return { tela: 'job', id: h.slice(4) }
  if (h === 'nova') return { tela: 'nova' }
  if (h === 'praticas') return { tela: 'praticas' }
  if (h === 'dados') return { tela: 'dados' }
  return { tela: 'visao' }
}

export default function App() {
  const [rota, setRota] = useState<Rota>(lerRota)
  useEffect(() => {
    const f = () => setRota(lerRota())
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])

  return (
    <div className="layout">
      <aside className="lateral">
        <div className="marca">
          <span className="logo">◐</span>
          <div>
            <strong>Raspagem Humana</strong>
            <small>dados abertos, no ritmo certo</small>
          </div>
        </div>
        <nav>
          <a className={rota.tela === 'visao' ? 'ativo' : ''} href="#/">Visão geral</a>
          <a className={rota.tela === 'nova' ? 'ativo' : ''} href="#/nova">Nova raspagem</a>
          <a className={rota.tela === 'dados' ? 'ativo' : ''} href="#/dados">Banco e backup</a>
          <a className={rota.tela === 'praticas' ? 'ativo' : ''} href="#/praticas">Boas práticas</a>
        </nav>
        <div className="rodape-lateral">
          <span className="ponto ok" /> 1 requisição por vez por domínio
        </div>
      </aside>
      <main>
        {rota.tela === 'visao' && <VisaoGeral />}
        {rota.tela === 'nova' && <NovaRaspagem />}
        {rota.tela === 'job' && <Execucao id={rota.id} />}
        {rota.tela === 'praticas' && <Praticas />}
        {rota.tela === 'dados' && <BancoBackup />}
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------ visão geral */
const ROTULO: Record<string, string> = {
  na_fila: 'Na fila', rodando: 'Rodando', pausado: 'Pausado', aguardando_horario: 'Aguardando horário',
  concluido: 'Concluído', parado: 'Parado', erro: 'Erro', interrompido: 'Interrompido',
}
function Selo({ s }: { s: string }) {
  return <span className={`selo selo-${s}`}>{ROTULO[s] ?? s}</span>
}

function VisaoGeral() {
  const [jobs, setJobs] = useState<JobResumo[]>([])
  useEffect(() => {
    const f = () => api.listar().then(setJobs).catch(() => {})
    f()
    const t = setInterval(f, 2000)
    return () => clearInterval(t)
  }, [])
  const tot = useMemo(() => {
    const reqs = jobs.reduce((a, j) => a + j.requisicoes, 0)
    const erros = jobs.reduce(
      (a, j) => a + Object.entries(j.status_http).filter(([k]) => +k >= 400).reduce((b, [, v]) => b + v, 0), 0)
    const pausas = jobs.filter((j) => j.pausa_media != null)
    return {
      itens: jobs.reduce((a, j) => a + j.itens, 0),
      reqs,
      ativos: jobs.filter((j) => ['rodando', 'pausado', 'aguardando_horario'].includes(j.status)).length,
      pausa: pausas.length ? pausas.reduce((a, j) => a + (j.pausa_media ?? 0), 0) / pausas.length : null,
      taxaErro: reqs ? (erros / reqs) * 100 : 0,
    }
  }, [jobs])

  return (
    <>
      <header className="topo">
        <div>
          <h1>Visão geral</h1>
          <p className="sub">Todas as raspagens, com o ritmo e a saúde de cada uma.</p>
        </div>
        <a className="botao primario" href="#/nova">+ Nova raspagem</a>
      </header>
      <section className="kpis">
        <Kpi rotulo="Raspagens ativas" valor={tot.ativos} />
        <Kpi rotulo="Itens coletados" valor={tot.itens.toLocaleString('pt-BR')} />
        <Kpi rotulo="Requisições feitas" valor={tot.reqs} />
        <Kpi rotulo="Pausa média" valor={tot.pausa ? `${tot.pausa.toFixed(2)} s` : '—'} dica="entre requisições" />
        <Kpi rotulo="Taxa de erro" valor={`${tot.taxaErro.toFixed(1)}%`} dica="respostas 4xx/5xx" alerta={tot.taxaErro > 5} />
      </section>
      <section className="cartao">
        <h2>Raspagens recentes</h2>
        {jobs.length === 0 ? (
          <div className="vazio">
            Nenhuma raspagem ainda. <a href="#/nova">Comece verificando um site.</a>
          </div>
        ) : (
          <table className="tabela">
            <thead>
              <tr><th>Site</th><th>Status</th><th>Progresso</th><th>Itens</th><th>Latência média</th><th>Pausa média</th><th>Início</th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} onClick={() => (location.hash = `#/job/${j.id}`)} className="clicavel">
                  <td className="url">{new URL(j.url).host}<small>{new URL(j.url).pathname}</small></td>
                  <td><Selo s={j.status} /></td>
                  <td><Barra v={j.paginas} max={j.max_paginas} /> <small>{j.paginas}/{j.max_paginas} págs.</small></td>
                  <td>{j.itens}</td>
                  <td>{j.latencia_media != null ? `${j.latencia_media} ms` : '—'}</td>
                  <td>{j.pausa_media != null ? `${j.pausa_media} s` : '—'}</td>
                  <td>{j.criado_em.slice(11)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

function Kpi({ rotulo, valor, dica, alerta }: { rotulo: string; valor: string | number; dica?: string; alerta?: boolean }) {
  return (
    <div className={`kpi ${alerta ? 'alerta' : ''}`}>
      <span>{rotulo}</span>
      <strong>{valor}</strong>
      {dica && <small>{dica}</small>}
    </div>
  )
}

function Barra({ v, max }: { v: number; max: number }) {
  return <span className="barra"><span style={{ width: `${Math.min(100, (v / Math.max(1, max)) * 100)}%` }} /></span>
}

/* ------------------------------------------------------------------ nova raspagem */
function NovaRaspagem() {
  const [cfg, setCfg] = useState<Config>(PADRAO)
  const [ver, setVer] = useState<Verificacao | null>(null)
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState('')
  const [usarJanela, setUsarJanela] = useState(false)
  const [pastaSugerida, setPastaSugerida] = useState('')
  const [extTexto, setExtTexto] = useState(PADRAO.extensoes.join(', '))
  useEffect(() => {
    if (!/^https?:\/\/.+/.test(cfg.url)) return
    const t = setTimeout(() => api.pastaPadrao(cfg.url).then((r) => setPastaSugerida(r.pasta)).catch(() => {}), 400)
    return () => clearTimeout(t)
  }, [cfg.url])
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg((c) => ({ ...c, [k]: v }))

  async function verificar() {
    setErro(''); setCarregando(true); setVer(null)
    try {
      const v = await api.verificar(cfg.url, cfg.user_agent)
      setVer(v)
      if (v.crawl_delay && v.crawl_delay > cfg.pausa_min)
        setCfg((c) => ({ ...c, pausa_min: v.crawl_delay!, pausa_max: Math.max(c.pausa_max, v.crawl_delay! + 1) }))
      if (cfg.seletor_item === 'article' && v.sugestoes[0]) set('seletor_item', v.sugestoes[0].seletor)
    } catch (e) {
      setErro((e as Error).message)
    } finally {
      setCarregando(false)
    }
  }

  async function iniciar(modo: Config['modo']) {
    setErro('')
    try {
      const final = usarJanela ? cfg : { ...cfg, hora_inicio: null, hora_fim: null }
      const { id } = await api.criarJob({
        ...final,
        modo,
        seletor_proxima: final.seletor_proxima || null,
        seletor_link_item: final.seletor_link_item || null,
        seletor_subpasta: final.seletor_subpasta || null,
        pasta_destino: final.pasta_destino || null,
        extensoes: extTexto.split(/[,\s]+/).map((e) => e.replace(/^\./, '').trim()).filter(Boolean),
      })
      location.hash = `#/job/${id}`
    } catch (e) {
      setErro((e as Error).message)
    }
  }

  const bloqueado = ver != null && !ver.pode_raspar && cfg.respeitar_robots
  const mediaPausa = (cfg.pausa_min + cfg.pausa_max) / 2
  const estimativa =
    cfg.max_paginas * mediaPausa + Math.floor(cfg.max_paginas / Math.max(1, cfg.pausa_longa_cada)) * cfg.pausa_longa_seg
  const setCampo = (i: number, c: Partial<Campo>) =>
    set('campos', cfg.campos.map((x, j) => (j === i ? { ...x, ...c } : x)))

  return (
    <>
      <header className="topo">
        <div>
          <h1>Nova raspagem</h1>
          <p className="sub">Verifique o site, diga o que extrair e escolha o ritmo.</p>
        </div>
        <select
          className="modelo"
          value=""
          onChange={(e) => {
            const m = MODELOS[+e.target.value]
            if (m) { setCfg({ ...PADRAO, ...m.cfg }); setVer(null); setExtTexto(PADRAO.extensoes.join(', ')) }
          }}
        >
          <option value="">Carregar modelo…</option>
          {MODELOS.map((m, i) => <option key={m.nome} value={i}>{m.nome}</option>)}
        </select>
      </header>

      <SitesUsados aoEscolher={(c) => { setCfg({ ...PADRAO, ...c, modo: 'completo' }); setVer(null); setExtTexto((c.extensoes ?? PADRAO.extensoes).join(', ')); scrollTo({ top: 0, behavior: 'smooth' }) }} />

      <section className="cartao passo">
        <h2><span className="num">1</span> Verificar o site</h2>
        <div className="linha-url">
          <input placeholder="https://dados.exemplo.gov.br/lista" value={cfg.url} onChange={(e) => set('url', e.target.value)} />
          <button className="botao primario" disabled={!cfg.url || carregando} onClick={verificar}>
            {carregando ? 'Verificando…' : 'Verificar site'}
          </button>
        </div>
        {erro && <div className="erro">{erro}</div>}
        {ver && (
          <div className="verificacao">
            <div className={`veredito ${ver.pode_raspar ? 'ok' : 'nao'}`}>
              {ver.pode_raspar
                ? `Pode raspar “${ver.titulo ?? ver.url}” respeitando as regras abaixo.`
                : 'O robots.txt deste site não permite raspar esta URL. A raspagem será bloqueada.'}
            </div>
            <ul className="checks">
              {ver.checks.map((c) => (
                <li key={c.item}>
                  <span className={`ponto ${c.ok ? 'ok' : 'atencao'}`} />
                  <strong>{c.item}</strong>
                  <span>{c.detalhe}</span>
                </li>
              ))}
            </ul>
            {ver.robots_txt && (
              <details>
                <summary>Ver robots.txt</summary>
                <pre>{ver.robots_txt}</pre>
              </details>
            )}
          </div>
        )}
      </section>

      <div className="duas-colunas">
        <section className="cartao passo">
          <h2><span className="num">2</span> O que extrair</h2>
          <label>Seletor CSS de cada item
            <input value={cfg.seletor_item} onChange={(e) => set('seletor_item', e.target.value)} />
          </label>
          {ver && ver.sugestoes.length > 0 && (
            <div className="chips">
              <small>Sugestões encontradas na página:</small>
              {ver.sugestoes.map((s) => (
                <button key={s.seletor} className="chip" onClick={() => set('seletor_item', s.seletor)}>
                  {s.seletor} <em>×{s.ocorrencias}</em>
                </button>
              ))}
            </div>
          )}
          <div className="campos">
            <div className="campos-cab"><span>Campo</span><span>Seletor dentro do item</span><span>Atributo</span><span /></div>
            {cfg.campos.map((c, i) => (
              <div className="campo" key={i}>
                <input value={c.nome} onChange={(e) => setCampo(i, { nome: e.target.value })} />
                <input value={c.seletor} onChange={(e) => setCampo(i, { seletor: e.target.value })} />
                <input placeholder="texto" value={c.atributo ?? ''} onChange={(e) => setCampo(i, { atributo: e.target.value || null })} />
                <button className="x" onClick={() => set('campos', cfg.campos.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button className="botao leve" onClick={() => set('campos', [...cfg.campos, { nome: `campo${cfg.campos.length + 1}`, seletor: '' }])}>
              + Adicionar campo
            </button>
          </div>
          <label>Seletor do link “próxima página” (opcional)
            <input placeholder="a.proxima, li.next a…" value={cfg.seletor_proxima ?? ''} onChange={(e) => set('seletor_proxima', e.target.value)} />
          </label>
          <label>Máximo de páginas
            <input type="number" min={1} value={cfg.max_paginas} onChange={(e) => set('max_paginas', +e.target.value)} />
          </label>
        </section>

        <section className="cartao passo">
          <h2><span className="num">3</span> Ritmo humano</h2>
          <div className="faixa">
            <label>Pausa mínima <b>{cfg.pausa_min.toFixed(1)} s</b>
              <input type="range" min={0.5} max={10} step={0.1} value={cfg.pausa_min}
                onChange={(e) => set('pausa_min', Math.min(+e.target.value, cfg.pausa_max))} />
            </label>
            <label>Pausa máxima <b>{cfg.pausa_max.toFixed(1)} s</b>
              <input type="range" min={0.5} max={15} step={0.1} value={cfg.pausa_max}
                onChange={(e) => set('pausa_max', Math.max(+e.target.value, cfg.pausa_min))} />
            </label>
          </div>
          <JitterPreview min={cfg.pausa_min} max={cfg.pausa_max} crawl={ver?.crawl_delay ?? null} />
          <div className="grade2">
            <label>Pausa longa a cada
              <div className="sufixo"><input type="number" min={0} value={cfg.pausa_longa_cada} onChange={(e) => set('pausa_longa_cada', +e.target.value)} /><span>páginas</span></div>
            </label>
            <label>Duração da pausa longa
              <div className="sufixo"><input type="number" min={0} value={cfg.pausa_longa_seg} onChange={(e) => set('pausa_longa_seg', +e.target.value)} /><span>s</span></div>
            </label>
            <label>Tentativas em 429/503
              <input type="number" min={1} max={8} value={cfg.max_tentativas} onChange={(e) => set('max_tentativas', +e.target.value)} />
            </label>
          </div>
          <label className="toggle"><input type="checkbox" checked={cfg.respeitar_robots} onChange={(e) => set('respeitar_robots', e.target.checked)} /> Respeitar robots.txt e Crawl-delay</label>
          <label className="toggle"><input type="checkbox" checked={cfg.auto_throttle} onChange={(e) => set('auto_throttle', e.target.checked)} /> Desacelerar sozinho se o site ficar lento</label>
          <label className="toggle"><input type="checkbox" checked={usarJanela} onChange={(e) => {
            setUsarJanela(e.target.checked)
            if (e.target.checked && cfg.hora_inicio == null) setCfg((c) => ({ ...c, hora_inicio: 0, hora_fim: 6 }))
          }} /> Rodar só em horário de pouco tráfego</label>
          {usarJanela && (
            <div className="grade2">
              <label>Das<div className="sufixo"><input type="number" min={0} max={23} value={cfg.hora_inicio ?? 0} onChange={(e) => set('hora_inicio', +e.target.value)} /><span>h</span></div></label>
              <label>Até<div className="sufixo"><input type="number" min={0} max={23} value={cfg.hora_fim ?? 6} onChange={(e) => set('hora_fim', +e.target.value)} /><span>h</span></div></label>
            </div>
          )}
          <label>User-Agent (identifique-se com um contato)
            <input value={cfg.user_agent} onChange={(e) => set('user_agent', e.target.value)} />
          </label>
        </section>
      </div>

      <section className="cartao passo">
        <h2><span className="num">4</span> O que salvar</h2>
        <div className="alternancia" role="group" aria-label="O que salvar">
          <button aria-pressed={cfg.salvar_json} className={cfg.salvar_json ? 'on' : ''} onClick={() => set('salvar_json', !cfg.salvar_json)}>
            <b>{'{ }'} JSON</b><small>dados.json</small>
          </button>
          <button aria-pressed={cfg.salvar_csv} className={cfg.salvar_csv ? 'on' : ''} onClick={() => set('salvar_csv', !cfg.salvar_csv)}>
            <b>▦ CSV</b><small>dados.csv + relatórios</small>
          </button>
          <button aria-pressed={cfg.baixar_arquivos} className={cfg.baixar_arquivos ? 'on' : ''} onClick={() => set('baixar_arquivos', !cfg.baixar_arquivos)}>
            <b>📁 Arquivos</b><small>PDF, XLSX, ZIP… em pastas</small>
          </button>
        </div>
        <label>Pasta de destino (tudo o que estiver ativo é salvo aqui ao terminar)
          <input className="mono" placeholder={pastaSugerida || 'backend\\downloads\\<site>_<data>'} value={cfg.pasta_destino ?? ''}
            onChange={(e) => set('pasta_destino', e.target.value)} />
        </label>
        {cfg.baixar_arquivos && (
          <>
            <div className="grade2">
              <label>Link do item para abrir (dentro do item)
                <input placeholder="h3 a  (vazio = procurar arquivos na própria lista)" value={cfg.seletor_link_item ?? ''} onChange={(e) => set('seletor_link_item', e.target.value)} />
              </label>
              <label>Links de subpastas (opcional)
                <input placeholder="a.modulo, .pasta a…" value={cfg.seletor_subpasta ?? ''} onChange={(e) => set('seletor_subpasta', e.target.value)} />
              </label>
              <label>Tipos de arquivo
                <input value={extTexto} onChange={(e) => setExtTexto(e.target.value)} />
              </label>
              <label>Tamanho máximo por arquivo
                <div className="sufixo"><input type="number" min={1} value={cfg.max_tamanho_mb} onChange={(e) => set('max_tamanho_mb', +e.target.value)} /><span>MB</span></div>
              </label>
              <label>Máximo de arquivos
                <input type="number" min={1} value={cfg.max_arquivos} onChange={(e) => set('max_arquivos', +e.target.value)} />
              </label>
            </div>
            <small className="dica">Os arquivos ficam em <span className="mono">pasta › Item › Subpasta › arquivo</span>. Deixe a pasta vazia para usar a sugerida. Dica: comece pela <b>prévia</b>. Ela só navega e lista tudo, você desmarca o que não quer e depois baixa.</small>
          </>
        )}
      </section>

      <section className="cartao rodape-acao">
        <div>
          <strong>Estimativa:</strong> {cfg.max_paginas} páginas em cerca de {formatarTempo(estimativa)}
          {cfg.baixar_arquivos && ' (mais o tempo de abrir cada item e baixar os arquivos)'},
          média de {mediaPausa.toFixed(1)} s entre requisições, uma por vez.
        </div>
        <div className="acoes">
          {cfg.baixar_arquivos && (
            <button className="botao primario grande" disabled={!cfg.url || bloqueado} onClick={() => iniciar('descoberta')}>
              Descobrir arquivos (prévia)
            </button>
          )}
          <button className={`botao grande ${cfg.baixar_arquivos ? '' : 'primario'}`} disabled={!cfg.url || bloqueado} onClick={() => iniciar('completo')}>
            {cfg.baixar_arquivos ? 'Raspar e baixar direto' : 'Iniciar raspagem'}
          </button>
        </div>
      </section>
    </>
  )
}

function formatarTempo(s: number) {
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min ${Math.round(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/** Mostra 24 pausas sorteadas para o usuário "ver" o jitter antes de rodar. */
function JitterPreview({ min, max, crawl }: { min: number; max: number; crawl: number | null }) {
  const amostras = useMemo(
    () => Array.from({ length: 24 }, () => Math.max(min + Math.random() * (max - min), crawl ?? 0)),
    [min, max, crawl],
  )
  const topo = Math.max(max, crawl ?? 0) * 1.15
  return (
    <div className="jitter">
      <div className="jitter-barras">
        {amostras.map((a, i) => <span key={i} style={{ height: `${(a / topo) * 100}%` }} title={`${a.toFixed(2)} s`} />)}
        {crawl != null && <i className="linha-crawl" style={{ bottom: `${(crawl / topo) * 100}%` }}>Crawl-delay {crawl} s</i>}
      </div>
      <small>Prévia: cada barra é uma pausa sorteada entre {min.toFixed(1)} e {max.toFixed(1)} s. Nunca o mesmo intervalo duas vezes.</small>
    </div>
  )
}

/* ------------------------------------------------------------------ execução */
const TITULO_TIPO: Record<JobResumo['tipo'], string> = {
  raspagem: 'Raspagem',
  descoberta: 'Prévia (só descoberta)',
  download_do_plano: 'Download da prévia',
}

function progressoDe(job: JobResumo) {
  if (job.tipo === 'download_do_plano' && job.total_previsto != null) {
    const total = job.total_previsto
    return { feito: Math.min(job.processados, total), total, rotulo: 'arquivos' }
  }
  return { feito: job.paginas, total: job.max_paginas, rotulo: 'páginas' }
}

function Execucao({ id }: { id: string }) {
  const [job, setJob] = useState<JobDetalhe | null>(null)
  const [log, setLog] = useState<Evento[]>([])
  const [aba, setAba] = useState<string>('')

  useEffect(() => {
    let vivo = true
    setJob(null); setAba('')
    const f = () => api.detalhe(id).then((j) => { if (vivo) setJob(j) }).catch(() => {})
    api.detalhe(id).then((j) => { if (vivo) { setJob(j); setLog(j.eventos) } }).catch(() => {})
    const t = setInterval(f, 1500)
    const es = new EventSource(`/api/jobs/${id}/eventos`)
    es.onmessage = (m) => setLog((l) => [...l, JSON.parse(m.data)])
    return () => { vivo = false; clearInterval(t); es.close() }
  }, [id])

  if (!job) return <div className="vazio">Carregando…</div>
  const ativo = ['rodando', 'pausado', 'aguardando_horario', 'na_fila'].includes(job.status)
  const colunas = job.amostra[0] ? Object.keys(job.amostra[0]) : []
  const abas: [string, string][] = []
  if (job.tipo === 'descoberta' && job.downloads_do_plano.length) abas.push(['historico', 'Histórico: feito × pendente'])
  if (job.tipo === 'descoberta') abas.push(['previa', `Prévia: o que vai ser baixado (${job.arquivos.filter((a) => a.status === 'encontrado').length})`])
  if (job.comparativo) abas.push(['comparativo', 'Previsto × feito'])
  if (job.tipo !== 'descoberta' && job.arquivos.length) abas.push(['arquivos', `Relatório de arquivos (${job.arquivos.length})`])
  abas.push(['log', 'Log ao vivo'])
  if (job.tipo !== 'download_do_plano') abas.push(['dados', `Dados (${job.itens})`])
  const abaAtual = abas.some(([k]) => k === aba) ? aba : abas[0][0]
  const prog = progressoDe(job)
  const pct = job.status === 'concluido' ? 100 : prog.total ? Math.round((prog.feito / prog.total) * 100) : 0

  return (
    <>
      <header className="topo">
        <div>
          <a className="voltar" href="#/">← Visão geral</a>
          <h1>{new URL(job.url).host} <Selo s={job.status} /> <span className="tipo">{TITULO_TIPO[job.tipo]}</span></h1>
          <p className="sub mono">{job.url}</p>
          {job.plano_de && <p className="sub">Baixando a partir da <a href={`#/job/${job.plano_de}`}>prévia {job.plano_de}</a></p>}
        </div>
        <div className="acoes">
          {job.status === 'pausado'
            ? <button className="botao" onClick={() => api.controlar(id, 'retomar')}>▶ Retomar</button>
            : <button className="botao" disabled={!ativo} onClick={() => api.controlar(id, 'pausar')}>❚❚ Pausar</button>}
          <button className="botao perigo" disabled={!ativo} onClick={() => api.controlar(id, 'parar')}>■ Parar</button>
          {job.plano_de && !ativo && (job.comparativo ?? []).some((l) => ['pendente', 'erro'].includes(l.resultado)) && (
            <BotaoContinuar planoId={job.plano_de} />
          )}
          {job.tipo !== 'download_do_plano' && <a className="botao" href={api.exportarUrl(id, 'csv')}>Dados CSV</a>}
          {job.arquivos.length > 0 && (
            <a className="botao" href={api.exportarUrl(id, 'arquivos')}>{job.tipo === 'descoberta' ? 'Prévia CSV' : 'Relatório CSV'}</a>
          )}
          {job.comparativo && <a className="botao" href={api.exportarUrl(id, 'comparativo')}>Comparativo CSV</a>}
        </div>
      </header>

      <section className="cartao progresso">
        <div className="progresso-topo">
          <strong>{pct}%</strong>
          <span>
            {prog.feito} de {prog.total} {prog.total === 1 ? prog.rotulo.replace(/s$/, '') : prog.rotulo}
            {job.tipo === 'descoberta' && ativo && ` · ${job.arquivos.length} arquivos encontrados até agora`}
          </span>
        </div>
        <div className={`regua ${ativo ? 'animada' : ''} ${job.status === 'erro' || job.status === 'parado' ? 'parou' : ''}`}>
          <span style={{ width: `${pct}%` }} />
        </div>
        {job.pasta && <p className="sub mono">Salvando em: {job.pasta}</p>}
      </section>

      <section className="kpis">
        {job.tipo === 'descoberta' ? (
          <>
            <Kpi rotulo="Páginas visitadas" valor={job.requisicoes} />
            <Kpi rotulo="Itens" valor={job.itens} />
            <Kpi rotulo="Arquivos encontrados" valor={job.arquivos.filter((a) => a.status === 'encontrado').length} />
            <Kpi rotulo="Não vão ser baixados" valor={job.arquivos.filter((a) => a.status !== 'encontrado').length} dica="robots.txt, sem link…" />
            <Kpi rotulo="Pausa média" valor={job.pausa_media != null ? `${job.pausa_media} s` : '—'} dica={`alvo ${job.config.pausa_min}–${job.config.pausa_max} s`} />
          </>
        ) : job.baixar_arquivos || job.plano_de ? (
          <>
            <Kpi rotulo="Baixados" valor={job.arquivos_baixados} dica={formatarBytes(job.bytes_baixados)} />
            <Kpi rotulo="Ignorados" valor={job.arquivos_ignorados} dica="robots.txt, tamanho, limite" />
            <Kpi rotulo="Com erro" valor={job.arquivos_erro} alerta={job.arquivos_erro > 0} />
            <Kpi rotulo="Requisições" valor={job.requisicoes} />
            <Kpi rotulo="Pausa média" valor={job.pausa_media != null ? `${job.pausa_media} s` : '—'} dica={`alvo ${job.config.pausa_min}–${job.config.pausa_max} s`} />
          </>
        ) : (
          <>
            <Kpi rotulo="Páginas" valor={`${job.paginas} / ${job.max_paginas}`} />
            <Kpi rotulo="Itens extraídos" valor={job.itens} />
            <Kpi rotulo="Requisições" valor={job.requisicoes} />
            <Kpi rotulo="Pausa média" valor={job.pausa_media != null ? `${job.pausa_media} s` : '—'} dica={`alvo ${job.config.pausa_min}–${job.config.pausa_max} s`} />
            <Kpi rotulo="Latência do site" valor={job.latencia_media != null ? `${job.latencia_media} ms` : '—'} dica="média" />
          </>
        )}
      </section>

      <section className="cartao">
        <div className="abas">
          {abas.map(([k, t]) => (
            <button key={k} className={abaAtual === k ? 'ativo' : ''} onClick={() => setAba(k)}>{t}</button>
          ))}
        </div>
        {abaAtual === 'historico' && <Historico planoId={job.id} />}
        {abaAtual === 'previa' && <Previa job={job} />}
        {abaAtual === 'arquivos' && <ArvoreArquivos arquivos={job.arquivos} jobId={job.id} />}
        {abaAtual === 'comparativo' && job.comparativo && (
          <Comparativo linhas={job.comparativo} inconsistencias={job.inconsistencias} jobId={job.id} terminou={!ativo} />
        )}
        {abaAtual === 'log' && (
          <div className="log">
            {[...log].reverse().slice(0, 300).map((e, i) => (
              <div key={i} className={`ev ev-${e.tipo}`}><span>{e.t}</span><b>{e.tipo}</b>{e.msg}</div>
            ))}
          </div>
        )}
        {abaAtual === 'dados' && (
          <div className="rolagem">
            <table className="tabela compacta">
              <thead><tr><th>#</th>{colunas.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {job.amostra.map((l, i) => (
                  <tr key={i}><td>{i + 1}</td>{colunas.map((c) => <td key={c}>{String(l[c] ?? '')}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="duas-colunas larga">
        <section className="cartao">
          <h2>Ritmo das requisições</h2>
          <GraficoPausas pausas={job.pausas} min={job.config.pausa_min} max={job.config.pausa_max} crawl={job.crawl_delay} />
          <div className="legenda">
            <span><i className="cor-pausa" /> pausa normal</span>
            <span><i className="cor-longa" /> pausa longa / backoff</span>
            <span><i className="cor-faixa" /> faixa configurada</span>
          </div>
        </section>
        <section className="cartao">
          <h2>Respostas do site</h2>
          <div className="status-http">
            {Object.entries(job.status_http).map(([k, v]) => (
              <div key={k} className={`st st-${k[0]}`}><strong>{k}</strong><span>{v}×</span></div>
            ))}
            {Object.keys(job.status_http).length === 0 && <small>Aguardando a primeira resposta…</small>}
          </div>
          <h3>Regras ativas</h3>
          <ul className="regras">
            <li>robots.txt {job.config.respeitar_robots ? 'respeitado' : 'ignorado'}{job.crawl_delay ? `, Crawl-delay ${job.crawl_delay} s` : ''}</li>
            <li>Pausa sorteada entre {job.config.pausa_min} e {job.config.pausa_max} s</li>
            <li>{job.config.pausa_longa_cada ? `Pausa longa de ~${job.config.pausa_longa_seg} s a cada ${job.config.pausa_longa_cada} requisições` : 'Pausa longa desligada'}</li>
            <li>Backoff exponencial em 429/503 (até {job.config.max_tentativas} tentativas)</li>
            {(job.baixar_arquivos || job.tipo !== 'raspagem') && <li>Arquivos de até {job.config.max_tamanho_mb} MB, no máximo {job.config.max_arquivos}</li>}
          </ul>
        </section>
      </div>
    </>
  )
}

function formatarBytes(b: number) {
  if (!b) return '0 KB'
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

/** Soma tamanhos conhecidos e conta os desconhecidos. */
function somaTamanhos(ls: { tamanho_previsto: number | null }[]) {
  const conhecidos = ls.filter((a) => a.tamanho_previsto != null)
  return { bytes: conhecidos.reduce((t, a) => t + (a.tamanho_previsto ?? 0), 0), conhecidos: conhecidos.length, desconhecidos: ls.length - conhecidos.length }
}

function TextoTamanho({ ls }: { ls: { tamanho_previsto: number | null }[] }) {
  const t = somaTamanhos(ls)
  return <small className="tam">{t.conhecidos ? `≈ ${formatarBytes(t.bytes)}` : ''}{t.desconhecidos ? `${t.conhecidos ? ' + ' : ''}${t.desconhecidos} desconhecido${t.desconhecidos > 1 ? 's' : ''}` : ''}</small>
}

type No<T> = { titulo: string; item: number; raiz: T[]; subpastas: [string, T[]][] }

/** Agrupa linhas em Item › Subpasta › arquivos, na ordem em que apareceram. */
function agrupar<T extends { item: number; item_titulo: string; subpasta: string }>(linhas: T[]): No<T>[] {
  const mapa = new Map<number, { titulo: string; raiz: T[]; subs: Map<string, T[]> }>()
  for (const l of linhas) {
    if (!mapa.has(l.item)) mapa.set(l.item, { titulo: l.item_titulo, raiz: [], subs: new Map() })
    const n = mapa.get(l.item)!
    if (l.subpasta) {
      if (!n.subs.has(l.subpasta)) n.subs.set(l.subpasta, [])
      n.subs.get(l.subpasta)!.push(l)
    } else n.raiz.push(l)
  }
  return [...mapa.entries()].map(([item, n]) => ({ item, titulo: n.titulo, raiz: n.raiz, subpastas: [...n.subs.entries()] }))
}

function CaixaTri({ estado, onChange }: { estado: 'todos' | 'nenhum' | 'alguns'; onChange: (v: boolean) => void }) {
  return (
    <input type="checkbox" checked={estado === 'todos'}
      ref={(el) => { if (el) el.indeterminate = estado === 'alguns' }}
      onChange={(e) => onChange(e.target.checked)} onClick={(e) => e.stopPropagation()} />
  )
}

/** Prévia: árvore com caixinhas (todas marcadas por padrão). */
function Previa({ job }: { job: JobDetalhe }) {
  const baixaveis = useMemo(() => job.arquivos.filter((a) => a.status === 'encontrado').map((a) => a.url), [job.arquivos])
  const [marcados, setMarcados] = useState<Set<string>>(new Set())
  const [vistos, setVistos] = useState<Set<string>>(new Set())
  const [pasta, setPasta] = useState(job.config.pasta_destino ?? '')
  const [erro, setErro] = useState('')
  // arquivos novos chegam marcados; o que você desmarcou continua desmarcado
  useEffect(() => {
    const novos = baixaveis.filter((u) => !vistos.has(u))
    if (!novos.length) return
    setMarcados((m) => new Set([...m, ...novos]))
    setVistos((v) => new Set([...v, ...novos]))
  }, [baixaveis, vistos])
  const arvore = useMemo(() => agrupar(job.arquivos), [job.arquivos])
  const ativo = ['rodando', 'pausado', 'aguardando_horario', 'na_fila'].includes(job.status)
  const [tudo, setTudo] = useState<'fechado' | 'aberto'>('fechado')

  const estadoDe = (urls: string[]) => {
    const b = urls.filter((u) => baixaveis.includes(u))
    const n = b.filter((u) => marcados.has(u)).length
    return n === 0 ? 'nenhum' : n === b.length ? 'todos' : 'alguns'
  }
  const alternar = (urls: string[], v: boolean) =>
    setMarcados((m) => {
      const s = new Set(m)
      urls.filter((u) => baixaveis.includes(u)).forEach((u) => (v ? s.add(u) : s.delete(u)))
      return s
    })
  const urlsDo = (n: No<Arquivo>) => [...n.raiz, ...n.subpastas.flatMap(([, l]) => l)].map((a) => a.url)
  const total = baixaveis.filter((u) => marcados.has(u)).length
  const encontrados = job.arquivos.filter((a) => a.status === 'encontrado')
  const tamMarcados = somaTamanhos(encontrados.filter((a) => marcados.has(a.url)))
  const tamTodos = somaTamanhos(encontrados)
  const marcadosDe = (ls: Arquivo[]) => ls.filter((a) => a.status === 'encontrado' && marcados.has(a.url))

  async function baixar() {
    setErro('')
    try {
      const { id } = await api.baixarPlano(job.id, baixaveis.filter((u) => marcados.has(u)), pasta || null)
      location.hash = `#/job/${id}`
    } catch (e) { setErro((e as Error).message) }
  }

  return (
    <div>
      <div className="barra-previa">
        <label className="toggle"><CaixaTri estado={estadoDe(baixaveis)} onChange={(v) => alternar(baixaveis, v)} /> Marcar todos</label>
        <span><b>{total}</b> de {baixaveis.length} arquivos marcados</span>
        <input className="mono" placeholder="Pasta de destino (vazio = pasta sugerida)" value={pasta} onChange={(e) => setPasta(e.target.value)} />
        <button className="botao primario" disabled={ativo || total === 0} onClick={baixar}>
          {ativo ? 'Aguarde a prévia terminar…' : `Baixar ${total} arquivos marcados`}
        </button>
      </div>
      {erro && <div className="erro">{erro}</div>}
      <div className="total-tamanho">
        <div>
          <span>Tamanho estimado do que está marcado</span>
          <strong>≈ {formatarBytes(tamMarcados.bytes)}</strong>
          <small>de ≈ {formatarBytes(tamTodos.bytes)} encontrados no total · é uma estimativa: soma só os tamanhos que o site informou</small>
        </div>
        <div className="conhecidos">
          <span><b>{tamMarcados.conhecidos}</b> com tamanho conhecido</span>
          <span className={tamMarcados.desconhecidos ? 'desc' : ''}><b>{tamMarcados.desconhecidos}</b> desconhecido{tamMarcados.desconhecidos === 1 ? '' : 's'}</span>
          {!job.config.consultar_tamanho && <small>A consulta de tamanho estava desligada nesta prévia.</small>}
        </div>
      </div>
      {job.downloads_do_plano.length > 0 && (
        <p className="sub">Downloads já feitos desta prévia: {job.downloads_do_plano.map((d) => <a key={d} href={`#/job/${d}`}>{d} </a>)}</p>
      )}
      <ControleArvore tudo={tudo} setTudo={setTudo} pastas={arvore.length} />
      <div className="arvore">
        {arvore.map((n) => (
          <details key={`${n.item}-${tudo}`} open={tudo === 'aberto'}>
            <summary>
              <CaixaTri estado={estadoDe(urlsDo(n))} onChange={(v) => alternar(urlsDo(n), v)} />
              <span className="pasta-icone">📁</span> <b>{n.titulo}</b>
              <small>{urlsDo(n).filter((u) => baixaveis.includes(u)).length} arquivos</small>
              <TextoTamanho ls={marcadosDe([...n.raiz, ...n.subpastas.flatMap(([, l]) => l)])} />
            </summary>
            <LinhasPrevia linhas={n.raiz} marcados={marcados} alternar={alternar} />
            {n.subpastas.map(([sub, linhas]) => (
              <details key={`${sub}-${tudo}`} open={tudo === 'aberto'} className="sub-no">
                <summary>
                  <CaixaTri estado={estadoDe(linhas.map((a) => a.url))} onChange={(v) => alternar(linhas.map((a) => a.url), v)} />
                  <span className="pasta-icone">📂</span> {sub} <small>{linhas.filter((a) => a.status === 'encontrado').length} arquivos</small>
                  <TextoTamanho ls={marcadosDe(linhas)} />
                </summary>
                <LinhasPrevia linhas={linhas} marcados={marcados} alternar={alternar} />
              </details>
            ))}
          </details>
        ))}
        {arvore.length === 0 && <div className="vazio">{ativo ? 'Procurando arquivos…' : 'Nenhum arquivo encontrado.'}</div>}
      </div>
    </div>
  )
}

function LinhasPrevia({ linhas, marcados, alternar }: { linhas: Arquivo[]; marcados: Set<string>; alternar: (u: string[], v: boolean) => void }) {
  return (
    <ul className="folhas">
      {linhas.map((a, i) => (
        <li key={a.url + i} className={a.status === 'encontrado' ? '' : 'fora'}>
          {a.status === 'encontrado'
            ? <input type="checkbox" checked={marcados.has(a.url)} onChange={(e) => alternar([a.url], e.target.checked)} />
            : <span className="sem-caixa">—</span>}
          <span className="arq-nome">{a.nome}</span>
          <small className="mono">{a.url.split('/').pop()}</small>
          <small className={`tam-arq ${a.tamanho_previsto == null ? 'desc' : ''}`}>{a.tamanho_previsto == null ? 'desconhecido' : formatarBytes(a.tamanho_previsto)}</small>
          {a.status !== 'encontrado' && <span className="selo selo-aviso">não vai baixar: {a.motivo}</span>}
        </li>
      ))}
    </ul>
  )
}

const ROTULO_RESULTADO: Record<string, string> = {
  baixado: 'Baixado', ignorado: 'Ignorado', erro: 'Erro', desmarcado: 'Desmarcado', pendente: 'Pendente', encontrado: 'Encontrado',
}

/** Relatório final: Item › Subpasta › arquivo com status e motivo. */
function ArvoreArquivos({ arquivos, jobId }: { arquivos: Arquivo[]; jobId: string }) {
  const arvore = useMemo(() => agrupar(arquivos.map((a, n) => ({ ...a, n }))), [arquivos])
  const [tudo, setTudo] = useState<'fechado' | 'aberto'>('fechado')
  const linhas = (ls: (Arquivo & { n: number })[]) => (
    <ul className="folhas">
      {ls.map((a) => (
        <li key={a.n}>
          <span className={`selo selo-r-${a.status}`}>{ROTULO_RESULTADO[a.status]}</span>
          {a.status === 'baixado' ? <a className="arq-nome" href={api.arquivoUrl(jobId, a.n)} target="_blank">{a.nome}</a> : <span className="arq-nome">{a.nome}</span>}
          <small>{a.motivo}</small>
          {a.caminho && <small className="mono caminho">{a.caminho}</small>}
        </li>
      ))}
    </ul>
  )
  return (
    <>
      <ControleArvore tudo={tudo} setTudo={setTudo} pastas={arvore.length} />
      <div className="arvore">
        {arvore.map((n) => (
          <details key={`${n.item}-${tudo}`} open={tudo === 'aberto'}>
            <summary><span className="pasta-icone">📁</span> <b>{n.titulo}</b> <Contagem ls={[...n.raiz, ...n.subpastas.flatMap(([, l]) => l)].map((a) => a.status)} /></summary>
            {linhas(n.raiz)}
            {n.subpastas.map(([sub, ls]) => (
              <details key={`${sub}-${tudo}`} open={tudo === 'aberto'} className="sub-no">
                <summary><span className="pasta-icone">📂</span> {sub} <Contagem ls={ls.map((a) => a.status)} /></summary>
                {linhas(ls)}
              </details>
            ))}
          </details>
        ))}
      </div>
    </>
  )
}

/** Previsto × feito: totais e uma linha por arquivo da prévia. */
function Comparativo({ linhas, inconsistencias, jobId, terminou }: { linhas: LinhaComparativo[]; inconsistencias: Inconsistencia[]; jobId: string; terminou: boolean }) {
  const [filtro, setFiltro] = useState('todos')
  const [tudo, setTudo] = useState<'fechado' | 'aberto'>('fechado')
  const cont = linhas.reduce<Record<string, number>>((a, l) => ({ ...a, [l.resultado]: (a[l.resultado] ?? 0) + 1 }), {})
  const previstos = linhas.filter((l) => l.previsto === 'sim').length
  const visiveis = filtro === 'todos' ? linhas : filtro === 'faltando' ? linhas.filter((l) => l.resultado !== 'baixado') : linhas.filter((l) => l.resultado === filtro)
  const arvore = agrupar(visiveis)
  const doDownload = linhas.filter((l) => l.previsto === 'sim' && l.resultado !== 'desmarcado')
  const prev = somaTamanhos(doDownload)
  const feito = linhas.reduce((t, l) => t + (l.resultado === 'baixado' ? l.tamanho : 0), 0)
  const prevConhecidoBaixado = doDownload.filter((l) => l.resultado === 'baixado' && l.tamanho_previsto != null)
  const motivos = Object.entries(doDownload.reduce<Record<string, number>>((a, l) =>
    l.motivo_diferenca && l.motivo_diferenca !== 'igual ao previsto' ? { ...a, [l.motivo_diferenca]: (a[l.motivo_diferenca] ?? 0) + 1 } : a, {}))
  return (
    <div>
      <div className="total-tamanho comp">
        <div><span>Previsto na prévia (marcados)</span><strong>≈ {formatarBytes(prev.bytes)}</strong>
          <small>{prev.conhecidos} com tamanho conhecido · {prev.desconhecidos} desconhecido{prev.desconhecidos === 1 ? '' : 's'}</small></div>
        <div><span>Baixado de fato</span><strong>{formatarBytes(feito)}</strong>
          <small>diferença: {feito - prev.bytes >= 0 ? '+' : '−'}{formatarBytes(Math.abs(feito - prev.bytes))}
            {prevConhecidoBaixado.length < doDownload.length ? ' (inclui arquivos de tamanho desconhecido ou não baixados)' : ''}</small></div>
        <div className="porques">
          <span>Por que pode ser diferente</span>
          {motivos.length === 0 ? <small>✓ Tudo igual ao previsto.</small> : (
            <ul>{motivos.map(([m, n]) => <li key={m}><b>{n}×</b> {m}</li>)}</ul>
          )}
        </div>
      </div>
      <div className="resumo-comp">
        <div><strong>{previstos}</strong><span>previstos na prévia</span></div>
        {['baixado', 'desmarcado', 'ignorado', 'erro', 'pendente'].filter((k) => cont[k]).map((k) => (
          <button key={k} className={`resumo-chip selo-r-${k} ${filtro === k ? 'sel' : ''}`} onClick={() => setFiltro(filtro === k ? 'todos' : k)}>
            <strong>{cont[k]}</strong><span>{ROTULO_RESULTADO[k].toLowerCase()}</span>
          </button>
        ))}
        <button className={`resumo-chip ${filtro === 'faltando' ? 'sel' : ''}`} onClick={() => setFiltro(filtro === 'faltando' ? 'todos' : 'faltando')}>
          <strong>{linhas.filter((l) => l.resultado !== 'baixado').length}</strong><span>tudo que faltou</span>
        </button>
      </div>
      <ControleArvore tudo={tudo} setTudo={setTudo} pastas={arvore.length} />
      <div className="arvore">
        {arvore.map((n) => (
          <details key={`${n.item}-${tudo}`} open={tudo === 'aberto'}>
            <summary><span className="pasta-icone">📁</span> <b>{n.titulo}</b> <Contagem ls={[...n.raiz, ...n.subpastas.flatMap(([, l]) => l)].map((l) => l.resultado)} /></summary>
            <TabelaComp linhas={n.raiz} />
            {n.subpastas.map(([sub, ls]) => (
              <details key={`${sub}-${tudo}`} open={tudo === 'aberto'} className="sub-no">
                <summary><span className="pasta-icone">📂</span> {sub} <Contagem ls={ls.map((l) => l.resultado)} /></summary>
                <TabelaComp linhas={ls} />
              </details>
            ))}
          </details>
        ))}
      </div>

      <div className="inconsistencias">
        <div className="inc-topo">
          <h3>Inconsistências</h3>
          {inconsistencias.length > 0 && <a className="botao" href={api.exportarUrl(jobId, 'inconsistencias')}>Exportar CSV</a>}
        </div>
        {!terminou ? (
          <p className="sub">A conferência é feita quando o download terminar.</p>
        ) : inconsistencias.length === 0 ? (
          <p className="tudo-ok">✓ Tudo confere: cada arquivo marcado na prévia foi baixado e está na pasta, sem arquivos a mais.</p>
        ) : (
          <ul className="inc-lista">
            {inconsistencias.map((i, k) => (
              <li key={k}>
                <span className={`selo inc-${i.tipo.replace(' ', '-')}`}>{i.tipo === 'a menos' ? '− a menos' : i.tipo === 'a mais' ? '+ a mais' : '? sumiu'}</span>
                <div>
                  <b>{i.nome}</b> <small>{i.detalhe}</small>
                  <div className="mono caminho">📍 {i.onde}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function TabelaComp({ linhas }: { linhas: LinhaComparativo[] }) {
  if (!linhas.length) return null
  return (
    <ul className="folhas">
      {linhas.map((l, i) => (
        <li key={l.url + i}>
          <span className="prev">{l.previsto === 'sim' ? 'previsto' : 'fora da prévia'}</span>
          <span className={`selo selo-r-${l.resultado}`}>{ROTULO_RESULTADO[l.resultado]}</span>
          <span className="arq-nome">{l.nome}</span>
          <small>{l.motivo}</small>
          {l.previsto === 'sim' && (
            <small className={`tam-arq ${l.diferenca ? 'dif' : ''}`} title={l.motivo_diferenca}>
              {l.tamanho_previsto == null ? 'desconhecido' : formatarBytes(l.tamanho_previsto)} → {l.resultado === 'baixado' ? formatarBytes(l.tamanho) : '—'}
              {l.diferenca ? ` (${l.motivo_diferenca})` : ''}
            </small>
          )}
        </li>
      ))}
    </ul>
  )
}

function GraficoPausas({ pausas, min, max, crawl = null }: { pausas: number[]; min: number; max: number; crawl?: number | null }) {
  const normal = Math.max(max, (crawl ?? 0) + 0.5) * 1.1  // acima disso: pausa longa ou backoff
  const W = 560, H = 170, P = 28
  const topo = Math.max(max * 1.3, ...pausas, 1)
  const y = (v: number) => H - P - (v / topo) * (H - P * 2)
  const n = Math.max(pausas.length, 12)
  const bw = (W - P * 2) / n
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="grafico" role="img" aria-label="Pausas entre requisições">
      <rect x={P} y={y(max)} width={W - P * 2} height={y(min) - y(max)} className="faixa-alvo" />
      {[0, topo / 2, topo].map((v) => (
        <g key={v}>
          <line x1={P} x2={W - P} y1={y(v)} y2={y(v)} className="grade" />
          <text x={P - 6} y={y(v) + 4} textAnchor="end">{v < 10 ? v.toFixed(1) : v.toFixed(0)}s</text>
        </g>
      ))}
      {pausas.map((p, i) => (
        <rect key={i} x={P + i * bw + 2} y={y(p)} width={Math.max(2, bw - 4)} height={H - P - y(p)} rx={2}
          className={p > normal ? 'barra-longa' : 'barra-pausa'}><title>{p} s</title></rect>
      ))}
      <text x={W - P} y={H - 8} textAnchor="end">requisição →</text>
    </svg>
  )
}

/* ------------------------------------------------------------------ boas práticas */
function Praticas() {
  const itens = [
    ['Verificar antes de raspar', 'O painel lê o robots.txt, o Crawl-delay e o sitemap, e procura uma API oficial (por exemplo CKAN, usada em portais como dados.gov.br). Se existe API, use a API.'],
    ['Pausas com jitter', 'Cada pausa é sorteada entre o mínimo e o máximo (padrão 1 a 2 s), e nunca fica abaixo do Crawl-delay pedido pelo site. Intervalos regulares denunciam robô e sobrecarregam o servidor.'],
    ['Pausa longa', 'A cada N páginas, um descanso maior, como uma pessoa faria. Diminui a pressão contínua no site.'],
    ['Uma requisição por vez', 'Concorrência 1 por domínio. Mais rápido não vale um site fora do ar.'],
    ['Backoff em 429/503', 'Se o site pede calma, o robô espera o Retry-After ou 2, 4, 8 s (com jitter) e desiste depois de algumas tentativas.'],
    ['Auto-throttle', 'Se a latência sobe, as pausas crescem automaticamente: o site está sob carga.'],
    ['Identificação', 'User-Agent com nome do projeto e contato. Se algo der errado, o dono do site sabe com quem falar.'],
    ['Horário de pouco tráfego', 'Raspagens grandes podem rodar só de madrugada, quando o site tem menos visitas.'],
    ['Termos de uso e LGPD', 'Dados abertos ainda têm licença. Não colete dados pessoais sem base legal e não contorne login, CAPTCHA ou bloqueios.'],
  ]
  return (
    <>
      <header className="topo">
        <div>
          <h1>Boas práticas</h1>
          <p className="sub">O que o painel faz por padrão para raspar como uma pessoa educada.</p>
        </div>
      </header>
      <section className="praticas">
        {itens.map(([t, d]) => (
          <div className="cartao" key={t}><h3>{t}</h3><p>{d}</p></div>
        ))}
      </section>
    </>
  )
}

function ControleArvore({ tudo, setTudo, pastas }: { tudo: string; setTudo: (v: 'fechado' | 'aberto') => void; pastas: number }) {
  return (
    <div className="controle-arvore">
      <small>{pastas} pastas principais · clique para abrir</small>
      <button className="link" onClick={() => setTudo('aberto')} disabled={tudo === 'aberto'}>Expandir tudo</button>
      <button className="link" onClick={() => setTudo('fechado')} disabled={tudo === 'fechado'}>Recolher tudo</button>
    </div>
  )
}

/** Resumo de status ao lado de cada pasta: ✓ 4 · ⏭ 1 · ✕ 1 */
function Contagem({ ls }: { ls: string[] }) {
  const c = ls.reduce<Record<string, number>>((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {})
  const pedacos: [string, string, number][] = [
    ['baixado', '✓', c.baixado ?? 0], ['desmarcado', '☐', c.desmarcado ?? 0],
    ['ignorado', '⏭', c.ignorado ?? 0], ['erro', '✕', c.erro ?? 0], ['pendente', '…', c.pendente ?? 0],
  ]
  return (
    <span className="contagem">
      {pedacos.filter(([, , n]) => n).map(([k, ic, n]) => <span key={k} className={`c-${k}`} title={k}>{ic} {n}</span>)}
    </span>
  )
}

/* ------------------------------------------------------------------ histórico e retomada */
function BotaoContinuar({ planoId, rotulo = '↻ Continuar de onde parou', escopo, classe = 'botao primario' }:
  { planoId: string; rotulo?: string; escopo?: { item?: number; subpasta?: string }; classe?: string }) {
  const [erro, setErro] = useState('')
  return (
    <>
      <button className={classe} title={erro || 'Baixa só o que está pendente ou deu erro. O que já foi baixado é pulado.'}
        onClick={async (e) => {
          e.preventDefault(); e.stopPropagation()
          try { const { id } = await api.continuar(planoId, escopo); location.hash = `#/job/${id}` } catch (er) { setErro((er as Error).message); alert((er as Error).message) }
        }}>{rotulo}</button>
    </>
  )
}

const COR_SITUACAO: Record<LinhaHistorico['situacao'], string> = {
  feito: 'Feito', pendente: 'Pendente', erro: 'Erro', ignorado: 'Ignorado', desmarcado: 'Desmarcado',
}

/** Histórico acumulado de uma prévia: tudo que já foi baixado em todas as execuções, por pasta. */
function Historico({ planoId }: { planoId: string }) {
  const [h, setH] = useState<THistorico | null>(null)
  const [tudo, setTudo] = useState<'fechado' | 'aberto'>('fechado')
  useEffect(() => {
    let vivo = true
    const f = () => api.historico(planoId).then((x) => vivo && setH(x)).catch(() => {})
    f(); const t = setInterval(f, 2500)
    return () => { vivo = false; clearInterval(t) }
  }, [planoId])
  if (!h) return <div className="vazio">Carregando histórico…</div>
  const cont = h.linhas.reduce<Record<string, number>>((a, l) => ({ ...a, [l.situacao]: (a[l.situacao] ?? 0) + 1 }), {})
  const alvo = h.linhas.filter((l) => ['feito', 'pendente', 'erro'].includes(l.situacao)).length
  const pct = alvo ? Math.round(((cont.feito ?? 0) / alvo) * 100) : 0
  const faltam = (cont.pendente ?? 0) + (cont.erro ?? 0)
  const arvore = agrupar(h.linhas)
  // "continuar daqui" numa pasta inclui também o que estava desmarcado nela (você escolheu aquela pasta)
  const pend = (ls: LinhaHistorico[]) => ls.filter((l) => ['pendente', 'erro', 'desmarcado'].includes(l.situacao)).length

  return (
    <div>
      <div className="hist-topo">
        <div className="hist-pct">
          <strong>{pct}%</strong>
          <span>{cont.feito ?? 0} de {alvo} arquivos baixados</span>
          <div className="regua"><span style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="legenda-sit">
          {(['feito', 'pendente', 'erro', 'ignorado', 'desmarcado'] as const).map((k) => (
            <span key={k} className={`sit sit-${k}`}><i /> {COR_SITUACAO[k]} <b>{cont[k] ?? 0}</b></span>
          ))}
        </div>
        <div className="hist-acao">
          {h.rodando ? <span className="sub">Há um download em andamento desta prévia.</span>
            : faltam > 0 ? <BotaoContinuar planoId={planoId} rotulo={`↻ Continuar de onde parou (${faltam} faltando)`} classe="botao primario grande" />
              : <span className="tudo-ok">✓ Tudo o que foi marcado já está baixado.</span>}
        </div>
      </div>
      <p className="sub">
        {h.downloads.length} execuç{h.downloads.length === 1 ? 'ão' : 'ões'} de download:{' '}
        {h.downloads.map((d) => <a key={d.id} href={`#/job/${d.id}`}>{d.id} ({ROTULO[d.status] ?? d.status}) </a>)}
        {h.pasta && <> · pasta: <span className="mono">{h.pasta}</span></>}
      </p>
      <ControleArvore tudo={tudo} setTudo={setTudo} pastas={arvore.length} />
      <div className="arvore">
        {arvore.map((n) => {
          const todas = [...n.raiz, ...n.subpastas.flatMap(([, l]) => l)]
          return (
            <details key={`${n.item}-${tudo}`} open={tudo === 'aberto'}>
              <summary className={concluida(todas) ? 'no-feito' : ''}>
                <span className="pasta-icone">📁</span> <b>{n.titulo}</b> <BarrinhaSit ls={todas} />
                {pend(todas) > 0 && !h.rodando && <BotaoContinuar planoId={planoId} escopo={{ item: n.item }} rotulo={`▶ continuar daqui (${pend(todas)})`} classe="botao mini" />}
              </summary>
              <FolhasHist ls={n.raiz} />
              {n.subpastas.map(([sub, ls]) => (
                <details key={`${sub}-${tudo}`} open={tudo === 'aberto'} className="sub-no">
                  <summary className={concluida(ls) ? 'no-feito' : ''}>
                    <span className="pasta-icone">📂</span> {sub} <BarrinhaSit ls={ls} />
                    {pend(ls) > 0 && !h.rodando && <BotaoContinuar planoId={planoId} escopo={{ item: n.item, subpasta: sub }} rotulo={`▶ continuar daqui (${pend(ls)})`} classe="botao mini" />}
                  </summary>
                  <FolhasHist ls={ls} />
                </details>
              ))}
            </details>
          )
        })}
      </div>
    </div>
  )
}

const concluida = (ls: LinhaHistorico[]) =>
  ls.some((l) => l.situacao === 'feito') && !ls.some((l) => ['pendente', 'erro'].includes(l.situacao))

/** Barrinha empilhada com a proporção feito/pendente/erro de uma pasta. */
function BarrinhaSit({ ls }: { ls: LinhaHistorico[] }) {
  const ordem = ['feito', 'erro', 'pendente', 'ignorado', 'desmarcado'] as const
  const c = Object.fromEntries(ordem.map((k) => [k, ls.filter((l) => l.situacao === k).length]))
  const feitos = c.feito, alvo = c.feito + c.pendente + c.erro
  return (
    <span className="barrinha-wrap">
      <span className="barrinha">{ordem.map((k) => c[k] ? <i key={k} className={`b-${k}`} style={{ flex: c[k] }} title={`${COR_SITUACAO[k]}: ${c[k]}`} /> : null)}</span>
      <small>{feitos}/{alvo}</small>
    </span>
  )
}

function FolhasHist({ ls }: { ls: LinhaHistorico[] }) {
  if (!ls.length) return null
  return (
    <ul className="folhas">
      {ls.map((l, i) => (
        <li key={l.url + i} className={`linha-sit sit-${l.situacao}`}>
          <span className={`sit sit-${l.situacao}`}><i /> {COR_SITUACAO[l.situacao]}</span>
          <span className="arq-nome">{l.nome}</span>
          <small>{l.motivo}</small>
          {l.caminho && <small className="mono caminho">📍 {l.caminho}</small>}
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------ sites usados */
function SitesUsados({ aoEscolher }: { aoEscolher: (c: Config) => void }) {
  const [sites, setSites] = useState<Site[]>([])
  const carregar = () => api.sites().then(setSites).catch(() => {})
  useEffect(() => { carregar() }, [])
  if (!sites.length) return null
  return (
    <section className="cartao sites-usados">
      <h2>Sites usados recentemente</h2>
      <ul>
        {sites.slice(0, 8).map((s) => (
          <li key={s.url}>
            <button className="site-btn" onClick={() => aoEscolher(s.config)} title="Usar a mesma configuração">
              <b>{(() => { try { return new URL(s.url).host } catch { return s.url } })()}</b>
              <span className="mono">{s.url}</span>
              <small>{s.usos}× · último uso {s.ultimo_uso.replace('T', ' ').slice(0, 16)} · item <code>{s.config.seletor_item}</code>
                {s.config.baixar_arquivos ? ' · com arquivos' : ''}</small>
            </button>
            <button className="x" title="Esquecer este site" onClick={() => api.esquecerSite(s.url).then(carregar)}>×</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------------ banco e backup */
function BancoBackup() {
  const [info, setInfo] = useState<{ banco: string; onde: string } | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => { api.banco().then(setInfo).catch(() => {}) }, [])
  async function restaurar(f: File) {
    try {
      const r = await api.restaurarBackup(JSON.parse(await f.text()))
      setMsg(`✓ Restaurado: ${r.sites} sites, ${r.jobs} execuções e ${r.arquivos} registros de arquivos.`)
    } catch (e) { setMsg(`Erro ao restaurar: ${(e as Error).message}`) }
  }
  return (
    <>
      <header className="topo"><div><h1>Banco e backup</h1><p className="sub">Onde o histórico fica e como levar tudo para outro computador.</p></div></header>
      <section className="cartao">
        <h2>Banco em uso</h2>
        {info ? <p><b>{info.banco}</b> <span className="mono sub">{info.onde}</span></p> : <p className="sub">Carregando…</p>}
        <p className="sub">Com o Docker ligado (<span className="mono">docker compose up -d</span>), o painel usa o Postgres. Sem Docker, usa o SQLite em <span className="mono">backend\painel.db</span>.</p>
      </section>
      <div className="duas-colunas">
        <section className="cartao">
          <h2>Fazer backup</h2>
          <p className="sub">Um arquivo .json com todo o histórico: sites usados, execuções e o status de cada arquivo.</p>
          <a className="botao primario" href={api.backupUrl}>⤓ Baixar backup</a>
        </section>
        <section className="cartao">
          <h2>Restaurar backup</h2>
          <p className="sub">Junta o backup ao histórico deste computador. Funciona entre Postgres e SQLite.</p>
          <label className="botao arquivo-input">⤒ Escolher arquivo de backup
            <input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && restaurar(e.target.files[0])} />
          </label>
          {msg && <p className={msg.startsWith('✓') ? 'tudo-ok' : 'erro'}>{msg}</p>}
        </section>
      </div>
      <section className="cartao">
        <h2>Levar para outro notebook</h2>
        <ol className="regras">
          <li>Copie a pasta <span className="mono">mercado-livre-ia-3</span> inteira (leva os arquivos de <span className="mono">backend\downloads</span>) e rode <span className="mono">docker compose up -d</span> no novo. O banco do Docker fica num volume e não vai junto com a pasta: leve o histórico com o passo 2.</li>
          <li>Ou: baixe o backup aqui, instale o projeto no novo notebook e use "Restaurar backup".</li>
          <li>Se a pasta dos downloads mudar de lugar, o histórico continua, mas os caminhos antigos aparecem como "sumiu" nas inconsistências.</li>
        </ol>
      </section>
    </>
  )
}
