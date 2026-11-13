import { useEffect, useMemo, useState } from 'react'
import { api, MODELOS, PADRAO } from './api'
import type { Campo, Config, Evento, JobDetalhe, JobResumo, Verificacao } from './api'

type Rota = { tela: 'visao' } | { tela: 'nova' } | { tela: 'job'; id: string } | { tela: 'praticas' }

function lerRota(): Rota {
  const h = location.hash.replace('#/', '')
  if (h.startsWith('job/')) return { tela: 'job', id: h.slice(4) }
  if (h === 'nova') return { tela: 'nova' }
  if (h === 'praticas') return { tela: 'praticas' }
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
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------ visão geral */
const ROTULO: Record<string, string> = {
  na_fila: 'Na fila', rodando: 'Rodando', pausado: 'Pausado', aguardando_horario: 'Aguardando horário',
  concluido: 'Concluído', parado: 'Parado', erro: 'Erro',
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
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg((c) => ({ ...c, [k]: v }))

  async function verificar() {
    setErro(''); setCarregando(true); setVer(null)
    try {
      const v = await api.verificar(cfg.url, cfg.user_agent)
      setVer(v)
      if (cfg.seletor_item === 'article' && v.sugestoes[0]) set('seletor_item', v.sugestoes[0].seletor)
    } catch (e) {
      setErro((e as Error).message)
    } finally {
      setCarregando(false)
    }
  }

  async function iniciar() {
    setErro('')
    try {
      const final = usarJanela ? cfg : { ...cfg, hora_inicio: null, hora_fim: null }
      const { id } = await api.criarJob({ ...final, seletor_proxima: final.seletor_proxima || null })
      location.hash = `#/job/${id}`
    } catch (e) {
      setErro((e as Error).message)
    }
  }

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
            if (m) { setCfg({ ...PADRAO, ...m.cfg }); setVer(null) }
          }}
        >
          <option value="">Carregar modelo…</option>
          {MODELOS.map((m, i) => <option key={m.nome} value={i}>{m.nome}</option>)}
        </select>
      </header>

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
            <div className="veredito ok">
              Site “{ver.titulo ?? ver.url}” verificado ({ver.latencia_ms} ms).
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
          <JitterPreview min={cfg.pausa_min} max={cfg.pausa_max} />
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

      <section className="cartao rodape-acao">
        <div>
          <strong>Estimativa:</strong> {cfg.max_paginas} páginas em cerca de {formatarTempo(estimativa)},
          média de {mediaPausa.toFixed(1)} s entre requisições, uma por vez.
        </div>
        <button className="botao primario grande" disabled={!cfg.url} onClick={iniciar}>
          Iniciar raspagem
        </button>
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
function JitterPreview({ min, max }: { min: number; max: number }) {
  const amostras = useMemo(
    () => Array.from({ length: 24 }, () => min + Math.random() * (max - min)),
    [min, max],
  )
  const topo = max * 1.15
  return (
    <div className="jitter">
      <div className="jitter-barras">
        {amostras.map((a, i) => <span key={i} style={{ height: `${(a / topo) * 100}%` }} title={`${a.toFixed(2)} s`} />)}
      </div>
      <small>Prévia: cada barra é uma pausa sorteada entre {min.toFixed(1)} e {max.toFixed(1)} s. Nunca o mesmo intervalo duas vezes.</small>
    </div>
  )
}

/* ------------------------------------------------------------------ execução */
function Execucao({ id }: { id: string }) {
  const [job, setJob] = useState<JobDetalhe | null>(null)
  const [log, setLog] = useState<Evento[]>([])
  const [aba, setAba] = useState<'log' | 'dados'>('log')

  useEffect(() => {
    let vivo = true
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

  return (
    <>
      <header className="topo">
        <div>
          <a className="voltar" href="#/">← Visão geral</a>
          <h1>{new URL(job.url).host} <Selo s={job.status} /></h1>
          <p className="sub mono">{job.url}</p>
        </div>
        <div className="acoes">
          {job.status === 'pausado'
            ? <button className="botao" onClick={() => api.controlar(id, 'retomar')}>▶ Retomar</button>
            : <button className="botao" disabled={!ativo} onClick={() => api.controlar(id, 'pausar')}>❚❚ Pausar</button>}
          <button className="botao perigo" disabled={!ativo} onClick={() => api.controlar(id, 'parar')}>■ Parar</button>
          <a className="botao" href={api.exportarUrl(id, 'csv')}>Exportar CSV</a>
          <a className="botao" href={api.exportarUrl(id, 'json')}>JSON</a>
        </div>
      </header>

      <section className="kpis">
        <Kpi rotulo="Páginas" valor={`${job.paginas} / ${job.max_paginas}`} />
        <Kpi rotulo="Itens extraídos" valor={job.itens} />
        <Kpi rotulo="Requisições" valor={job.requisicoes} />
        <Kpi rotulo="Pausa média" valor={job.pausa_media != null ? `${job.pausa_media} s` : '—'}
          dica={`alvo ${job.config.pausa_min}–${job.config.pausa_max} s`} />
        <Kpi rotulo="Latência do site" valor={job.latencia_media != null ? `${job.latencia_media} ms` : '—'} dica="média" />
      </section>

      <div className="duas-colunas larga">
        <section className="cartao">
          <h2>Ritmo das requisições</h2>
          <GraficoPausas pausas={job.pausas} min={job.config.pausa_min} max={job.config.pausa_max} />
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
            <li>Pausa sorteada entre {job.config.pausa_min} e {job.config.pausa_max} s</li>
            <li>Pausa longa de ~{job.config.pausa_longa_seg} s a cada {job.config.pausa_longa_cada} páginas</li>
            <li>Backoff exponencial em 429/503 (até {job.config.max_tentativas} tentativas)</li>
            <li>Auto-throttle {job.config.auto_throttle ? 'ligado' : 'desligado'}</li>
            {job.config.hora_inicio != null && <li>Janela {job.config.hora_inicio}h–{job.config.hora_fim}h</li>}
          </ul>
        </section>
      </div>

      <section className="cartao">
        <div className="abas">
          <button className={aba === 'log' ? 'ativo' : ''} onClick={() => setAba('log')}>Log ao vivo</button>
          <button className={aba === 'dados' ? 'ativo' : ''} onClick={() => setAba('dados')}>Dados ({job.itens})</button>
        </div>
        {aba === 'log' ? (
          <div className="log">
            {[...log].reverse().slice(0, 200).map((e, i) => (
              <div key={i} className={`ev ev-${e.tipo}`}><span>{e.t}</span><b>{e.tipo}</b>{e.msg}</div>
            ))}
          </div>
        ) : (
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
    </>
  )
}

function GraficoPausas({ pausas, min, max }: { pausas: number[]; min: number; max: number }) {
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
          <text x={P - 6} y={y(v) + 4} textAnchor="end">{v.toFixed(0)}s</text>
        </g>
      ))}
      {pausas.map((p, i) => (
        <rect key={i} x={P + i * bw + 2} y={y(p)} width={Math.max(2, bw - 4)} height={H - P - y(p)} rx={2}
          className={p > max * 1.05 ? 'barra-longa' : 'barra-pausa'}><title>{p} s</title></rect>
      ))}
      <text x={W - P} y={H - 8} textAnchor="end">requisição →</text>
    </svg>
  )
}

/* ------------------------------------------------------------------ boas práticas */
function Praticas() {
  const itens = [
    ['Verificar antes de raspar', 'O painel checa o tempo de resposta, sugere seletores CSS e procura uma API oficial (por exemplo CKAN, usada em portais como dados.gov.br). Se existe API, use a API.'],
    ['Pausas com jitter', 'Cada pausa é sorteada entre o mínimo e o máximo (padrão 1 a 2 s). Intervalos regulares denunciam robô e sobrecarregam o servidor.'],
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
