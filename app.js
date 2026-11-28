import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// 1. CONFIGURAÇÃO DIRETA DO FIREBASE (CAIXA PETROVIA)
const firebaseConfig = {
  apiKey: "AIzaSyATOUK5seblVxcuJOBemzjrRXIEFQCIOF4",
  authDomain: "caixa-petrovia.firebaseapp.com",
  projectId: "caixa-petrovia",
  storageBucket: "caixa-petrovia.firebasestorage.app",
  messagingSenderId: "127871115347",
  appId: "1:127871115347:web:a393f927ee98b80e09a6a6"
};

const app = initializeApp(firebaseConfig);

const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

// Espelhos em memória sincronizados em tempo real com a nuvem
let cacheUsuarios = [];
let cacheProdutos = [];
let cacheTurnos = [];
let cacheVendas = [];
let configMaster = {
  nome: "Admin Master",
  senha: "admin123"
};

let usuarioLogado = null;
let turnoAtivo = null;
let carrinho = [];
let ultimaVendaId = null;
let ultimaVendaObjeto = null;

// Estados de Navegação e Pagamento por Teclado (Com suporte a Pagamento Misto)
let categoriaAtivaPDV = "TODAS";
let subcategoriaAtivaPDV = "TODAS";
let indiceFocoPDV = -1;

let pagamentoPassoAtual = 1; // 1: Forma, 1.1: Valor Parcial, 2: Bandeira
let pagamentoFormaSelecionada = null;
let pagamentoValorParcialAtual = 0;
let pagamentosParciaisVenda = [];

let chartInstanciaPicos = null;
let chartInstanciaProdutos = null;
let chartInstanciaFormas = null;

// Configuração do PDV (salva na nuvem em configuracoes/pdv) e estado da operação
let configPDV = { bloquearAposVenda: true, bloqueioInatividadeMin: 0, favoritos: [] };
let idadeConfirmadaNestaVenda = false;
let ultimoProdutoAdicionado = null;
let sessaoCarrinho = 0;
let timerInatividade = null;
let notasSugeridas = [];
let pendentesEnvio = 0;
let servidorRespondeu = false;
let resolverDialogo = null;
// Venda que está tendo a forma de pagamento alterada (o valor não muda)
let vendaEmAlteracao = null;
let alteracaoOrigem = null;
// Leitor de código de barras com o cursor fora da busca
let bufferLeitor = "";
let ultimaTeclaLeitor = 0;

// MAPA OFICIAL DE CATEGORIAS E EMBALAGENS
const MAPA_CATEGORIAS = {
  "Cervejas": ["Latinha", "Latão", "Big Latão", "Palito", "Sleek", "Long", "Litrinho", "Litrão", "Outros"],
  "Refrigerantes": ["Lata", "600ml", "1 Litro", "2 Litros", "Outros"],
  "Energéticos": ["Lata (250/269ml)", "Latão (473ml)", "Garrafa 2L", "Outros"],
  "Águas & Sucos": ["Sem Gás", "Com Gás", "Suco", "Água de Coco", "Gelo", "Outros"],
  "Automotivos": ["Óleo Lubrificante", "Aditivo", "Fluído de Freio", "Estética / Limpeza", "Outros"],
  "Cigarros": ["Carteira", "Unidade", "Carvão", "Diversos"]
};

// BANDEIRAS EM ORDEM ALFABÉTICA (SEMPRE 1x À VISTA)
const BANDEIRAS_PAGAMENTO = {
  CREDITO: ["Amex", "Elo", "Master", "Visa"],
  DEBITO: ["Elo", "Master", "Visa"]
};

// Janela de vendas acompanhadas em tempo real (performance). Datas mais antigas são buscadas sob demanda.
const JANELA_TEMPO_REAL_DIAS = 30;
const LIMITE_JANELA_MS = Date.now() - JANELA_TEMPO_REAL_DIAS * 24 * 60 * 60 * 1000;

// Vendas antigas (fora da janela) carregadas sob demanda, por ID
const vendasAntigas = new Map();
const diasAntigosCarregados = new Set();
const turnosAntigosCarregados = new Set();

let abrindoTurno = false;
let painelCorrecaoAberto = false;

// Login só é validado depois que usuários e senha master chegaram da nuvem
// (antes disso, toda senha parecia "inválida" porque a lista ainda estava vazia)
const estadoCarga = { usuarios: false, master: false };
let senhaPendente = null;
let timerSemConexao = null;

function dadosDeLoginProntos() {
  return estadoCarga.usuarios && estadoCarga.master;
}

function marcarCarregado(chave, snapshot) {
  // Cache local vazio não conta: espera a resposta do servidor
  if (snapshot.metadata.fromCache && snapshot.empty) return;
  estadoCarga[chave] = true;
  if (dadosDeLoginProntos() && senhaPendente !== null) {
    const input = document.getElementById("input-senha-acesso");
    if (input) input.value = senhaPendente;
    senhaPendente = null;
    autenticarOperador();
  }
}

function mostrarCarregandoLogin(texto = null, alerta = false) {
  const el = document.getElementById("msg-carregando-login");
  if (!el) return;
  document.getElementById("msg-carregando-texto").textContent =
    texto || "Carregando dados do caixa… você entra automaticamente.";
  el.classList.toggle("alerta", alerta);
  el.classList.remove("hidden");
}

function esconderCarregandoLogin() {
  document.getElementById("msg-carregando-login")?.classList.add("hidden");
  clearTimeout(timerSemConexao);
}

function avisarFalhaDeCarga(erro) {
  console.error("Erro ao carregar dados de login:", erro);
  mostrarCarregandoLogin("Não foi possível carregar os usuários. Verifique a internet e recarregue a página (F5).", true);
}

// Escapa texto antes de inserir via innerHTML (proteção contra XSS)
function esc(valor) {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Arredonda valores monetários para 2 casas (evita erros de centavos do ponto flutuante)
function r2(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

// Compara IDs antigos (numéricos) e novos (texto) de forma segura
function mesmoId(a, b) {
  return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
}

// Dinheiro no formato brasileiro: R$ 8,50
const formatoBRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
function fmt(valor) {
  return formatoBRL.format(r2(Number(valor) || 0));
}

// Só o número, para as colunas do cupom: 8,50
function fmtNum(valor) {
  return r2(Number(valor) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Busca sem acento e sem maiúsculas: "agua" encontra "Água"
function semAcento(texto) {
  return String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Cor de cada categoria (as cores ficam no style.css)
const CLASSE_CATEGORIA = {
  "Cervejas": "cat-cerveja",
  "Refrigerantes": "cat-refri",
  "Energéticos": "cat-energ",
  "Águas & Sucos": "cat-agua",
  "Automotivos": "cat-auto",
  "Cigarros": "cat-cigarro"
};

const NOME_CURTO_CATEGORIA = {
  "Cervejas": "Cerveja",
  "Refrigerantes": "Refri",
  "Energéticos": "Energético",
  "Águas & Sucos": "Água/Suco",
  "Automotivos": "Automotivo",
  "Cigarros": "Cigarro"
};

// Categorias que pedem confirmação de maioridade na hora de pagar
const CATEGORIAS_MAIORIDADE = ["Cervejas", "Cigarros"];

const NOME_FORMA = { DINHEIRO: "dinheiro", PIX: "PIX", CREDITO: "crédito", DEBITO: "débito" };

function categoriaDe(produto) {
  const categoria = produto?.categoria;
  return categoria === "Conveniência" ? "Cigarros" : (categoria || "Cigarros");
}

function classeCategoria(categoria) {
  return CLASSE_CATEGORIA[categoria] || "cat-outra";
}

// Preferências deste computador (tema e som)
function lerPreferencia(chave, padrao) {
  try {
    return localStorage.getItem(chave) ?? padrao;
  } catch (e) {
    return padrao;
  }
}

function salvarPreferencia(chave, valor) {
  try {
    localStorage.setItem(chave, valor);
  } catch (e) {
    // navegador sem armazenamento local: a preferência vale só até recarregar
  }
}

// Sons curtos: bipe de confirmação e som diferente para erro (Web Audio, sem arquivos)
let somLigado = lerPreferencia("pdv-som", "1") === "1";
let contextoAudio = null;

function tocarSom(tipo) {
  if (!somLigado) return;
  try {
    contextoAudio = contextoAudio || new (window.AudioContext || window.webkitAudioContext)();
    if (contextoAudio.state === "suspended") contextoAudio.resume();
    const erro = tipo === "erro";
    const notas = erro
      ? [{ freq: 220, ini: 0, dur: 0.14 }, { freq: 220, ini: 0.2, dur: 0.14 }]
      : [{ freq: 1320, ini: 0, dur: 0.07 }];
    notas.forEach(n => {
      const osc = contextoAudio.createOscillator();
      const ganho = contextoAudio.createGain();
      osc.type = erro ? "square" : "sine";
      osc.frequency.value = n.freq;
      const t0 = contextoAudio.currentTime + n.ini;
      ganho.gain.setValueAtTime(0.0001, t0);
      ganho.gain.exponentialRampToValueAtTime(erro ? 0.12 : 0.2, t0 + 0.01);
      ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
      osc.connect(ganho).connect(contextoAudio.destination);
      osc.start(t0);
      osc.stop(t0 + n.dur + 0.02);
    });
  } catch (e) {
    // som indisponível neste navegador
  }
}

function atualizarBotaoSom() {
  const btn = document.getElementById("btn-som");
  if (!btn) return;
  btn.innerHTML = somLigado ? '<i class="ri-volume-up-line"></i>' : '<i class="ri-volume-mute-line"></i>';
  btn.classList.toggle("desligado", !somLigado);
  btn.title = somLigado ? "Som ligado" : "Som desligado";
  btn.setAttribute("aria-label", somLigado ? "Desligar som" : "Ligar som");
}

function alternarSom() {
  somLigado = !somLigado;
  salvarPreferencia("pdv-som", somLigado ? "1" : "0");
  atualizarBotaoSom();
  if (somLigado) tocarSom("ok");
}

// Tema claro (padrão) ou escuro, salvo neste computador
function temaAtual() {
  return document.documentElement.dataset.tema === "escuro" ? "escuro" : "claro";
}

function aplicarTema(tema) {
  if (tema === "escuro") document.documentElement.dataset.tema = "escuro";
  else delete document.documentElement.dataset.tema;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", tema === "escuro" ? "#0e1116" : "#f4f5f8");
  const btn = document.getElementById("btn-tema");
  if (btn) {
    const rotulo = tema === "escuro" ? "Usar tema claro" : "Usar tema escuro";
    btn.innerHTML = tema === "escuro" ? '<i class="ri-sun-line"></i>' : '<i class="ri-moon-line"></i>';
    btn.title = rotulo;
    btn.setAttribute("aria-label", rotulo);
  }
  if (document.getElementById("tela-dashboard")?.classList.contains("active")) renderizarDashboard();
}

function alternarTema() {
  const novo = temaAtual() === "escuro" ? "claro" : "escuro";
  salvarPreferencia("pdv-tema", novo);
  aplicarTema(novo);
}

// Avisos rápidos no rodapé (no lugar das janelas cinzas do navegador)
function avisar(mensagem, opcoes = {}) {
  const { tipo = "info", acao = null } = opcoes;
  // Tempo para dar para ler: 7 s nos avisos comuns, 10 s nos de erro ou com "Desfazer",
  // e mais tempo para mensagens longas (até 15 s)
  const duracao = opcoes.duracao ?? Math.min(15000, Math.max(acao || tipo === "erro" ? 10000 : 7000, String(mensagem).length * 70));
  const pilha = document.getElementById("avisos");
  if (!pilha) return () => {};
  const icones = {
    info: "ri-information-line",
    sucesso: "ri-checkbox-circle-line",
    alerta: "ri-alert-line",
    erro: "ri-error-warning-line"
  };
  const el = document.createElement("div");
  el.className = `aviso ${tipo}`;
  el.setAttribute("role", tipo === "erro" ? "alert" : "status");
  el.innerHTML = `<i class="${icones[tipo] || icones.info}"></i><span class="aviso-msg"></span>`;
  el.querySelector(".aviso-msg").textContent = mensagem;

  let fechado = false;
  const fechar = () => {
    if (fechado) return;
    fechado = true;
    el.classList.remove("show");
    setTimeout(() => el.remove(), 220);
  };

  if (acao) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "aviso-acao";
    botao.textContent = acao.rotulo;
    botao.addEventListener("click", () => {
      fechar();
      acao.fn();
    });
    el.appendChild(botao);
  }

  const botaoFechar = document.createElement("button");
  botaoFechar.type = "button";
  botaoFechar.className = "aviso-fechar";
  botaoFechar.setAttribute("aria-label", "Fechar aviso");
  botaoFechar.textContent = "×";
  botaoFechar.addEventListener("click", fechar);
  el.appendChild(botaoFechar);

  pilha.appendChild(el);
  while (pilha.children.length > 3) pilha.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add("show"));
  // Com o mouse em cima, o aviso não some; ao tirar, ainda fica mais 3 s
  let timer = setTimeout(fechar, duracao);
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => {
    clearTimeout(timer);
    timer = setTimeout(fechar, 3000);
  });
  return fechar;
}

// Confirmação no visual do caixa: Enter confirma, Esc volta
function dialogoAberto() {
  return Boolean(document.getElementById("dialogo")?.classList.contains("active"));
}

function confirmar({ titulo, mensagem, confirmarTexto = "Confirmar", cancelarTexto = "Voltar", tipo = "pergunta" } = {}) {
  return new Promise(resolve => {
    if (resolverDialogo) resolverDialogo(false);
    const dialogo = document.getElementById("dialogo");
    const icone = document.getElementById("dialogo-icone");
    const btnOk = document.getElementById("dialogo-confirmar");
    const btnVoltar = document.getElementById("dialogo-cancelar");
    const estilos = {
      pergunta: { classe: "", icone: "ri-question-line", botao: "btn-primary" },
      perigo: { classe: "danger-icon", icone: "ri-error-warning-line", botao: "btn-danger-solid" },
      alerta: { classe: "warning-icon", icone: "ri-alert-line", botao: "btn-primary" }
    };
    const estilo = estilos[tipo] || estilos.pergunta;
    icone.className = `alert-icon ${estilo.classe}`;
    icone.innerHTML = `<i class="${estilo.icone}"></i>`;
    document.getElementById("dialogo-titulo").textContent = titulo || "Confirmar";
    document.getElementById("dialogo-mensagem").textContent = mensagem || "";
    btnOk.className = `btn ${estilo.botao}`;
    btnOk.innerHTML = `${esc(confirmarTexto)} <kbd>Enter</kbd>`;
    btnVoltar.innerHTML = `${esc(cancelarTexto)} <kbd>Esc</kbd>`;

    const focoAnterior = document.activeElement;
    resolverDialogo = (resposta) => {
      resolverDialogo = null;
      dialogo.classList.remove("active");
      btnOk.onclick = null;
      btnVoltar.onclick = null;
      if (focoAnterior && typeof focoAnterior.focus === "function" && document.contains(focoAnterior)) {
        focoAnterior.focus();
      }
      resolve(resposta);
    };
    btnOk.onclick = () => resolverDialogo?.(true);
    btnVoltar.onclick = () => resolverDialogo?.(false);
    dialogo.classList.add("active");
    setTimeout(() => btnOk.focus(), 30);
  });
}

// Lê a busca do PDV. "6*" no começo multiplica a quantidade: 6*7891234 lança 6 unidades
function lerBusca() {
  const bruto = document.getElementById("busca-produto-pdv")?.value || "";
  const m = bruto.match(/^\s*(\d{1,3})\s*\*\s*(.*)$/);
  const qtd = m ? Math.max(1, Math.min(999, parseInt(m[1], 10))) : 1;
  const termo = (m ? m[2] : bruto).trim();
  return { qtd, termo, termoNorm: semAcento(termo), temMultiplicador: Boolean(m) };
}

function limparBusca() {
  const input = document.getElementById("busca-produto-pdv");
  if (input) input.value = "";
  indiceFocoPDV = -1;
  carregarProdutos();
}

// Hora curta (05:32) e data curta (26/11 05:32)
function formatarHora(timestamp) {
  return new Date(timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatarDataCurta(timestamp) {
  const d = new Date(timestamp);
  return `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${formatarHora(timestamp)}`;
}

// "Hoje · 26/11", "Ontem · 25/11" ou "Terça-feira · 24/11"
function rotuloDia(dataISO) {
  const hoje = dataLocalISO(Date.now());
  const ontem = dataLocalISO(Date.now() - 864e5);
  const d = new Date(`${dataISO}T12:00:00`);
  const dia = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  if (dataISO === hoje) return `Hoje · ${dia}`;
  if (dataISO === ontem) return `Ontem · ${dia}`;
  const semana = d.toLocaleDateString("pt-BR", { weekday: "long" });
  return `${semana.charAt(0).toUpperCase()}${semana.slice(1)} · ${dia}`;
}

function duracaoTexto(ms) {
  const minutos = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}min` : `${m} min`;
}

const ICONE_FORMA = {
  DINHEIRO: "ri-money-dollar-circle-line",
  PIX: "ri-qr-code-line",
  CREDITO: "ri-bank-card-fill",
  DEBITO: "ri-bank-card-2-line"
};
const ROTULO_FORMA = { DINHEIRO: "Dinheiro", PIX: "PIX", CREDITO: "Crédito", DEBITO: "Débito" };

// Pagamentos de uma venda (vendas antigas guardavam só a forma principal)
function pagamentosDaVenda(v) {
  if (Array.isArray(v.pagamentos) && v.pagamentos.length) return v.pagamentos;
  if (v.formaPagamento) return [{ forma: v.formaPagamento, bandeira: v.bandeira || null, valor: v.valorFinal }];
  return [];
}

// Números de um conjunto de vendas: quantidade, total, ticket médio e total por forma
function resumoDasVendas(vendas) {
  const concluidas = vendas.filter(v => v.status === "CONCLUIDA");
  const total = r2(concluidas.reduce((acc, v) => acc + (Number(v.valorFinal) || 0), 0));
  const porForma = { DINHEIRO: 0, PIX: 0, CREDITO: 0, DEBITO: 0 };
  concluidas.forEach(v => pagamentosDaVenda(v).forEach(p => {
    if (porForma[p.forma] !== undefined) porForma[p.forma] = r2(porForma[p.forma] + (Number(p.valor) || 0));
  }));
  return {
    qtd: concluidas.length,
    total,
    ticket: concluidas.length ? r2(total / concluidas.length) : 0,
    canceladas: vendas.filter(v => v.status === "CANCELADA").length,
    porForma
  };
}

// Chips de pagamento com ícone: "Dinheiro", "Crédito Visa", ou cada parte do pagamento dividido com o valor
function chipsPagamentoHTML(v) {
  const pagamentos = pagamentosDaVenda(v);
  if (!pagamentos.length) return `<span class="chip-pag">Não informado</span>`;
  const varios = pagamentos.length > 1;
  return pagamentos.map(p => {
    const rotulo = `${ROTULO_FORMA[p.forma] || p.forma}${p.bandeira ? ` ${p.bandeira}` : ""}`;
    const valor = varios ? ` <b class="mono">${fmt(p.valor)}</b>` : "";
    const troco = Number(p.troco) > 0 ? ` <span class="troco-chip">troco ${fmt(p.troco)}</span>` : "";
    const classe = `pag-${String(p.forma || "").toLowerCase()}`;
    return `<span class="chip-pag ${classe}"><i class="${ICONE_FORMA[p.forma] || "ri-wallet-3-line"}"></i>${esc(rotulo)}${valor}${troco}</span>`;
  }).join("");
}

// "MANHÃ (06h-14h)": o horário some no celular para caber no topo
function rotuloTurnoHTML(tipoTurno) {
  const texto = String(tipoTurno || "");
  const i = texto.indexOf(" (");
  if (i < 0) return esc(texto);
  return `${esc(texto.slice(0, i))}<span class="turno-horario">${esc(texto.slice(i))}</span>`;
}

// Dobra de turno: o mesmo caixa pode cobrir até 3 períodos seguidos
const PERIODOS = [
  { nome: "MANHÃ", inicio: 6, fim: 14 },
  { nome: "TARDE", inicio: 14, fim: 22 },
  { nome: "NOITE", inicio: 22, fim: 6 }
];
const HORA_2 = h => `${String(h).padStart(2, "0")}h`;

function periodosDoTurno(t) {
  if (Array.isArray(t?.periodos) && t.periodos.length) return t.periodos;
  const nome = String(t?.tipoTurno || "").split(" ")[0].toUpperCase();
  return PERIODOS.some(p => p.nome === nome) ? [nome] : [];
}

function rotuloPeriodos(lista) {
  const ps = lista.map(n => PERIODOS.find(p => p.nome === n)).filter(Boolean);
  if (!ps.length) return "";
  return `${ps.map(p => p.nome).join(" + ")} (${HORA_2(ps[0].inicio)}-${HORA_2(ps[ps.length - 1].fim)})`;
}

function proximoPeriodo(t) {
  const lista = periodosDoTurno(t);
  if (!lista.length || lista.length >= PERIODOS.length) return null;
  const i = PERIODOS.findIndex(p => p.nome === lista[lista.length - 1]);
  return PERIODOS[(i + 1) % PERIODOS.length];
}

// Período pelo relógio: 06h-14h manhã, 14h-22h tarde, 22h-06h noite
function periodoDaHora(momento = Date.now()) {
  const h = new Date(momento).getHours();
  return h >= 6 && h < 14 ? "MANHÃ" : h >= 14 && h < 22 ? "TARDE" : "NOITE";
}

// Aceita abrir até 30 min antes do período começar
const TOLERANCIA_ABERTURA = 30 * 60000;
function periodoCombinaComHora(nome, momento) {
  return nome === periodoDaHora(momento) || nome === periodoDaHora(momento + TOLERANCIA_ABERTURA);
}

// Sequência de períodos a partir de um nome (ex.: TARDE, 2 → TARDE, NOITE)
function sequenciaDePeriodos(inicio, quantidade) {
  const i = PERIODOS.findIndex(p => p.nome === inicio);
  return Array.from({ length: quantidade }, (_, k) => PERIODOS[(i + k) % PERIODOS.length].nome);
}

// Turno aberto em período diferente do horário da abertura (ex.: "Manhã" às 15h)
function periodoSugeridoSeErrado(t) {
  const lista = periodosDoTurno(t);
  if (!lista.length) return null;
  return periodoCombinaComHora(lista[0], t.dataHoraAbertura) ? null : periodoDaHora(t.dataHoraAbertura);
}

// Destaca no PDV o botão do período certo para a hora atual
function marcarPeriodoSugerido() {
  const agora = periodoDaHora();
  document.querySelectorAll("#aviso-turno-fechado [data-periodo]").forEach(btn => {
    const certo = btn.dataset.periodo === agora;
    btn.classList.toggle("btn-primary", certo);
    btn.classList.toggle("btn-secondary", !certo);
    btn.classList.toggle("periodo-sugerido", certo);
  });
}

// Horário em que termina cada período do turno (pelo relógio, a partir da abertura)
function finsDosPeriodos(t) {
  const lista = periodosDoTurno(t);
  if (!lista.length) return [];
  const primeiro = PERIODOS.find(p => p.nome === lista[0]);
  const fim = new Date(t.dataHoraAbertura);
  fim.setHours(primeiro.fim, 0, 0, 0);
  if (fim.getTime() <= t.dataHoraAbertura) fim.setDate(fim.getDate() + 1);
  return lista.map((_, i) => fim.getTime() + i * 8 * 3600000);
}

// Mostrar/esconder senha nos formulários do Admin
function alternarCampoSenha(id, botao) {
  const campo = document.getElementById(id);
  if (!campo) return;
  const mostrar = campo.type === "password";
  campo.type = mostrar ? "text" : "password";
  const rotulo = mostrar ? "Esconder senha" : "Mostrar senha";
  botao.innerHTML = mostrar ? '<i class="ri-eye-off-line"></i>' : '<i class="ri-eye-line"></i>';
  botao.title = rotulo;
  botao.setAttribute("aria-label", rotulo);
}

function esconderCampoSenha(id) {
  const campo = document.getElementById(id);
  if (!campo || campo.type === "password") return;
  const botao = campo.parentElement?.querySelector(".icon-btn");
  if (botao) alternarCampoSenha(id, botao);
  else campo.type = "password";
}

// Na lista de operadores a senha fica escondida até alguém pedir para ver
function mostrarSenhaOperador(id, botao) {
  const op = cacheUsuarios.find(u => u.id === Number(id));
  const alvo = botao.closest(".linha-operador")?.querySelector(".senha-valor");
  if (!op || !alvo) return;
  const visivel = alvo.dataset.visivel === "1";
  alvo.textContent = visivel ? "••••" : op.senha;
  alvo.dataset.visivel = visivel ? "0" : "1";
  const rotulo = visivel ? "Mostrar senha" : "Esconder senha";
  botao.innerHTML = visivel ? '<i class="ri-eye-line"></i>' : '<i class="ri-eye-off-line"></i>';
  botao.title = rotulo;
  botao.setAttribute("aria-label", rotulo);
}

// Categorias que não cabem na linha: degradê na borda e roda do mouse rola para o lado
function atualizarFadePills() {
  document.querySelectorAll(".pills-bar").forEach(barra => {
    const temMais = barra.scrollWidth > barra.clientWidth + 2;
    barra.classList.toggle("fade-dir", temMais && barra.scrollLeft + barra.clientWidth < barra.scrollWidth - 2);
    barra.classList.toggle("fade-esq", temMais && barra.scrollLeft > 2);
  });
}

function instalarRolagemPills() {
  document.querySelectorAll(".pills-bar").forEach(barra => {
    barra.addEventListener("scroll", atualizarFadePills, { passive: true });
    barra.addEventListener("wheel", e => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && barra.scrollWidth > barra.clientWidth) {
        barra.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
  });
  window.addEventListener("resize", atualizarFadePills);
}

// Relógio e data na tela de bloqueio
function iniciarRelogio() {
  const atualizar = () => {
    const agora = new Date();
    const hora = document.getElementById("relogio-hora");
    const data = document.getElementById("relogio-data");
    if (hora) hora.textContent = agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    if (data) {
      const texto = agora.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
      data.textContent = texto.charAt(0).toUpperCase() + texto.slice(1);
    }
  };
  atualizar();
  setInterval(atualizar, 15000);
  setInterval(() => atualizarAvisoFimTurno(), 60000);
}

// Turnos do histórico que o usuário abriu ou fechou (para manter ao atualizar a lista)
const estadoTurnoHistorico = new Map();
function registrarTurnoAberto(id, aberto) {
  estadoTurnoHistorico.set(String(id), Boolean(aberto));
}

// Notas sugeridas a partir do valor que falta: próximo múltiplo de 5 e de 10 e as notas acima dele
function sugerirNotas(valor) {
  const acima = multiplo => Math.ceil((valor + 0.001) / multiplo) * multiplo;
  const candidatos = [acima(5), acima(10), 10, 20, 50, 100, 200].filter(v => v > valor + 0.001);
  return [...new Set(candidatos)].sort((a, b) => a - b).slice(0, 3);
}

// ID único gerado no próprio aparelho (funciona offline, sem colisão entre terminais)
// Formato: AAMMDD-HHMM-XXXX  (ex: 261126-1432-7F3K)
function gerarIdUnico() {
  const d = new Date();
  const p2 = n => String(n).padStart(2, "0");
  const data = `${String(d.getFullYear()).slice(-2)}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  const hora = `${p2(d.getHours())}${p2(d.getMinutes())}`;
  const alfabeto = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const sufixo = Array.from(bytes, b => alfabeto[b % alfabeto.length]).join("");
  return `${data}-${hora}-${sufixo}`;
}

// Data local (fuso do computador) no formato AAAA-MM-DD — substitui toISOString(), que usa UTC
function dataLocalISO(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function intervaloDoDiaLocal(dataISO) {
  const inicio = new Date(`${dataISO}T00:00:00`).getTime();
  const fim = new Date(`${dataISO}T00:00:00`);
  fim.setDate(fim.getDate() + 1);
  return { inicio, fim: fim.getTime() };
}

// Todas as vendas conhecidas: tempo real (janela) + antigas carregadas sob demanda
function todasVendas() {
  const idsTempoReal = new Set(cacheVendas.map(v => String(v.id)));
  const extras = [...vendasAntigas.values()].filter(v => !idsTempoReal.has(String(v.id)));
  return [...cacheVendas, ...extras];
}

function buscarVenda(id) {
  return todasVendas().find(v => mesmoId(v.id, id)) || null;
}

function registrarVendasAntigas(snapshot) {
  snapshot.docs.forEach(d => {
    const v = d.data();
    vendasAntigas.set(String(v.id), v);
  });
}

// Garante que as vendas de um dia fora da janela estejam carregadas
async function garantirVendasDoDia(dataISO) {
  if (!dataISO || diasAntigosCarregados.has(dataISO)) return false;
  const { inicio, fim } = intervaloDoDiaLocal(dataISO);
  if (inicio >= LIMITE_JANELA_MS) return false;
  diasAntigosCarregados.add(dataISO);
  try {
    const snap = await getDocs(query(
      collection(db, "vendas"),
      where("dataHora", ">=", inicio),
      where("dataHora", "<", fim)
    ));
    registrarVendasAntigas(snap);
    return true;
  } catch (erro) {
    diasAntigosCarregados.delete(dataISO);
    console.error("Erro ao carregar vendas antigas:", erro);
    return false;
  }
}

// Garante que as vendas de turnos fora da janela estejam carregadas
async function garantirVendasDosTurnos(turnos) {
  const pendentes = turnos.filter(t =>
    t.dataHoraAbertura < LIMITE_JANELA_MS && !turnosAntigosCarregados.has(String(t.id))
  );
  if (!pendentes.length) return false;
  pendentes.forEach(t => turnosAntigosCarregados.add(String(t.id)));
  try {
    await Promise.all(pendentes.map(async t => {
      const snap = await getDocs(query(collection(db, "vendas"), where("turnoId", "==", t.id)));
      registrarVendasAntigas(snap);
    }));
    return true;
  } catch (erro) {
    pendentes.forEach(t => turnosAntigosCarregados.delete(String(t.id)));
    console.error("Erro ao carregar vendas de turnos antigos:", erro);
    return false;
  }
}

function gerarProximoId(lista) {
  if (!lista.length) return 1;
  return Math.max(...lista.map(item => Number(item.id) || 0)) + 1;
}

function obterNomePerfil(usuarioId, nomeSalvo) {
  if (usuarioId === "admin") return configMaster.nome;
  const op = cacheUsuarios.find(u => u.id === Number(usuarioId));
  return op ? op.nome : (nomeSalvo || "Operador");
}

function formatarPagamentoTexto(venda) {
  if (venda.pagamentos && venda.pagamentos.length > 0) {
    if (venda.pagamentos.length === 1) {
      const p = venda.pagamentos[0];
      if (p.forma === "DINHEIRO" || p.forma === "PIX") return p.forma;
      return `${p.forma} - ${(p.bandeira || "OUTRA").toUpperCase()}${p.forma === "CREDITO" ? " (1x)" : ""}`;
    }
    return "MISTO (" + venda.pagamentos.map(p => {
      const rotulo = p.bandeira ? `${p.forma} ${p.bandeira}` : p.forma;
      return `${rotulo}: ${fmt(p.valor)}`;
    }).join(" | ") + ")";
  }
  if (!venda.formaPagamento) return "Não informado";
  if (venda.formaPagamento === "DINHEIRO" || venda.formaPagamento === "PIX") return venda.formaPagamento;
  if (venda.formaPagamento === "CREDITO") return `CRÉDITO - ${(venda.bandeira || "OUTRA").toUpperCase()} (1x)`;
  if (venda.formaPagamento === "DEBITO") return `DÉBITO - ${(venda.bandeira || "OUTRA").toUpperCase()}`;
  return venda.formaPagamento;
}

// 2. ESCUTA EM TEMPO REAL DO FIREBASE
function iniciarSincronizacaoFirebase() {
  onSnapshot(collection(db, "configuracoes"), (snapshot) => {
    const docMaster = snapshot.docs.find(d => d.id === "master");
    if (docMaster) {
      configMaster = docMaster.data();
      if (usuarioLogado?.isAdmin) {
        usuarioLogado.nome = configMaster.nome;
        document.getElementById("badge-operador").innerHTML = `<i class="ri-user-3-line"></i> ${esc(usuarioLogado.nome)}`;
        preencherCamposMaster();
      }
    }
    const docPDV = snapshot.docs.find(d => d.id === "pdv");
    if (docPDV) {
      const dados = docPDV.data();
      configPDV = {
        bloquearAposVenda: dados.bloquearAposVenda !== false,
        bloqueioInatividadeMin: Number(dados.bloqueioInatividadeMin) || 0,
        favoritos: Array.isArray(dados.favoritos) ? dados.favoritos.map(Number).filter(n => !isNaN(n)) : []
      };
      preencherConfigPDV();
      if (usuarioLogado) {
        carregarProdutos();
        reiniciarTimerInatividade();
      }
    }
    // Por último: a senha master já está atualizada quando o login pendente rodar
    marcarCarregado("master", snapshot);
  }, avisarFalhaDeCarga);

  onSnapshot(collection(db, "usuarios"), (snapshot) => {
    cacheUsuarios = snapshot.docs.map(d => d.data());
    if (usuarioLogado && !usuarioLogado.isAdmin) {
      const meuPerfil = cacheUsuarios.find(u => u.id === usuarioLogado.id);
      if (meuPerfil) {
        usuarioLogado.nome = meuPerfil.nome;
        document.getElementById("badge-operador").innerHTML = `<i class="ri-user-3-line"></i> ${esc(usuarioLogado.nome)}`;
      }
    }
    if (usuarioLogado?.isAdmin) carregarOperadores();
    if (usuarioLogado) {
      atualizarStatusTurnoUI();
      carregarHistoricoTurnos();
      carregarAbaVendas();
    }
    marcarCarregado("usuarios", snapshot);
  }, avisarFalhaDeCarga);

  onSnapshot(collection(db, "produtos"), (snapshot) => {
    cacheProdutos = snapshot.docs.map(d => d.data());
    if (usuarioLogado) {
      carregarProdutos();
      atualizarCarrinhoUI();
    }
  });

  onSnapshot(collection(db, "turnos"), (snapshot) => {
    cacheTurnos = snapshot.docs.map(d => d.data());
    if (usuarioLogado?.isAdmin) carregarOperadores();
    if (usuarioLogado) {
      verificarTurnoAbertoDoUsuario();
      carregarHistoricoTurnos();
      carregarAbaVendas();
    }
  });

  // Somente vendas dos últimos JANELA_TEMPO_REAL_DIAS dias em tempo real
  onSnapshot(query(collection(db, "vendas"), where("dataHora", ">=", LIMITE_JANELA_MS)), (snapshot) => {
    cacheVendas = snapshot.docs.map(d => d.data());
    if (usuarioLogado) {
      renderizarFaixaMaisVendidos();
      renderizarInfoTurno();
      carregarHistoricoTurnos();
      carregarAbaVendas();
      if (document.getElementById("tela-dashboard")?.classList.contains("active")) {
        renderizarDashboard();
      }
    }
  });
}

inicializarSeletoresCategorias();
aplicarTema(temaAtual());
atualizarBotaoSom();
atualizarCarrinhoUI();
iniciarSincronizacaoFirebase();
iniciarStatusNuvem();
iniciarRelogio();
instalarRolagemPills();
focarInputSenha();
["pointerdown", "touchstart"].forEach(evento =>
  window.addEventListener(evento, reiniciarTimerInatividade, { passive: true })
);

function inicializarSeletoresCategorias() {
  const selectCatForm = document.getElementById("prod-categoria");
  const selectFiltroCadastro = document.getElementById("filtro-cat-cadastro");
  const categorias = Object.keys(MAPA_CATEGORIAS);

  if (selectCatForm) {
    selectCatForm.innerHTML = categorias.map(c => `<option value="${c}">${c}</option>`).join("");
    atualizarSubcategoriasForm();
  }

  if (selectFiltroCadastro) {
    selectFiltroCadastro.innerHTML = `<option value="TODAS">Todas as categorias</option>` +
      categorias.map(c => `<option value="${c}">${c}</option>`).join("");
  }
}

function atualizarSubcategoriasForm(subParaSelecionar = null) {
  const catSelecionada = document.getElementById("prod-categoria").value;
  const selectSub = document.getElementById("prod-subcategoria");
  const subcategorias = MAPA_CATEGORIAS[catSelecionada] || ["Outros"];

  selectSub.innerHTML = subcategorias.map(sub => `<option value="${sub}">${sub}</option>`).join("");
  if (subParaSelecionar && subcategorias.includes(subParaSelecionar)) {
    selectSub.value = subParaSelecionar;
  }
}

// 3. MOTOR DE ATALHOS DE TECLADO (SETAS, PAGAMENTO, TROCO E LEITOR DE CÓDIGO)
window.addEventListener("keydown", (e) => {
  reiniciarTimerInatividade();

  // Confirmação do próprio sistema aberta: só Enter (confirma) e Esc (volta)
  if (dialogoAberto()) {
    if (e.key === "Enter") {
      e.preventDefault();
      resolverDialogo?.(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      resolverDialogo?.(false);
    }
    return;
  }

  // F5 recarrega a página no navegador: com alguém no caixa, isso descartaria a venda
  if (e.key === "F5" && usuarioLogado) e.preventDefault();

  const modalBloqueio = document.getElementById("modal-bloqueio");
  const modalCancelar = document.getElementById("modal-cancelar-venda");
  const modalPosVenda = document.getElementById("modal-pos-venda");
  const modalPagamento = document.getElementById("modal-pagamento");

  if (modalBloqueio.classList.contains("active")) return;

  if (modalCancelar.classList.contains("active")) {
    if (e.key === "Escape") {
      e.preventDefault();
      fecharModalCancelamento();
    }
    return;
  }

  if (modalPosVenda.classList.contains("active")) {
    if (e.key === "Escape") {
      e.preventDefault();
      confirmarImpressaoPosVenda(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirmarImpressaoPosVenda(true);
    } else if (e.key === "F2") {
      e.preventDefault();
      alterarPagamentoUltimaVenda();
    }
    return;
  }

  if (modalPagamento.classList.contains("active")) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (pagamentoPassoAtual === 1.1 || pagamentoPassoAtual === 2) {
        voltarParaEscolhaForma();
      } else {
        cancelarPagamento();
      }
      return;
    }

    if (pagamentoPassoAtual === 1) {
      if (e.key === "1") { e.preventDefault(); selecionarFormaPagamento("DINHEIRO"); }
      else if (e.key === "2") { e.preventDefault(); selecionarFormaPagamento("PIX"); }
      else if (e.key === "3") { e.preventDefault(); selecionarFormaPagamento("CREDITO"); }
      else if (e.key === "4") { e.preventDefault(); selecionarFormaPagamento("DEBITO"); }
      else if (e.key === "F5") { e.preventDefault(); pagarRestanteEmDinheiro(); }
      else if (e.key === "F2") {
        e.preventDefault();
        const btnConcluir = document.getElementById("btn-concluir-pagamento-misto");
        if (btnConcluir && !btnConcluir.classList.contains("hidden")) {
          concluirPagamento();
        }
      }
    } else if (pagamentoPassoAtual === 1.1) {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmarValorParcial();
      } else if (pagamentoFormaSelecionada === "DINHEIRO" && e.key === "F5") {
        e.preventDefault();
        confirmarValorParcial(calcularRestante());
      } else if (pagamentoFormaSelecionada === "DINHEIRO" && ["F6", "F7", "F8"].includes(e.key)) {
        e.preventDefault();
        const nota = notasSugeridas[["F6", "F7", "F8"].indexOf(e.key)];
        if (nota) confirmarValorParcial(nota);
      }
    } else if (pagamentoPassoAtual === 2) {
      if (e.key === "Backspace") {
        e.preventDefault();
        voltarParaEscolhaForma();
        return;
      }
      const bandeiras = BANDEIRAS_PAGAMENTO[pagamentoFormaSelecionada] || [];
      const idx = parseInt(e.key, 10) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < bandeiras.length) {
        e.preventDefault();
        selecionarBandeiraPagamento(bandeiras[idx]);
      }
    }
    return;
  }

  if (e.key === "Escape") {
    e.preventDefault();
    pedirBloqueio();
    return;
  }

  const noPDV = document.getElementById("tela-pdv").classList.contains("active") && turnoAtivo;
  if (!noPDV) return;

  if (e.key === "F2") {
    e.preventDefault();
    abrirModalPagamento();
    return;
  }

  if (e.key === "F4") {
    e.preventDefault();
    const inputBusca = document.getElementById("busca-produto-pdv");
    if (inputBusca) {
      inputBusca.focus();
      inputBusca.select();
    }
    return;
  }

  if (e.key === "F5") {
    e.preventDefault();
    venderDinheiroExato();
    return;
  }

  if (e.key === "F9") {
    e.preventDefault();
    limparVendaAtual();
    return;
  }

  const elAtivo = document.activeElement;
  const digitando = Boolean(elAtivo && ["INPUT", "TEXTAREA", "SELECT"].includes(elAtivo.tagName));

  // Leitor de código de barras com o cursor fora da busca:
  // as teclas chegam muito rápidas (menos de 80 ms entre elas) e terminam em Enter
  if (!digitando) {
    const agora = performance.now();
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (agora - ultimaTeclaLeitor > 80) bufferLeitor = "";
      bufferLeitor += e.key;
      ultimaTeclaLeitor = agora;
      return;
    }
    if (e.key === "Enter" && bufferLeitor.length >= 4 && agora - ultimaTeclaLeitor < 150) {
      e.preventDefault();
      const codigo = bufferLeitor;
      bufferLeitor = "";
      lancarCodigoLido(codigo);
      return;
    }
    bufferLeitor = "";
  }

  if (elAtivo && elAtivo.tagName === "SELECT") return;

  if (["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) {
    if (elAtivo?.id === "busca-produto-pdv" && (e.key === "ArrowLeft" || e.key === "ArrowRight") && elAtivo.value.length > 0 && indiceFocoPDV === -1) {
      return;
    }
    e.preventDefault();
    moverFocoProdutoPDV(e.key);
    return;
  }

  if (e.key === "Enter" && elAtivo?.id !== "busca-produto-pdv" && indiceFocoPDV >= 0) {
    e.preventDefault();
    adicionarProdutoFocadoPDV();
  }
});

// Navegação por Teclado nos Cards do PDV (Inclui Faixa de Mais Vendidos primeiro)
function obterCardsPDV() {
  return Array.from(
    document.querySelectorAll("#faixa-mais-vendidos:not(.hidden) .produto-card, #grade-produtos-pdv .produto-card")
  );
}

function atualizarDestaqueCardPDV() {
  const cards = obterCardsPDV();
  if (indiceFocoPDV >= cards.length) {
    indiceFocoPDV = cards.length ? 0 : -1;
  }
  cards.forEach((card, i) => {
    if (i === indiceFocoPDV) {
      card.classList.add("foco-teclado");
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      card.classList.remove("foco-teclado");
    }
  });
}

function moverFocoProdutoPDV(tecla) {
  const cards = obterCardsPDV();
  if (!cards.length) {
    indiceFocoPDV = -1;
    return;
  }

  if (indiceFocoPDV === -1) {
    indiceFocoPDV = 0;
    atualizarDestaqueCardPDV();
    return;
  }

  if (tecla === "ArrowRight" || tecla === "ArrowDown") {
    indiceFocoPDV = (indiceFocoPDV + 1) % cards.length;
  } else if (tecla === "ArrowLeft" || tecla === "ArrowUp") {
    indiceFocoPDV = (indiceFocoPDV - 1 + cards.length) % cards.length;
  }

  atualizarDestaqueCardPDV();
}

function adicionarProdutoFocadoPDV() {
  const cards = obterCardsPDV();
  if (indiceFocoPDV >= 0 && indiceFocoPDV < cards.length) {
    cards[indiceFocoPDV].click();
  }
}

function aoDigitarBuscaPDV() {
  indiceFocoPDV = -1;
  carregarProdutos();
  const cards = obterCardsPDV();
  if (cards.length > 0 && lerBusca().termo !== "") {
    indiceFocoPDV = 0;
    atualizarDestaqueCardPDV();
  }
}

function processarTeclasBuscaPDV(e) {
  if (e.key !== "Enter") return;
  e.preventDefault();

  const { qtd, termo, termoNorm } = lerBusca();

  if (termoNorm) {
    const porCodigo = cacheProdutos.find(p => p.ativo && p.codigoInterno && semAcento(p.codigoInterno) === termoNorm);
    if (porCodigo) {
      adicionarProdutoPorId(porCodigo.id, qtd);
      limparBusca();
      return;
    }
  }

  const cards = obterCardsPDV();
  if (indiceFocoPDV >= 0 && indiceFocoPDV < cards.length) {
    cards[indiceFocoPDV].click();
  } else if (cards.length === 1) {
    cards[0].click();
    limparBusca();
  } else if (/^\d{4,}$/.test(termo)) {
    // Parece código de barras e não existe no catálogo
    tocarSom("erro");
    avisar(`Código ${termo} não encontrado no catálogo.`, { tipo: "erro" });
    document.getElementById("busca-produto-pdv")?.select();
  }
}

function focarInputSenha() {
  setTimeout(() => {
    const input = document.getElementById("input-senha-acesso");
    if (input) input.focus();
  }, 80);
}

// 4. AUTENTICAÇÃO TRANSACIONAL E BLOQUEIO (ESC)
function autenticarOperador(e) {
  if (e) e.preventDefault();
  const input = document.getElementById("input-senha-acesso");
  const senhaDigitada = input.value.trim();
  const msgErro = document.getElementById("msg-erro-login");
  if (!senhaDigitada) return;

  // Dados ainda chegando: guarda a senha e entra sozinho quando carregar
  if (!dadosDeLoginProntos()) {
    senhaPendente = senhaDigitada;
    msgErro.classList.add("hidden");
    mostrarCarregandoLogin();
    clearTimeout(timerSemConexao);
    timerSemConexao = setTimeout(() => {
      if (senhaPendente !== null) {
        mostrarCarregandoLogin("Ainda carregando… a conexão com a nuvem está lenta. Aguarde ou verifique a internet.", true);
      }
    }, 15000);
    return;
  }
  esconderCarregandoLogin();

  if (senhaDigitada === configMaster.senha) {
    usuarioLogado = { id: "admin", nome: configMaster.nome, isAdmin: true };
    liberarTerminal();
    return;
  }

  const operador = cacheUsuarios.find(u => u.senha === senhaDigitada && u.ativo !== false);
  if (operador) {
    usuarioLogado = { id: operador.id, nome: operador.nome, isAdmin: false };
    liberarTerminal();
  } else {
    msgErro.classList.remove("hidden");
    input.value = "";
    input.focus();
  }
}

function liberarTerminal() {
  limparCarrinho();
  categoriaAtivaPDV = "TODAS";
  subcategoriaAtivaPDV = "TODAS";
  indiceFocoPDV = -1;

  document.getElementById("input-senha-acesso").value = "";
  document.getElementById("msg-erro-login").classList.add("hidden");
  document.getElementById("modal-bloqueio").classList.remove("active");

  document.getElementById("badge-operador").innerHTML = `
    <i class="ri-user-3-line"></i> ${esc(usuarioLogado.nome)}
  `;

  const tabAdmin = document.getElementById("tab-admin");
  const tabDashboard = document.getElementById("tab-dashboard");

  if (usuarioLogado.isAdmin) {
    tabAdmin.classList.remove("hidden");
    tabDashboard.classList.remove("hidden");
    preencherCamposMaster();
    carregarOperadores();
  } else {
    tabAdmin.classList.add("hidden");
    tabDashboard.classList.add("hidden");
  }

  navegar("pdv", document.getElementById("tab-pdv"));
  verificarTurnoAbertoDoUsuario();
  carregarProdutos();
  carregarHistoricoTurnos();
  carregarAbaVendas();
  reiniciarTimerInatividade();
  if (usuarioLogado.isAdmin) preencherConfigPDV();
  focarBuscaPDV();
}

function bloquearCaixa() {
  clearTimeout(timerInatividade);
  if (resolverDialogo) resolverDialogo(false);
  limparCarrinho();
  cancelarEdicaoOperador();
  cancelarEdicaoProduto();
  fecharModalPagamento();
  fecharModalCancelamento();
  usuarioLogado = null;
  turnoAtivo = null;
  indiceFocoPDV = -1;

  document.getElementById("modal-pos-venda").classList.remove("active");
  document.getElementById("modal-bloqueio").classList.add("active");
  atualizarBarraAtalhos();
  focarInputSenha();
}

// 5. NAVEGAÇÃO ENTRE ABAS
function navegar(aba, btnElement) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));

  document.getElementById(`tela-${aba}`).classList.add("active");
  if (btnElement) btnElement.classList.add("active");

  if (aba === "vendas") carregarAbaVendas();
  if (aba === "turnos") carregarHistoricoTurnos();
  if (aba === "produtos") carregarProdutos();
  if (aba === "dashboard" && usuarioLogado?.isAdmin) renderizarDashboard();
  if (aba === "admin" && usuarioLogado?.isAdmin) {
    preencherCamposMaster();
    preencherConfigPDV();
    carregarOperadores();
  }
  atualizarBarraAtalhos();
  if (aba === "pdv") focarBuscaPDV();
}

// 6. GESTÃO DO ADMIN MASTER E EDIÇÃO DE OPERADORES
function preencherCamposMaster() {
  const inputNome = document.getElementById("admin-nome");
  const inputSenha = document.getElementById("admin-senha");
  if (inputNome && inputSenha) {
    inputNome.value = configMaster.nome;
    inputSenha.value = configMaster.senha;
  }
}

function salvarConfigMaster(e) {
  e.preventDefault();
  const novoNome = document.getElementById("admin-nome").value.trim();
  const novaSenha = document.getElementById("admin-senha").value.trim();

  const conflitoOperador = cacheUsuarios.some(u => u.senha === novaSenha && u.ativo !== false);
  if (conflitoOperador) {
    avisar("Esta senha já é usada por um operador. Escolha outra senha Master.", { tipo: "erro" });
    return;
  }

  setDoc(doc(db, "configuracoes", "master"), {
    nome: novoNome,
    senha: novaSenha
  });

  esconderCampoSenha("admin-senha");
  avisar("Perfil e senha Master atualizados.", { tipo: "sucesso" });
}

function prepararEdicaoOperador(id) {
  const op = cacheUsuarios.find(u => u.id === Number(id));
  if (!op) return;

  document.getElementById("op-id-edicao").value = op.id;
  document.getElementById("op-nome").value = op.nome;
  document.getElementById("op-senha").value = op.senha;

  document.getElementById("titulo-form-operador").innerHTML = `<i class="ri-edit-line"></i> Editando operador #${op.id}`;
  document.getElementById("btn-submit-operador").innerHTML = `<i class="ri-save-line"></i> Salvar alterações`;
  document.getElementById("btn-cancelar-edicao").classList.remove("hidden");
  document.getElementById("op-nome").focus();
}

function cancelarEdicaoOperador() {
  const form = document.getElementById("form-operador");
  if (form) form.reset();
  esconderCampoSenha("op-senha");
  const idInput = document.getElementById("op-id-edicao");
  if (idInput) idInput.value = "";

  const titulo = document.getElementById("titulo-form-operador");
  if (titulo) titulo.innerHTML = `<i class="ri-user-add-line"></i> Cadastrar novo operador`;

  const btnSubmit = document.getElementById("btn-submit-operador");
  if (btnSubmit) btnSubmit.innerHTML = `<i class="ri-user-follow-line"></i> Cadastrar operador`;

  const btnCancelar = document.getElementById("btn-cancelar-edicao");
  if (btnCancelar) btnCancelar.classList.add("hidden");
}

function salvarOperador(e) {
  e.preventDefault();
  const idEdicao = document.getElementById("op-id-edicao").value;
  const nome = document.getElementById("op-nome").value.trim();
  const senha = document.getElementById("op-senha").value.trim();

  if (senha === configMaster.senha) {
    avisar("Essa senha é do Admin Master. Escolha outra.", { tipo: "erro" });
    return;
  }

  const idNum = idEdicao ? Number(idEdicao) : null;
  const jaExiste = cacheUsuarios.some(u => u.senha === senha && u.ativo !== false && u.id !== idNum);
  if (jaExiste) {
    avisar("Outro operador já usa esta senha. Escolha uma senha exclusiva.", { tipo: "erro" });
    return;
  }

  if (idNum) {
    const opAtual = cacheUsuarios.find(u => u.id === idNum);
    setDoc(doc(db, "usuarios", String(idNum)), {
      ...opAtual,
      id: idNum,
      nome,
      senha,
      ativo: true
    });
    cancelarEdicaoOperador();
    avisar(`Operador ${nome} atualizado.`, { tipo: "sucesso" });
  } else {
    const novoId = gerarProximoId(cacheUsuarios);
    setDoc(doc(db, "usuarios", String(novoId)), {
      id: novoId,
      nome,
      senha,
      ativo: true
    });
    document.getElementById("form-operador").reset();
    avisar(`Operador ${nome} cadastrado.`, { tipo: "sucesso" });
  }
}

async function removerOperador(id) {
  const op = cacheUsuarios.find(u => u.id === Number(id));
  const ok = await confirmar({
    titulo: "Remover operador?",
    mensagem: `${op ? op.nome : "Este operador"} perde o acesso ao caixa. Os turnos e as vendas continuam no histórico.`,
    confirmarTexto: "Remover acesso",
    tipo: "perigo"
  });
  if (!ok) return;
  deleteDoc(doc(db, "usuarios", String(id)));
  if (Number(document.getElementById("op-id-edicao").value) === Number(id)) {
    cancelarEdicaoOperador();
  }
}

function carregarOperadores() {
  const container = document.getElementById("lista-operadores");
  if (!container) return;
  const operadores = [...cacheUsuarios].sort((a, b) => a.id - b.id);

  if (!operadores.length) {
    container.innerHTML = `<p class="vazio-texto">Nenhum operador cadastrado.</p>`;
    return;
  }

  const comTurnoAberto = new Set(cacheTurnos.filter(t => t.status === "ABERTO").map(t => String(t.usuarioId)));
  container.innerHTML = operadores.map(op => `
    <div class="linha-operador">
      <span class="avatar" aria-hidden="true">${esc((op.nome || "?").trim().charAt(0).toUpperCase())}</span>
      <div class="linha-operador-info">
        <strong>${esc(op.nome)}</strong>
        <span class="texto-suave">
          ID #${esc(op.id)} · Senha <span class="senha-valor mono" data-visivel="0">••••</span>
          <button type="button" class="link-btn" onclick="mostrarSenhaOperador(${Number(op.id)}, this)" title="Mostrar senha" aria-label="Mostrar senha"><i class="ri-eye-line"></i></button>
        </span>
      </div>
      ${comTurnoAberto.has(String(op.id)) ? `<span class="badge badge-open">Turno aberto</span>` : ""}
      <div class="acoes-linha">
        <button class="btn btn-secondary btn-sm" onclick="prepararEdicaoOperador(${Number(op.id)})">
          <i class="ri-edit-line"></i> Editar
        </button>
        <button class="btn btn-danger btn-sm" onclick="removerOperador(${Number(op.id)})">
          <i class="ri-delete-bin-line"></i> Excluir
        </button>
      </div>
    </div>
  `).join("");
}

// 7. CATÁLOGO DE PRODUTOS, FAIXA DE MAIS VENDIDOS E ORDENAÇÃO
function prepararEdicaoProduto(id) {
  const p = cacheProdutos.find(item => item.id === Number(id));
  if (!p) return;

  document.getElementById("prod-id-edicao").value = p.id;
  document.getElementById("prod-nome").value = p.nome;

  const selectCat = document.getElementById("prod-categoria");
  const categoriaValida = MAPA_CATEGORIAS[p.categoria] ? p.categoria : "Cigarros";
  selectCat.value = categoriaValida;
  atualizarSubcategoriasForm(p.subcategoria);

  document.getElementById("prod-preco").value = p.precoUnitario;
  document.getElementById("prod-codigo").value = p.codigoInterno || "";

  document.getElementById("titulo-form-produto").innerHTML = `<i class="ri-edit-line"></i> Editando produto #${p.id}`;
  document.getElementById("btn-submit-produto").innerHTML = `<i class="ri-save-line"></i> Atualizar`;
  document.getElementById("btn-cancelar-prod").classList.remove("hidden");
  document.getElementById("prod-nome").focus();
}

function cancelarEdicaoProduto() {
  const idInput = document.getElementById("prod-id-edicao");
  if (idInput) idInput.value = "";
  const nomeInput = document.getElementById("prod-nome");
  if (nomeInput) nomeInput.value = "";
  const precoInput = document.getElementById("prod-preco");
  if (precoInput) precoInput.value = "";
  const codInput = document.getElementById("prod-codigo");
  if (codInput) codInput.value = "";

  const titulo = document.getElementById("titulo-form-produto");
  if (titulo) titulo.innerHTML = `<i class="ri-add-circle-line"></i> Cadastrar produto no catálogo`;

  const btnSubmit = document.getElementById("btn-submit-produto");
  if (btnSubmit) btnSubmit.innerHTML = `<i class="ri-save-line"></i> Salvar`;

  const btnCancel = document.getElementById("btn-cancelar-prod");
  if (btnCancel) btnCancel.classList.add("hidden");
}

function salvarProduto(e) {
  e.preventDefault();
  const idEdicao = document.getElementById("prod-id-edicao").value;
  const nome = document.getElementById("prod-nome").value.trim();
  const categoria = document.getElementById("prod-categoria").value;
  const subcategoria = document.getElementById("prod-subcategoria").value;
  const precoUnitario = r2(parseFloat(document.getElementById("prod-preco").value));
  const codigoInterno = document.getElementById("prod-codigo").value.trim();

  const idFinal = idEdicao ? Number(idEdicao) : gerarProximoId(cacheProdutos);

  setDoc(doc(db, "produtos", String(idFinal)), {
    id: idFinal,
    nome,
    categoria,
    subcategoria,
    precoUnitario,
    codigoInterno,
    ativo: true
  });

  cancelarEdicaoProduto();
}

function selecionarCategoriaPDV(cat) {
  categoriaAtivaPDV = cat;
  subcategoriaAtivaPDV = "TODAS";
  indiceFocoPDV = -1;
  carregarProdutos();
}

function selecionarSubcategoriaPDV(sub) {
  subcategoriaAtivaPDV = sub;
  indiceFocoPDV = -1;
  carregarProdutos();
}

function renderizarFiltrosCategoriaPDV() {
  const barraCat = document.getElementById("barra-categorias-pdv");
  const barraSub = document.getElementById("barra-subcategorias-pdv");
  if (!barraCat || !barraSub) return;

  const categorias = ["TODAS", ...Object.keys(MAPA_CATEGORIAS)];
  barraCat.innerHTML = categorias.map(cat => `
    <button type="button" class="pill-btn ${cat === "TODAS" ? "" : classeCategoria(cat)} ${categoriaAtivaPDV === cat ? "active" : ""}" onclick="selecionarCategoriaPDV('${esc(cat)}')" aria-pressed="${categoriaAtivaPDV === cat}">
      ${cat === "TODAS" ? "Todos" : `<span class="ponto-cat"></span>${esc(cat)}`}
    </button>
  `).join("");

  if (categoriaAtivaPDV !== "TODAS" && MAPA_CATEGORIAS[categoriaAtivaPDV]) {
    const subs = ["TODAS", ...MAPA_CATEGORIAS[categoriaAtivaPDV]];
    barraSub.classList.remove("hidden");
    barraSub.innerHTML = subs.map(sub => `
      <button type="button" class="pill-btn ${subcategoriaAtivaPDV === sub ? "active" : ""}" onclick="selecionarSubcategoriaPDV('${esc(sub)}')" aria-pressed="${subcategoriaAtivaPDV === sub}">
        ${sub === "TODAS" ? "Todas as embalagens" : esc(sub)}
      </button>
    `).join("");
  } else {
    barraSub.classList.add("hidden");
  }
  requestAnimationFrame(atualizarFadePills);
}

function ordenarListaProdutos(lista, criterio) {
  const copia = [...lista];
  switch (criterio) {
    case "preco-desc":
      return copia.sort((a, b) => b.precoUnitario - a.precoUnitario);
    case "preco-asc":
      return copia.sort((a, b) => a.precoUnitario - b.precoUnitario);
    case "nome-desc":
      return copia.sort((a, b) => b.nome.localeCompare(a.nome, "pt-BR"));
    case "nome-asc":
    default:
      return copia.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }
}

// Card de produto: faixa e rótulo na cor da categoria, nome e preço grandes
function cardProdutoHTML(p, comCategoria = true) {
  const categoria = categoriaDe(p);
  const sub = p.subcategoria || "Diversos";
  const rotulo = comCategoria ? `${NOME_CURTO_CATEGORIA[categoria] || categoria} · ${sub}` : sub;
  return `
    <div class="produto-card ${classeCategoria(categoria)}" onclick="adicionarProdutoPorId(${Number(p.id)})" title="${esc(categoria)} · ${esc(sub)}">
      <span class="prod-cat-tag"><span class="rotulo-cat">${esc(rotulo)}</span></span>
      <strong>${esc(p.nome)}</strong>
      <span class="preco-tag">${fmt(p.precoUnitario)}</span>
    </div>
  `;
}

// FAIXA DO TOPO DO PDV: FAVORITOS (POSIÇÃO FIXA) OU, SEM FAVORITOS, OS MAIS VENDIDOS
function renderizarFaixaMaisVendidos() {
  const container = document.getElementById("faixa-mais-vendidos");
  if (!container) return;

  if (categoriaAtivaPDV !== "TODAS" || lerBusca().termo !== "") {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const ativosPorId = new Map(cacheProdutos.filter(p => p.ativo).map(p => [Number(p.id), p]));
  const favoritos = (configPDV.favoritos || []).map(id => ativosPorId.get(Number(id))).filter(Boolean);

  let lista;
  let titulo;
  let icone;
  let selo;

  if (favoritos.length) {
    lista = favoritos;
    titulo = "Favoritos";
    icone = "ri-star-fill";
    selo = `${favoritos.length}`;
  } else {
    // Considera apenas a janela em tempo real (últimos JANELA_TEMPO_REAL_DIAS dias)
    const contagemPorId = {};
    cacheVendas
      .filter(v => v.status === "CONCLUIDA")
      .forEach(v => {
        (v.itens || []).forEach(item => {
          const pid = Number(item.produtoId);
          if (!isNaN(pid)) {
            contagemPorId[pid] = (contagemPorId[pid] || 0) + (Number(item.quantidade) || 1);
          }
        });
      });

    lista = [...ativosPorId.values()]
      .filter(p => contagemPorId[p.id] > 0)
      .sort((a, b) => contagemPorId[b.id] - contagemPorId[a.id])
      .slice(0, 8);
    titulo = "Mais vendidos";
    icone = "ri-fire-fill";
    selo = `Top ${lista.length}`;
  }

  if (!lista.length) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  container.classList.remove("hidden");
  container.innerHTML = `
    <div class="mais-vendidos-header">
      <h3><i class="${icone}"></i> ${titulo}</h3>
      <span class="badge badge-user">${selo}</span>
    </div>
    <div class="mais-vendidos-grid-wrap">
      <div class="produtos-grid">${lista.map(p => cardProdutoHTML(p)).join("")}</div>
    </div>
  `;

  if (indiceFocoPDV >= 0) atualizarDestaqueCardPDV();
}

function carregarProdutos() {
  renderizarFiltrosCategoriaPDV();
  renderizarFaixaMaisVendidos();

  const { termoNorm } = lerBusca();
  const criterioOrdemPDV = document.getElementById("ordenacao-pdv")?.value || "nome-asc";
  const filtroCatCadastro = document.getElementById("filtro-cat-cadastro")?.value || "TODAS";
  const criterioOrdemCadastro = document.getElementById("ordenacao-cadastro")?.value || "nome-asc";

  const todosAtivos = cacheProdutos
    .filter(p => p.ativo)
    .map(p => ({
      ...p,
      categoria: categoriaDe(p),
      subcategoria: p.subcategoria || "Diversos"
    }));

  const filtradosPDV = todosAtivos.filter(p => {
    const bateCategoria = categoriaAtivaPDV === "TODAS" || p.categoria === categoriaAtivaPDV;
    const bateSubcategoria = subcategoriaAtivaPDV === "TODAS" || p.subcategoria === subcategoriaAtivaPDV;
    const bateBusca = !termoNorm ||
      semAcento(p.nome).includes(termoNorm) ||
      semAcento(p.categoria).includes(termoNorm) ||
      semAcento(p.subcategoria).includes(termoNorm) ||
      (p.codigoInterno && semAcento(p.codigoInterno).includes(termoNorm));
    return bateCategoria && bateSubcategoria && bateBusca;
  });

  renderizarGradePDV(filtradosPDV, criterioOrdemPDV);

  const termoCadastro = semAcento(document.getElementById("busca-cadastro")?.value || "").trim();
  const filtradosCadastro = todosAtivos.filter(p =>
    (filtroCatCadastro === "TODAS" || p.categoria === filtroCatCadastro) &&
    (!termoCadastro || semAcento(p.nome).includes(termoCadastro) ||
      (p.codigoInterno && semAcento(p.codigoInterno).includes(termoCadastro)))
  );

  renderizarListaCadastro(filtradosCadastro, criterioOrdemCadastro);
  renderizarFavoritosAdmin();
}

function desativarProduto(id) {
  const prod = cacheProdutos.find(p => p.id === Number(id));
  if (!prod) return;
  setDoc(doc(db, "produtos", String(prod.id)), { ...prod, ativo: false });
  avisar(`${prod.nome} saiu do catálogo.`, {
    acao: {
      rotulo: "Desfazer",
      fn: () => setDoc(doc(db, "produtos", String(prod.id)), { ...prod, ativo: true })
    }
  });
}

function renderizarGradePDV(produtos, criterioOrdem) {
  const container = document.getElementById("grade-produtos-pdv");
  if (!produtos.length) {
    const { termo } = lerBusca();
    container.innerHTML = `
      <div class="carrinho-vazio">
        <i class="ri-search-line"></i>
        <span>${termo ? `Nada encontrado para "${esc(termo)}".` : "Nenhum produto cadastrado nesta categoria."}</span>
      </div>`;
    indiceFocoPDV = -1;
    return;
  }

  const ordemCategorias = [
    ...Object.keys(MAPA_CATEGORIAS),
    ...new Set(produtos.map(p => p.categoria).filter(c => !MAPA_CATEGORIAS[c]))
  ];

  container.innerHTML = ordemCategorias.map(categoria => {
    const daCategoria = produtos.filter(p => p.categoria === categoria);
    if (!daCategoria.length) return "";

    // Em ordem de nome, os produtos ficam juntos por embalagem (Latinha, Latão, Long...)
    const ordemEmbalagens = MAPA_CATEGORIAS[categoria] || [];
    const posicao = sub => {
      const i = ordemEmbalagens.indexOf(sub);
      return i < 0 ? ordemEmbalagens.length : i;
    };
    const ordenados = ordenarListaProdutos(daCategoria, criterioOrdem);
    if (String(criterioOrdem).startsWith("nome")) {
      ordenados.sort((a, b) => posicao(a.subcategoria) - posicao(b.subcategoria));
    }

    const n = daCategoria.length;
    return `
      <section class="catalogo-secao ${classeCategoria(categoria)}">
        <div class="catalogo-secao-header">
          <h3><span class="ponto-cat"></span> ${esc(categoria)}</h3>
          <span class="badge badge-user">${n} ${n === 1 ? "item" : "itens"}</span>
        </div>
        <div class="catalogo-secao-body">
          <div class="produtos-grid">${ordenados.map(p => cardProdutoHTML(p, false)).join("")}</div>
        </div>
      </section>
    `;
  }).join("");

  if (indiceFocoPDV >= 0) atualizarDestaqueCardPDV();
}

function renderizarListaCadastro(produtos, criterioOrdem) {
  const container = document.getElementById("lista-produtos-cadastro");
  if (!produtos.length) {
    container.innerHTML = `<p class="vazio-texto">Nenhum produto encontrado com esse filtro.</p>`;
    return;
  }

  const favoritos = new Set((configPDV.favoritos || []).map(Number));
  const ordemCategorias = [
    ...Object.keys(MAPA_CATEGORIAS),
    ...new Set(produtos.map(p => p.categoria).filter(c => !MAPA_CATEGORIAS[c]))
  ];

  container.innerHTML = ordemCategorias.map(categoria => {
    const itensCat = ordenarListaProdutos(
      produtos.filter(p => p.categoria === categoria),
      criterioOrdem
    );
    if (!itensCat.length) return "";

    const linhasHTML = itensCat.map(p => {
      const favorito = favoritos.has(Number(p.id));
      const rotuloEstrela = favorito ? "Tirar dos favoritos" : "Adicionar aos favoritos";
      return `
      <div class="item-carrinho ${classeCategoria(categoria)}">
        <div>
          <span class="prod-cat-tag">${esc(p.subcategoria)}</span>
          <strong>${esc(p.nome)}</strong> ${p.codigoInterno ? `<small class="mono esc-hint">[${esc(p.codigoInterno)}]</small>` : ""}
          <div class="preco-lista mono">${fmt(p.precoUnitario)}</div>
        </div>
        <div class="acoes-linha">
          <button type="button" class="btn-estrela ${favorito ? "ativa" : ""}" onclick="alternarFavorito(${Number(p.id)})" title="${rotuloEstrela}" aria-label="${rotuloEstrela}" aria-pressed="${favorito}">
            <i class="${favorito ? "ri-star-fill" : "ri-star-line"}"></i>
          </button>
          <button class="btn btn-secondary btn-sm" onclick="prepararEdicaoProduto(${Number(p.id)})">
            <i class="ri-edit-line"></i> Editar
          </button>
          <button class="btn btn-danger btn-sm" onclick="desativarProduto(${Number(p.id)})">Remover</button>
        </div>
      </div>
    `;
    }).join("");

    return `
      <div class="catalogo-secao ${classeCategoria(categoria)}">
        <div class="catalogo-secao-header">
          <h3><span class="ponto-cat"></span> ${esc(categoria)}</h3>
          <span class="badge badge-user">${itensCat.length}</span>
        </div>
        <div class="catalogo-secao-body">
          ${linhasHTML}
        </div>
      </div>
    `;
  }).join("");
}

// 8. PAGAMENTO (ÚNICO OU DIVIDIDO), TROCO E FINALIZAÇÃO
async function abrirModalPagamento() {
  if (!usuarioLogado || !turnoAtivo || !carrinho.length) return;
  if (document.getElementById("modal-pagamento").classList.contains("active")) return;
  if (!(await confirmarMaioridadeSeNecessario())) return;

  pagamentoPassoAtual = 1;
  pagamentoFormaSelecionada = null;
  pagamentoValorParcialAtual = 0;
  pagamentosParciaisVenda = [];

  atualizarInterfaceModalPagamento();
  document.getElementById("modal-pagamento").classList.add("active");
}

// Cigarro e cerveja: pergunta uma vez por venda, na hora de pagar
async function confirmarMaioridadeSeNecessario() {
  if (idadeConfirmadaNestaVenda) return true;
  const restritos = carrinho.filter(item => {
    const produto = cacheProdutos.find(p => p.id === Number(item.produtoId));
    return produto && CATEGORIAS_MAIORIDADE.includes(categoriaDe(produto));
  });
  if (!restritos.length) return true;

  const nomes = restritos.slice(0, 3).map(i => i.nomeSnapshot).join(", ") + (restritos.length > 3 ? "…" : "");
  const ok = await confirmar({
    titulo: "Venda para maiores de 18",
    mensagem: `${nomes}. O cliente tem 18 anos ou mais?`,
    confirmarTexto: "Sim, continuar",
    cancelarTexto: "Não",
    tipo: "alerta"
  });
  if (ok) {
    idadeConfirmadaNestaVenda = true;
  } else {
    avisar("Venda não liberada. Retire os itens para maiores de 18 para continuar.", { tipo: "alerta" });
  }
  return ok;
}

function fecharModalPagamento() {
  document.getElementById("modal-pagamento").classList.remove("active");
  pagamentoPassoAtual = 1;
  pagamentoFormaSelecionada = null;
  pagamentoValorParcialAtual = 0;
  pagamentosParciaisVenda = [];
  vendaEmAlteracao = null;
  alteracaoOrigem = null;
}

// Esc / Cancelar: na alteração aberta pela venda concluída, volta para ela
function cancelarPagamento() {
  const voltarParaVendaConcluida = Boolean(vendaEmAlteracao && alteracaoOrigem === "pos-venda");
  fecharModalPagamento();
  if (voltarParaVendaConcluida && ultimaVendaObjeto) mostrarPosVenda(ultimaVendaObjeto);
}

// Total que está sendo pago: o do carrinho ou, na alteração, o da venda (fixo)
function totalEmPagamento() {
  return vendaEmAlteracao ? r2(vendaEmAlteracao.valorFinal) : calcularTotalVendaCarrinho();
}

function calcularTotalVendaCarrinho() {
  return r2(carrinho.reduce((acc, i) => acc + i.subtotal, 0));
}

function calcularValorPagoParcialmente() {
  return r2(pagamentosParciaisVenda.reduce((acc, p) => acc + p.valor, 0));
}

function calcularRestante() {
  return r2(Math.max(0, totalEmPagamento() - calcularValorPagoParcialmente()));
}

function atualizarInterfaceModalPagamento() {
  const totalVenda = totalEmPagamento();

  // Título e contexto mudam quando é a alteração de uma venda já concluída
  const titulo = document.getElementById("titulo-pagamento");
  const contexto = document.getElementById("pagamento-contexto");
  if (titulo) titulo.textContent = vendaEmAlteracao ? "Alterar pagamento" : "Pagamento";
  if (contexto) {
    if (vendaEmAlteracao) {
      contexto.innerHTML = `Venda #${esc(vendaEmAlteracao.id)} das ${formatarHora(vendaEmAlteracao.dataHora)} · forma atual: <strong>${esc(descricaoPagamentos(pagamentosDaVenda(vendaEmAlteracao)))}</strong>. O valor de ${fmt(vendaEmAlteracao.valorFinal)} não muda.`;
      contexto.classList.remove("hidden");
    } else {
      contexto.innerHTML = "";
      contexto.classList.add("hidden");
    }
  }
  const totalPago = calcularValorPagoParcialmente();
  const restante = r2(Math.max(0, totalVenda - totalPago));

  document.getElementById("pag-val-total").textContent = fmt(totalVenda);
  document.getElementById("pag-val-pago").textContent = fmt(totalPago);
  document.getElementById("pag-val-restante").textContent = fmt(restante);

  const listaEl = document.getElementById("lista-pagamentos-parciais");
  listaEl.innerHTML = pagamentosParciaisVenda.map((p, idx) => `
    <div class="parcial-item-tag mono">
      <span>${esc(p.forma)}${p.bandeira ? ` (${esc(p.bandeira)})` : ""}: ${fmt(p.valor)}${p.troco > 0 ? ` · troco ${fmt(p.troco)}` : ""}</span>
      <button type="button" class="btn btn-secondary btn-sm" onclick="removerPagamentoParcial(${idx})" aria-label="Remover este pagamento">✕</button>
    </div>
  `).join("");

  const btnConcluir = document.getElementById("btn-concluir-pagamento-misto");
  const passo1El = document.getElementById("pagamento-passo-1");
  const passoValorEl = document.getElementById("pagamento-passo-valor");
  const passo2El = document.getElementById("pagamento-passo-2");

  passo1El.classList.add("hidden");
  passoValorEl.classList.add("hidden");
  passo2El.classList.add("hidden");

  if (pagamentoPassoAtual === 1) {
    passo1El.classList.remove("hidden");
    document.getElementById("subtitulo-passo-pag").textContent = pagamentosParciaisVenda.length
      ? `Falta ${fmt(restante)}. Escolha a próxima forma:`
      : vendaEmAlteracao
        ? "Escolha a nova forma de pagamento (F5 = dinheiro):"
        : "Escolha a forma de pagamento (F5 = dinheiro exato):";
    btnConcluir.classList.toggle("hidden", restante > 0.005);
  } else if (pagamentoPassoAtual === 1.1) {
    passoValorEl.classList.remove("hidden");
    const emDinheiro = pagamentoFormaSelecionada === "DINHEIRO";
    document.getElementById("label-valor-parcial").textContent = emDinheiro
      ? "Quanto o cliente entregou? Toque numa nota ou digite o valor."
      : `Valor no ${NOME_FORMA[pagamentoFormaSelecionada] || "pagamento"}. Enter confirma o valor que falta.`;

    const notasEl = document.getElementById("notas-rapidas");
    if (emDinheiro) {
      notasSugeridas = sugerirNotas(restante);
      notasEl.innerHTML = [
        `<button type="button" class="nota-btn" onclick="confirmarValorParcial(${restante})"><small>Exato · Enter</small><b>${fmt(restante)}</b></button>`,
        ...notasSugeridas.map((valor, i) =>
          `<button type="button" class="nota-btn" onclick="confirmarValorParcial(${valor})"><small>F${6 + i}</small><b>${fmt(valor)}</b></button>`
        )
      ].join("");
      notasEl.classList.remove("hidden");
    } else {
      notasSugeridas = [];
      notasEl.innerHTML = "";
      notasEl.classList.add("hidden");
    }

    document.getElementById("erro-valor-parcial").classList.add("hidden");
    const inputVal = document.getElementById("input-valor-parcial");
    inputVal.value = restante.toFixed(2);
    atualizarPreviaTroco();
    setTimeout(() => { inputVal.focus(); inputVal.select(); }, 50);
  } else if (pagamentoPassoAtual === 2) {
    passo2El.classList.remove("hidden");
  }
}

// Mostra o troco (ou quanto ainda falta) enquanto o valor recebido é digitado
function atualizarPreviaTroco() {
  const previa = document.getElementById("previa-troco");
  if (!previa) return;
  if (pagamentoPassoAtual !== 1.1 || pagamentoFormaSelecionada !== "DINHEIRO") {
    previa.classList.add("hidden");
    return;
  }

  document.getElementById("erro-valor-parcial").classList.add("hidden");
  const restante = calcularRestante();
  const valor = r2(parseFloat(document.getElementById("input-valor-parcial").value) || 0);
  previa.classList.remove("troco", "falta");
  if (valor <= 0) {
    previa.classList.add("hidden");
    return;
  }
  previa.classList.remove("hidden");
  if (valor >= restante) {
    previa.classList.add("troco");
    previa.innerHTML = `<span>Troco</span><strong>${fmt(valor - restante)}</strong>`;
  } else {
    previa.classList.add("falta");
    previa.innerHTML = `<span>Ainda falta (outra forma)</span><strong>${fmt(restante - valor)}</strong>`;
  }
}

function selecionarFormaPagamento(forma) {
  if (calcularRestante() <= 0.005) return;
  pagamentoFormaSelecionada = forma;
  pagamentoPassoAtual = 1.1;
  atualizarInterfaceModalPagamento();
}

function voltarParaEscolhaForma() {
  pagamentoPassoAtual = 1;
  pagamentoFormaSelecionada = null;
  pagamentoValorParcialAtual = 0;
  atualizarInterfaceModalPagamento();
}

// Em dinheiro, aceita valor maior que o total e registra o troco.
// PIX e cartão não podem passar do que falta.
function confirmarValorParcial(valorDireto = null) {
  const inputVal = document.getElementById("input-valor-parcial");
  const erroEl = document.getElementById("erro-valor-parcial");
  const forma = pagamentoFormaSelecionada;
  const valorDigitado = r2(valorDireto !== null ? Number(valorDireto) : (parseFloat(inputVal.value) || 0));
  const restante = calcularRestante();

  const mostrarErro = (mensagem) => {
    erroEl.textContent = mensagem;
    erroEl.classList.remove("hidden");
    tocarSom("erro");
    inputVal.focus();
    inputVal.select();
  };

  if (!forma) return;
  if (valorDigitado <= 0) {
    mostrarErro("Digite um valor maior que zero.");
    return;
  }

  if (forma === "DINHEIRO") {
    const aplicado = r2(Math.min(valorDigitado, restante));
    const troco = r2(Math.max(0, valorDigitado - restante));
    if (troco > 1000) {
      mostrarErro(`O troco seria de ${fmt(troco)}. Confira o valor recebido.`);
      return;
    }
    pagamentosParciaisVenda.push({ forma, bandeira: null, valor: aplicado, recebido: valorDigitado, troco });
    voltarParaEscolhaForma();
    concluirSePago();
    return;
  }

  if (valorDigitado > restante + 0.005) {
    mostrarErro(`No ${NOME_FORMA[forma]}, o valor não pode passar do que falta (${fmt(restante)}).`);
    return;
  }

  if (forma === "PIX") {
    pagamentosParciaisVenda.push({ forma, bandeira: null, valor: valorDigitado });
    voltarParaEscolhaForma();
    concluirSePago();
    return;
  }

  pagamentoValorParcialAtual = valorDigitado;
  pagamentoPassoAtual = 2;
  const bandeiras = BANDEIRAS_PAGAMENTO[forma] || [];
  document.getElementById("pagamento-titulo-bandeira").textContent = forma === "CREDITO"
    ? `Crédito (1x) de ${fmt(valorDigitado)}: escolha a bandeira`
    : `Débito de ${fmt(valorDigitado)}: escolha a bandeira`;
  document.getElementById("pagamento-lista-bandeiras").innerHTML = bandeiras.map((bandeira, idx) => `
    <button type="button" class="btn-pag-opcao" onclick="selecionarBandeiraPagamento('${esc(bandeira)}')">
      <span class="tecla-badge mono">${idx + 1}</span>
      <span>${esc(bandeira)}</span>
    </button>
  `).join("");
  atualizarInterfaceModalPagamento();
}

function selecionarBandeiraPagamento(bandeira) {
  if (!pagamentoFormaSelecionada || pagamentoValorParcialAtual <= 0) return;
  pagamentosParciaisVenda.push({
    forma: pagamentoFormaSelecionada,
    bandeira,
    valor: pagamentoValorParcialAtual
  });
  voltarParaEscolhaForma();
  concluirSePago();
}

function removerPagamentoParcial(index) {
  pagamentosParciaisVenda.splice(index, 1);
  voltarParaEscolhaForma();
}

// Quando o valor informado cobre o total, a venda fecha sozinha (sem outro F2)
function concluirSePago() {
  if (pagamentosParciaisVenda.length && calcularRestante() <= 0.005) {
    concluirPagamento();
  }
}

function concluirPagamento() {
  if (vendaEmAlteracao) salvarAlteracaoPagamento();
  else finalizarVendaComposta();
}

function pagarRestanteEmDinheiro() {
  if (calcularRestante() <= 0.005) return;
  pagamentoFormaSelecionada = "DINHEIRO";
  confirmarValorParcial(calcularRestante());
}

// F5: fecha a venda em dinheiro, valor exato, sem abrir a tela de pagamento
async function venderDinheiroExato() {
  if (!usuarioLogado || !turnoAtivo || !carrinho.length) return;
  if (document.getElementById("modal-pagamento").classList.contains("active")) return;
  if (!(await confirmarMaioridadeSeNecessario())) return;
  const total = calcularTotalVendaCarrinho();
  pagamentosParciaisVenda = [{ forma: "DINHEIRO", bandeira: null, valor: total, recebido: total, troco: 0 }];
  finalizarVendaComposta();
}

function finalizarVendaComposta() {
  if (!usuarioLogado || !turnoAtivo || !carrinho.length) return;

  const totalVenda = calcularTotalVendaCarrinho();
  const totalPago = calcularValorPagoParcialmente();
  if (Math.abs(totalVenda - totalPago) > 0.01) {
    tocarSom("erro");
    avisar("O valor informado ainda não cobre o total da venda.", { tipo: "erro" });
    return;
  }

  const pagamentosFinalizados = montarPagamentos(pagamentosParciaisVenda);
  const trocoTotal = r2(pagamentosFinalizados.reduce((acc, p) => acc + (p.troco || 0), 0));
  const valorBruto = totalVenda;
  const valorFinal = valorBruto;
  const itensVenda = carrinho.map(i => ({ ...i, subtotal: r2(i.subtotal) }));

  fecharModalPagamento();

  const novoId = gerarIdUnico();
  const venda = {
    id: novoId,
    turnoId: turnoAtivo.id,
    usuarioId: usuarioLogado.id,
    operadorNome: usuarioLogado.nome,
    dataHora: Date.now(),
    valorBruto,
    desconto: 0,
    valorFinal,
    pagamentos: pagamentosFinalizados,
    formaPagamento: pagamentosFinalizados.length === 1 ? pagamentosFinalizados[0].forma : "MISTO",
    bandeira: pagamentosFinalizados.length === 1 ? pagamentosFinalizados[0].bandeira : null,
    parcelas: 1,
    troco: trocoTotal,
    status: "CONCLUIDA",
    itens: itensVenda
  };

  setDoc(doc(db, "vendas", String(novoId)), venda)
    .catch(erro => console.error("Erro ao salvar a venda:", erro));

  ultimaVendaId = novoId;
  ultimaVendaObjeto = venda;
  mostrarPosVenda(venda);
}

// Tela de venda concluída: troco em destaque, total, forma de pagamento e impressão
function mostrarPosVenda(venda) {
  const troco = r2(Number(venda.troco) || 0);
  const trocoBox = document.getElementById("troco-pos-venda");
  if (troco > 0) {
    document.getElementById("troco-pos-venda-valor").textContent = fmt(troco);
    trocoBox.classList.remove("hidden");
  } else {
    trocoBox.classList.add("hidden");
  }

  document.getElementById("resumo-modal-venda").innerHTML = `
    <div class="resumo-total"><span>Total</span><strong>${fmt(venda.valorFinal)}</strong></div>
    <div class="resumo-modal-pagamento">Venda #${esc(venda.id)} · ${esc(formatarPagamentoTexto(venda))}</div>
  `;
  document.getElementById("modal-pos-venda").classList.add("active");
  document.getElementById("btn-confirmar-impressao").focus();
}

function confirmarImpressaoPosVenda(desejaImprimir) {
  document.getElementById("modal-pos-venda").classList.remove("active");

  // A configuração do admin decide se pede a senha de novo depois de cada venda
  const depois = () => {
    if (configPDV.bloquearAposVenda) bloquearCaixa();
    else prepararProximaVenda();
  };

  if (desejaImprimir && ultimaVendaId) {
    imprimirCupomVenda80mm(ultimaVendaId, depois);
  } else {
    depois();
  }
}

function prepararProximaVenda() {
  limparCarrinho();
  limparBusca();
  focarBuscaPDV();
}

// 9. ABA DE VENDAS E CANCELAMENTO COM AUDITORIA (ADMIN VS. OPERADOR)
function podeCancelarVenda(venda) {
  if (!usuarioLogado || venda.status === "CANCELADA") return false;
  if (usuarioLogado.isAdmin) return true;
  return Boolean(turnoAtivo && mesmoId(venda.turnoId, turnoAtivo.id) && mesmoId(venda.usuarioId, usuarioLogado.id));
}

// ALTERAR A FORMA DE PAGAMENTO SEM MUDAR O VALOR
// Mesma regra do cancelamento: o operador só mexe nas vendas do próprio turno aberto; o admin, em qualquer uma
function podeAlterarPagamento(venda) {
  return Boolean(venda && venda.status === "CONCLUIDA" && podeCancelarVenda(venda));
}

// O Firebase não aceita campos "undefined": cada pagamento é montado campo a campo
function montarPagamentos(lista) {
  return lista.map(p => {
    const pagamento = { forma: p.forma, bandeira: p.bandeira ?? null, valor: r2(p.valor) };
    if (p.forma === "DINHEIRO") {
      pagamento.recebido = r2(p.recebido ?? p.valor);
      pagamento.troco = r2(p.troco ?? 0);
    }
    return pagamento;
  });
}

// "Dinheiro", "Crédito Visa", "Débito Master + PIX"
function descricaoPagamentos(pagamentos) {
  return (pagamentos || []).map(p => `${ROTULO_FORMA[p.forma] || p.forma}${p.bandeira ? ` ${p.bandeira}` : ""}`).join(" + ");
}

function abrirAlteracaoPagamento(vendaId, origem = "lista") {
  let v = buscarVenda(vendaId);
  if (!v && ultimaVendaObjeto && mesmoId(ultimaVendaObjeto.id, vendaId)) v = ultimaVendaObjeto;
  if (!podeAlterarPagamento(v)) {
    avisar("O pagamento desta venda não pode ser alterado.", { tipo: "alerta" });
    return;
  }

  document.getElementById("modal-pos-venda").classList.remove("active");
  vendaEmAlteracao = v;
  alteracaoOrigem = origem;
  pagamentoPassoAtual = 1;
  pagamentoFormaSelecionada = null;
  pagamentoValorParcialAtual = 0;
  pagamentosParciaisVenda = [];
  atualizarInterfaceModalPagamento();
  document.getElementById("modal-pagamento").classList.add("active");
}

// F2 na tela de venda concluída: corrige a forma que acabou de ser registrada
function alterarPagamentoUltimaVenda() {
  if (ultimaVendaId) abrirAlteracaoPagamento(ultimaVendaId, "pos-venda");
}

// Grava a venda e mantém em dia a cópia das vendas antigas (fora da janela em tempo real)
function gravarVenda(venda) {
  setDoc(doc(db, "vendas", String(venda.id)), venda).catch(erro => {
    console.error("Erro ao salvar a venda:", erro);
    avisar("Não foi possível salvar a alteração na nuvem.", { tipo: "erro" });
  });
  if (vendasAntigas.has(String(venda.id))) {
    vendasAntigas.set(String(venda.id), venda);
    carregarAbaVendas();
    carregarHistoricoTurnos();
  }
}

function salvarAlteracaoPagamento() {
  const v = vendaEmAlteracao;
  const origem = alteracaoOrigem;
  if (!v) return;

  if (Math.abs(r2(v.valorFinal) - calcularValorPagoParcialmente()) > 0.01) {
    tocarSom("erro");
    avisar("O valor informado precisa ser igual ao total da venda.", { tipo: "erro" });
    return;
  }

  const novos = montarPagamentos(pagamentosParciaisVenda);
  const antigos = montarPagamentos(pagamentosDaVenda(v));
  fecharModalPagamento();

  const assinatura = lista => JSON.stringify(lista.map(p => [p.forma, p.bandeira, p.valor, p.recebido ?? null]));
  if (assinatura(novos) === assinatura(antigos)) {
    avisar("A forma de pagamento já era essa. Nada foi alterado.", { tipo: "info" });
    if (origem === "pos-venda") mostrarPosVenda(v);
    return;
  }

  const vendaAlterada = {
    ...v,
    pagamentos: novos,
    formaPagamento: novos.length === 1 ? novos[0].forma : "MISTO",
    bandeira: novos.length === 1 ? novos[0].bandeira : null,
    troco: r2(novos.reduce((acc, p) => acc + (p.troco || 0), 0)),
    alteracoesPagamento: [
      ...(Array.isArray(v.alteracoesPagamento) ? v.alteracoesPagamento : []),
      {
        de: antigos,
        para: novos,
        por: usuarioLogado.nome,
        porAdmin: Boolean(usuarioLogado.isAdmin),
        dataHora: Date.now()
      }
    ]
  };
  gravarVenda(vendaAlterada);
  if (mesmoId(ultimaVendaId, v.id)) ultimaVendaObjeto = vendaAlterada;

  avisar(`Pagamento alterado para ${descricaoPagamentos(novos)}. O valor continua ${fmt(v.valorFinal)}.`, {
    tipo: "sucesso",
    acao: {
      rotulo: "Desfazer",
      fn: () => {
        // Só desfaz a forma de pagamento; uma venda cancelada nesse meio-tempo continua cancelada
        const atual = buscarVenda(v.id) || vendaAlterada;
        if (atual.status !== "CONCLUIDA") {
          avisar("A venda foi cancelada depois da alteração. Não dá mais para desfazer.", { tipo: "alerta" });
          return;
        }
        const restaurada = {
          ...atual,
          pagamentos: antigos,
          formaPagamento: v.formaPagamento ?? (antigos.length === 1 ? antigos[0].forma : "MISTO"),
          bandeira: v.bandeira ?? null,
          troco: r2(Number(v.troco) || 0),
          alteracoesPagamento: (Array.isArray(atual.alteracoesPagamento) ? atual.alteracoesPagamento : []).slice(0, -1)
        };
        gravarVenda(restaurada);
        if (mesmoId(ultimaVendaId, v.id)) ultimaVendaObjeto = restaurada;
      }
    }
  });

  if (origem === "pos-venda") mostrarPosVenda(vendaAlterada);
}

// Na lista de vendas: quem alterou, quando e qual era a forma antes
function notaAlteracaoHTML(v) {
  const alteracoes = Array.isArray(v.alteracoesPagamento) ? v.alteracoesPagamento : [];
  if (!alteracoes.length) return "";
  const ultima = alteracoes[alteracoes.length - 1];
  const vezes = alteracoes.length > 1 ? ` · ${alteracoes.length} alterações` : "";
  return `
    <div class="nota-alteracao">
      <i class="ri-arrow-left-right-line"></i> Pagamento alterado por ${esc(ultima.por || "?")} em ${formatarDataCurta(ultima.dataHora)} · antes: ${esc(descricaoPagamentos(ultima.de))}${vezes}
    </div>`;
}

function limparFiltrosVendas() {
  const fData = document.getElementById("filtro-vendas-data");
  const fPag = document.getElementById("filtro-vendas-pagamento");
  const fStat = document.getElementById("filtro-vendas-status");
  if (fData) fData.value = "";
  if (fPag) fPag.value = "TODOS";
  if (fStat) fStat.value = "TODAS";
  carregarAbaVendas();
}

function carregarAbaVendas() {
  if (!usuarioLogado) return;
  const container = document.getElementById("lista-vendas-registradas");
  if (!container) return;

  const filtroData = document.getElementById("filtro-vendas-data")?.value || "";
  const filtroPag = document.getElementById("filtro-vendas-pagamento")?.value || "TODOS";
  const filtroStatus = document.getElementById("filtro-vendas-status")?.value || "TODAS";

  // Data fora da janela em tempo real: busca no banco e redesenha quando chegar
  if (filtroData) {
    garantirVendasDoDia(filtroData).then(carregou => { if (carregou) carregarAbaVendas(); });
  }

  // Sem filtro de data: mostra a janela em tempo real (últimos JANELA_TEMPO_REAL_DIAS dias)
  let vendas = (filtroData ? todasVendas() : [...cacheVendas])
    .filter(v => {
      if (usuarioLogado.isAdmin) return true;
      if (!mesmoId(v.usuarioId, usuarioLogado.id)) return false;
      if (v.status === "CANCELADA" && v.constarNoFechamento === false) return false;
      return true;
    })
    .sort((a, b) => b.dataHora - a.dataHora);

  if (filtroData) {
    vendas = vendas.filter(v => dataLocalISO(v.dataHora) === filtroData);
  }
  if (filtroPag !== "TODOS") {
    if (filtroPag === "MISTO") {
      vendas = vendas.filter(v => v.pagamentos && v.pagamentos.length > 1);
    } else {
      vendas = vendas.filter(v => {
        if (v.pagamentos && v.pagamentos.length === 1) return v.pagamentos[0].forma === filtroPag;
        return v.formaPagamento === filtroPag;
      });
    }
  }
  if (filtroStatus !== "TODAS") {
    vendas = vendas.filter(v => v.status === filtroStatus);
  }

  // Resumo do que está na tela
  const resumo = resumoDasVendas(vendas);
  const resumoEl = document.getElementById("resumo-vendas");
  if (resumoEl) {
    const formas = Object.entries(resumo.porForma).filter(([, valor]) => valor > 0);
    resumoEl.innerHTML = vendas.length ? `
      <div class="resumo-item"><span>Vendas</span><strong class="mono">${resumo.qtd}</strong></div>
      <div class="resumo-item"><span>Total</span><strong class="mono">${fmt(resumo.total)}</strong></div>
      <div class="resumo-item"><span>Ticket médio</span><strong class="mono">${fmt(resumo.ticket)}</strong></div>
      ${resumo.canceladas ? `<div class="resumo-item alerta"><span>Canceladas</span><strong class="mono">${resumo.canceladas}</strong></div>` : ""}
      <div class="resumo-formas">
        ${formas.map(([forma, valor]) => `<span class="chip-pag pag-${forma.toLowerCase()}"><i class="${ICONE_FORMA[forma]}"></i>${ROTULO_FORMA[forma]} <b class="mono">${fmt(valor)}</b></span>`).join("")}
      </div>
    ` : "";
  }

  if (!vendas.length) {
    container.innerHTML = `
      <div class="estado-vazio">
        <i class="ri-receipt-line"></i>
        <span>Nenhuma venda encontrada para este filtro.</span>
      </div>`;
    return;
  }

  // Agrupa por dia: "Hoje", "Ontem", "Terça-feira"...
  const grupos = new Map();
  vendas.forEach(v => {
    const dia = dataLocalISO(v.dataHora);
    if (!grupos.has(dia)) grupos.set(dia, []);
    grupos.get(dia).push(v);
  });

  container.innerHTML = [...grupos.entries()].map(([dia, lista]) => {
    const doDia = resumoDasVendas(lista);
    return `
      <div class="grupo-dia">
        <div class="grupo-dia-titulo">
          <span>${esc(rotuloDia(dia))}</span>
          <span class="mono">${doDia.qtd} ${doDia.qtd === 1 ? "venda" : "vendas"} · ${fmt(doDia.total)}</span>
        </div>
        ${lista.map(linhaVendaHTML).join("")}
      </div>
    `;
  }).join("");
}

function linhaVendaHTML(v) {
  const cancelada = v.status === "CANCELADA";
  const ocultaNoCaixa = cancelada && v.constarNoFechamento === false;
  const nomeOperador = obterNomePerfil(v.usuarioId, v.operadorNome);
  const itens = (v.itens || []).map(i => `${i.quantidade}× ${i.nomeSnapshot}`).join(", ");
  const quando = v.dataHoraCancelamento ? ` às ${formatarHora(v.dataHoraCancelamento)}` : "";

  return `
    <div class="venda-linha-v2 ${cancelada ? "cancelada" : ""}">
      <div class="venda-hora mono">${formatarHora(v.dataHora)}</div>
      <div class="venda-corpo">
        <div class="venda-itens">${esc(itens)}</div>
        <div class="venda-meta">
          ${chipsPagamentoHTML(v)}
          ${cancelada ? `<span class="badge badge-closed">Cancelada</span>` : ""}
          ${ocultaNoCaixa && usuarioLogado.isAdmin ? `<span class="badge badge-oculta">Oculta no caixa</span>` : ""}
          <span class="texto-suave">${esc(nomeOperador)} · #${esc(v.id)}</span>
        </div>
        ${notaAlteracaoHTML(v)}
        ${cancelada ? `
          <div class="motivo-cancelamento">
            <i class="ri-close-circle-line"></i> Cancelada por ${esc(v.canceladoPor || "Sistema")}${quando} · ${esc(v.motivoCancelamento || "Sem motivo informado")}
          </div>
        ` : ""}
      </div>
      <strong class="venda-valor mono">${fmt(v.valorFinal)}</strong>
      <div class="venda-acoes">
        <button type="button" class="btn btn-secondary btn-sm" onclick="imprimirCupomVenda80mm('${esc(v.id)}')" title="Imprimir 2ª via">
          <i class="ri-printer-line"></i><span class="rotulo">2ª via</span>
        </button>
        ${podeAlterarPagamento(v) ? `
          <button type="button" class="btn btn-secondary btn-sm" onclick="abrirAlteracaoPagamento('${esc(v.id)}')" title="Alterar a forma de pagamento (o valor não muda)">
            <i class="ri-arrow-left-right-line"></i><span class="rotulo">Alterar pagamento</span>
          </button>
        ` : ""}
        ${podeCancelarVenda(v) ? `
          <button type="button" class="btn btn-danger btn-sm" onclick="abrirModalCancelamento('${esc(v.id)}')" title="Cancelar venda">
            <i class="ri-close-circle-line"></i><span class="rotulo">Cancelar</span>
          </button>
        ` : ""}
      </div>
    </div>
  `;
}

function abrirModalCancelamento(vendaId) {
  const v = buscarVenda(vendaId);
  if (!v || !podeCancelarVenda(v)) return;

  document.getElementById("cancelar-venda-id").value = v.id;
  document.getElementById("cancelar-venda-motivo").value = "";
  document.getElementById("cancelar-venda-info").textContent =
    `Venda #${v.id} — ${fmt(v.valorFinal)} (${formatarPagamentoTexto(v)}). Informe o motivo do cancelamento:`;

  const boxAdmin = document.getElementById("box-admin-constar-fechamento");
  const checkConstar = document.getElementById("cancelar-constar-fechamento");
  if (usuarioLogado.isAdmin) {
    boxAdmin.classList.remove("hidden");
    checkConstar.checked = false;
  } else {
    boxAdmin.classList.add("hidden");
    checkConstar.checked = true;
  }

  document.getElementById("modal-cancelar-venda").classList.add("active");
  setTimeout(() => document.getElementById("cancelar-venda-motivo").focus(), 60);
}

function fecharModalCancelamento() {
  document.getElementById("modal-cancelar-venda").classList.remove("active");
}

function confirmarCancelamentoVenda(e) {
  if (e) e.preventDefault();
  const vendaId = document.getElementById("cancelar-venda-id").value;
  const motivo = document.getElementById("cancelar-venda-motivo").value.trim();

  const v = buscarVenda(vendaId);
  if (!v || !podeCancelarVenda(v)) {
    fecharModalCancelamento();
    return;
  }

  const constarNoFechamento = usuarioLogado.isAdmin
    ? Boolean(document.getElementById("cancelar-constar-fechamento").checked)
    : true;

  const vendaCancelada = {
    ...v,
    status: "CANCELADA",
    constarNoFechamento,
    motivoCancelamento: motivo || "Cancelamento operacional",
    canceladoPor: usuarioLogado.nome,
    canceladoPorAdmin: Boolean(usuarioLogado.isAdmin),
    dataHoraCancelamento: Date.now()
  };
  setDoc(doc(db, "vendas", String(v.id)), vendaCancelada);

  // Vendas fora da janela em tempo real não recebem atualização automática
  if (vendasAntigas.has(String(v.id))) {
    vendasAntigas.set(String(v.id), vendaCancelada);
    carregarAbaVendas();
    carregarHistoricoTurnos();
  }

  fecharModalCancelamento();
}

// 10. DASHBOARD ANALÍTICO
function limparFiltroDashboard() {
  const inputData = document.getElementById("filtro-data-dashboard");
  if (inputData) inputData.value = "";
  renderizarDashboard();
}

function renderizarDashboard() {
  if (!usuarioLogado?.isAdmin) return;

  const filtroData = document.getElementById("filtro-data-dashboard")?.value || "";

  // Data fora da janela em tempo real: busca no banco e redesenha quando chegar
  if (filtroData) {
    garantirVendasDoDia(filtroData).then(carregou => { if (carregou) renderizarDashboard(); });
  }

  // Sem filtro: últimos JANELA_TEMPO_REAL_DIAS dias
  let vendasConcluidas = (filtroData ? todasVendas() : cacheVendas).filter(v => v.status === "CONCLUIDA");
  if (filtroData) {
    vendasConcluidas = vendasConcluidas.filter(v => dataLocalISO(v.dataHora) === filtroData);
  }

  const resumo = resumoDasVendas(vendasConcluidas);
  let totalItensVendidos = 0;
  const vendasPorHora = Array(24).fill(0);
  const rankingProdutos = {};

  vendasConcluidas.forEach(v => {
    vendasPorHora[new Date(v.dataHora).getHours()] += 1;
    (v.itens || []).forEach(item => {
      totalItensVendidos += item.quantidade;
      rankingProdutos[item.nomeSnapshot] = (rankingProdutos[item.nomeSnapshot] || 0) + item.quantidade;
    });
  });

  const maxVendasHora = Math.max(...vendasPorHora);
  const indicePico = maxVendasHora > 0 ? vendasPorHora.indexOf(maxVendasHora) : -1;
  // Hora do pico grande e a quantidade menor ao lado, para caber numa linha
  const textoPico = indicePico >= 0
    ? `${String(indicePico).padStart(2, "0")}h <small>${maxVendasHora} ${maxVendasHora === 1 ? "venda" : "vendas"}</small>`
    : "---";

  document.getElementById("kpi-faturamento").textContent = fmt(resumo.total);
  document.getElementById("kpi-qtd-vendas").textContent = String(resumo.qtd);
  document.getElementById("kpi-ticket-medio").textContent = fmt(resumo.ticket);
  document.getElementById("kpi-itens-vendidos").textContent = String(totalItensVendidos);
  document.getElementById("kpi-hora-pico").innerHTML = textoPico;

  const top10 = Object.entries(rankingProdutos)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (typeof Chart === "undefined") return;

  // Cores do gráfico seguem o tema (claro ou escuro)
  const estiloTema = getComputedStyle(document.documentElement);
  const corTema = nome => estiloTema.getPropertyValue(nome).trim();
  const comAlfa = (variavelRGB, alfa) => `rgba(${corTema(variavelRGB)}, ${alfa})`;
  Chart.defaults.color = corTema("--text-muted");
  Chart.defaults.borderColor = corTema("--border");
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  const dicas = {
    backgroundColor: corTema("--surface"),
    titleColor: corTema("--text"),
    bodyColor: corTema("--text"),
    borderColor: corTema("--border-strong"),
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
    displayColors: false
  };

  // Vendas por hora: o horário de pico em destaque
  const ctxPicos = document.getElementById("chart-picos")?.getContext("2d");
  if (ctxPicos) {
    if (chartInstanciaPicos) chartInstanciaPicos.destroy();
    chartInstanciaPicos = new Chart(ctxPicos, {
      type: "bar",
      data: {
        labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}h`),
        datasets: [{
          label: "Vendas",
          data: vendasPorHora,
          backgroundColor: vendasPorHora.map((_, h) => h === indicePico ? corTema("--accent") : comAlfa("--accent-rgb", 0.35)),
          hoverBackgroundColor: corTema("--accent"),
          borderRadius: 6,
          maxBarThickness: 30
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { ...dicas, callbacks: { label: c => `${c.parsed.y} ${c.parsed.y === 1 ? "venda" : "vendas"}` } }
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 } }
        }
      }
    });
  }

  // Produtos mais vendidos
  const ctxProdutos = document.getElementById("chart-produtos")?.getContext("2d");
  if (ctxProdutos) {
    if (chartInstanciaProdutos) chartInstanciaProdutos.destroy();
    chartInstanciaProdutos = new Chart(ctxProdutos, {
      type: "bar",
      data: {
        labels: top10.length ? top10.map(item => item[0]) : ["Sem vendas"],
        datasets: [{
          label: "Unidades",
          data: top10.length ? top10.map(item => item[1]) : [0],
          backgroundColor: corTema("--success"),
          hoverBackgroundColor: corTema("--success"),
          borderRadius: 6,
          maxBarThickness: 26
        }]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { ...dicas, callbacks: { label: c => `${c.parsed.x} un.` } }
        },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 } },
          y: { grid: { display: false } }
        }
      }
    });
  }

  // Formas de pagamento: quanto entrou em cada uma
  const formas = ["DINHEIRO", "PIX", "CREDITO", "DEBITO"];
  const valores = formas.map(f => resumo.porForma[f]);
  const totalFormas = valores.reduce((acc, v) => acc + v, 0);
  const temValores = totalFormas > 0;
  const ctxFormas = document.getElementById("chart-formas")?.getContext("2d");
  if (ctxFormas) {
    if (chartInstanciaFormas) chartInstanciaFormas.destroy();
    chartInstanciaFormas = new Chart(ctxFormas, {
      type: "doughnut",
      data: {
        labels: formas.map(f => ROTULO_FORMA[f]),
        datasets: [{
          data: temValores ? valores : [1],
          backgroundColor: temValores
            ? [corTema("--success"), corTema("--info"), corTema("--accent"), corTema("--warning")]
            : [corTema("--surface-3")],
          borderColor: corTema("--surface"),
          borderWidth: 3,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              usePointStyle: true,
              pointStyle: "circle",
              padding: 14,
              generateLabels: chart => {
                const base = Chart.overrides.doughnut.plugins.legend.labels.generateLabels(chart);
                return base.map((item, i) => ({ ...item, text: temValores ? `${item.text} · ${fmt(valores[i])}` : "Sem vendas no período" }))
                  .slice(0, temValores ? base.length : 1);
              }
            }
          },
          tooltip: {
            ...dicas,
            callbacks: {
              label: c => temValores ? `${c.label}: ${fmt(c.parsed)} (${Math.round((c.parsed / totalFormas) * 100)}%)` : "Sem vendas"
            }
          }
        }
      }
    });
  }
}

// 11. TURNOS INDEPENDENTES POR USUÁRIO
function obterTurnoAbertoDoUsuario(usuarioId) {
  // Se houver mais de um aberto (ex.: legado), usa o mais recente
  return cacheTurnos
    .filter(t => t.status === "ABERTO" && mesmoId(t.usuarioId, usuarioId))
    .sort((a, b) => b.dataHoraAbertura - a.dataHoraAbertura)[0] || null;
}

function verificarTurnoAbertoDoUsuario() {
  if (!usuarioLogado) return;
  turnoAtivo = obterTurnoAbertoDoUsuario(usuarioLogado.id);
  atualizarStatusTurnoUI();
}

async function abrirTurno(tipoTurno, conferido = false) {
  if (!usuarioLogado || abrindoTurno) return;

  // Botão do período errado para a hora (ex.: "Abrir manhã" às 15h): oferece o certo
  const escolhido = periodosDoTurno({ tipoTurno })[0];
  if (!conferido && escolhido && !periodoCombinaComHora(escolhido, Date.now()) && !obterTurnoAbertoDoUsuario(usuarioLogado.id)) {
    const certo = periodoDaHora();
    const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const ok = await confirmar({
      titulo: `Abrir como ${certo.toLowerCase()}?`,
      mensagem: `Agora são ${hora}, horário da ${certo.toLowerCase()} ${rotuloPeriodos([certo]).split(" ")[1]}. Você clicou em ${escolhido.toLowerCase()}.`,
      confirmarTexto: `Abrir ${certo.toLowerCase()}`,
      cancelarTexto: "Voltar",
      tipo: "alerta"
    });
    if (ok) abrirTurno(rotuloPeriodos([certo]), true);
    return;
  }

  const turnoExistente = obterTurnoAbertoDoUsuario(usuarioLogado.id);
  if (turnoExistente) {
    avisar(`Você já tem um turno aberto (${turnoExistente.tipoTurno}). Encerre esse turno antes de abrir outro.`, { tipo: "alerta" });
    turnoAtivo = turnoExistente;
    atualizarStatusTurnoUI();
    return;
  }

  abrindoTurno = true;
  document.querySelectorAll(".turno-actions button").forEach(b => { b.disabled = true; });

  const novoId = gerarIdUnico();
  const novoTurno = {
    id: novoId,
    usuarioId: usuarioLogado.id,
    operadorNome: usuarioLogado.nome,
    tipoTurno,
    periodos: periodosDoTurno({ tipoTurno }),
    dataHoraAbertura: Date.now(),
    dataHoraFechamento: null,
    status: "ABERTO"
  };

  // Ativa localmente na hora, sem esperar a resposta da nuvem
  turnoAtivo = novoTurno;
  if (!cacheTurnos.some(t => mesmoId(t.id, novoId))) cacheTurnos.push(novoTurno);
  atualizarStatusTurnoUI();
  focarBuscaPDV();

  setDoc(doc(db, "turnos", String(novoId)), novoTurno)
    .catch(erro => console.error("Erro ao abrir turno:", erro))
    .finally(() => {
      abrindoTurno = false;
      document.querySelectorAll(".turno-actions button").forEach(b => { b.disabled = false; });
    });
}

// Quem vai ficar mais um período continua no mesmo caixa, sem fechar e abrir outro
async function estenderTurno() {
  if (!turnoAtivo) return;
  const prox = proximoPeriodo(turnoAtivo);
  if (!prox) {
    avisar("Este turno já cobre o máximo de períodos. Encerre-o para abrir um novo.", { tipo: "alerta" });
    return;
  }
  const periodos = [...periodosDoTurno(turnoAtivo), prox.nome];
  const novoRotulo = rotuloPeriodos(periodos);
  const confirmou = await confirmar({
    titulo: `Estender o turno para a ${prox.nome.toLowerCase()}?`,
    mensagem: `O caixa continua aberto como "${novoRotulo}". As vendas seguem somando no mesmo turno e, no fim, sai um fechamento só, com o total separado por período.`,
    confirmarTexto: "Estender turno",
    cancelarTexto: "Voltar"
  });
  if (!confirmou || !turnoAtivo) return;

  const extensoes = [...(turnoAtivo.extensoes || []), {
    para: prox.nome,
    dataHora: Date.now(),
    por: usuarioLogado?.nome || ""
  }];
  const mudancas = { periodos, tipoTurno: novoRotulo, extensoes };
  Object.assign(turnoAtivo, mudancas);
  const noCache = cacheTurnos.find(t => mesmoId(t.id, turnoAtivo.id));
  if (noCache && noCache !== turnoAtivo) Object.assign(noCache, mudancas);
  atualizarStatusTurnoUI();
  avisar(`Turno estendido: ${novoRotulo}. Pode continuar vendendo normalmente.`, { tipo: "sucesso" });

  setDoc(doc(db, "turnos", String(turnoAtivo.id)), mudancas, { merge: true })
    .catch(erro => {
      console.error("Erro ao estender turno:", erro);
      avisar("Não foi possível salvar a extensão do turno na nuvem. Tente de novo.", { tipo: "erro" });
    });
}

// Aviso no PDV quando o período do turno está acabando
function atualizarAvisoFimTurno() {
  const aviso = document.getElementById("aviso-fim-turno");
  const tela = document.getElementById("tela-pdv");
  if (!aviso || !tela) return;
  let mostrar = false;
  const btn = document.getElementById("btn-aviso-estender");
  const btnEncerrar = document.getElementById("btn-aviso-encerrar");
  const sugerido = turnoAtivo ? periodoSugeridoSeErrado(turnoAtivo) : null;
  const chaveErrado = turnoAtivo ? `errado:${turnoAtivo.id}:${turnoAtivo.tipoTurno}` : "";
  if (sugerido && aviso.dataset.dispensado !== chaveErrado) {
    const hora = new Date(turnoAtivo.dataHoraAbertura).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    aviso.dataset.chave = chaveErrado;
    document.getElementById("aviso-fim-texto").innerHTML =
      `<strong>Turno aberto como ${esc(periodosDoTurno(turnoAtivo)[0].toLowerCase())} às ${hora}.</strong> Esse horário é da ${sugerido.toLowerCase()}. Corrija sem fechar o caixa.`;
    btn.classList.remove("hidden");
    btn.innerHTML = `<i class="ri-edit-line"></i> Corrigir para ${sugerido.toLowerCase()}`;
    btn.onclick = () => corrigirPeriodoTurno(sugerido);
    btnEncerrar.classList.add("hidden");
    aviso.classList.remove("hidden");
    tela.classList.add("com-aviso-fim");
    medirAvisoFimTurno();
    return;
  }
  btn.onclick = () => estenderTurno();
  btnEncerrar.classList.remove("hidden");
  if (turnoAtivo && !sugerido) {
    const fins = finsDosPeriodos(turnoAtivo);
    const fim = fins[fins.length - 1];
    const chave = `${turnoAtivo.id}:${fins.length}`;
    if (fim && Date.now() >= fim - 15 * 60000 && aviso.dataset.dispensado !== chave) {
      mostrar = true;
      const agora = Date.now();
      const passou = agora >= fim;
      // Esquecido aberto: nem estendendo cobriria a hora atual
      const esquecido = agora >= fim + 8 * 3600000;
      const prox = esquecido ? null : proximoPeriodo(turnoAtivo);
      const quando = quandoTexto(fim);
      aviso.dataset.chave = chave;
      document.getElementById("aviso-fim-texto").innerHTML = esquecido
        ? `<strong>Este turno ficou aberto: terminou ${quando}.</strong> Encerre para fechar o caixa e depois abra o turno de agora.`
        : passou
          ? `<strong>O seu turno terminou ${quando}.</strong> Vai continuar no caixa? Estenda o turno ou encerre para o próximo operador.`
          : `<strong>O seu turno termina ${quando}.</strong> Vai ficar mais um período? Estenda sem fechar o caixa.`;
      btnEncerrar.classList.toggle("btn-primary", esquecido);
      btnEncerrar.classList.toggle("btn-secondary", !esquecido);
      btn.classList.toggle("hidden", !prox);
      if (prox) btn.innerHTML = `<i class="ri-add-circle-line"></i> Estender para a ${prox.nome.toLowerCase()}`;
    }
  }
  aviso.classList.toggle("hidden", !mostrar);
  tela.classList.toggle("com-aviso-fim", mostrar);
  if (mostrar) medirAvisoFimTurno();
}

// "às 22:00", "ontem às 22:00" ou "em 25/11 às 22:00"
function quandoTexto(ts) {
  const d = new Date(ts);
  const hora = `às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const dia = new Date(d); dia.setHours(0, 0, 0, 0);
  const diff = Math.round((hoje - dia) / 86400000);
  if (diff === 0) return hora;
  if (diff === 1) return `ontem ${hora}`;
  return `em ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${hora}`;
}

// A grade do PDV desconta a altura real do aviso (o texto pode quebrar em 2 linhas)
function medirAvisoFimTurno() {
  const aviso = document.getElementById("aviso-fim-turno");
  if (aviso && !aviso.classList.contains("hidden") && aviso.offsetHeight) {
    document.documentElement.style.setProperty("--altura-aviso", `${aviso.offsetHeight}px`);
  }
}
window.addEventListener("resize", medirAvisoFimTurno);

function dispensarAvisoFimTurno() {
  const aviso = document.getElementById("aviso-fim-turno");
  if (!aviso) return;
  aviso.dataset.dispensado = aviso.dataset.chave || "";
  atualizarAvisoFimTurno();
}

function irParaEncerrarTurno() {
  navegar("turnos", document.getElementById("tab-turnos"));
}

// Corrige o período de um turno aberto no botão errado, sem fechar o caixa
async function corrigirPeriodoTurno(nome) {
  if (!turnoAtivo || !PERIODOS.some(p => p.nome === nome)) return;
  const atual = periodosDoTurno(turnoAtivo);
  const periodos = sequenciaDePeriodos(nome, Math.max(1, atual.length));
  const novoRotulo = rotuloPeriodos(periodos);
  if (novoRotulo === turnoAtivo.tipoTurno) return;
  const confirmou = await confirmar({
    titulo: `Corrigir para ${novoRotulo}?`,
    mensagem: `O turno está como "${turnoAtivo.tipoTurno}". O caixa continua aberto e as vendas não mudam: só o período do turno é corrigido, e a correção fica registrada.`,
    confirmarTexto: "Corrigir período",
    cancelarTexto: "Voltar"
  });
  if (!confirmou || !turnoAtivo) return;

  const correcoesPeriodo = [...(turnoAtivo.correcoesPeriodo || []), {
    de: turnoAtivo.tipoTurno,
    para: novoRotulo,
    dataHora: Date.now(),
    por: usuarioLogado?.nome || ""
  }];
  const mudancas = { periodos, tipoTurno: novoRotulo, correcoesPeriodo };
  Object.assign(turnoAtivo, mudancas);
  const noCache = cacheTurnos.find(t => mesmoId(t.id, turnoAtivo.id));
  if (noCache && noCache !== turnoAtivo) Object.assign(noCache, mudancas);
  painelCorrecaoAberto = false;
  atualizarStatusTurnoUI();
  avisar(`Turno corrigido para ${novoRotulo}.`, { tipo: "sucesso" });

  setDoc(doc(db, "turnos", String(turnoAtivo.id)), mudancas, { merge: true })
    .catch(erro => {
      console.error("Erro ao corrigir período:", erro);
      avisar("Não foi possível salvar a correção na nuvem. Tente de novo.", { tipo: "erro" });
    });
}

function alternarCorrecaoPeriodo() {
  painelCorrecaoAberto = !painelCorrecaoAberto;
  renderizarInfoTurno();
}

async function fecharTurnoAtual(modoImpressao = null) {
  if (!turnoAtivo) return;

  const vendasDoTurno = cacheVendas.filter(v => mesmoId(v.turnoId, turnoAtivo.id) && v.status === "CONCLUIDA");
  const totalDoTurno = r2(vendasDoTurno.reduce((acc, v) => acc + v.valorFinal, 0));
  const confirmou = await confirmar({
    titulo: `Encerrar o turno ${turnoAtivo.tipoTurno}?`,
    mensagem: `${vendasDoTurno.length} ${vendasDoTurno.length === 1 ? "venda" : "vendas"} · total ${fmt(totalDoTurno)}. Depois de encerrado, o turno não pode ser reaberto.`,
    confirmarTexto: "Encerrar turno",
    tipo: "perigo"
  });
  if (!confirmou || !turnoAtivo) return;

  const turnoFechado = {
    ...turnoAtivo,
    operadorNome: obterNomePerfil(turnoAtivo.usuarioId, turnoAtivo.operadorNome),
    status: "FECHADO",
    dataHoraFechamento: Date.now()
  };

  setDoc(doc(db, "turnos", String(turnoFechado.id)), turnoFechado);
  limparCarrinho();

  if (modoImpressao === "vendas" || modoImpressao === "produtos") {
    setTimeout(() => imprimirRelatorioTurno80mm(turnoFechado.id, modoImpressao, turnoFechado), 150);
  }
}

function atualizarStatusTurnoUI() {
  const badge = document.getElementById("status-turno-badge");
  const aviso = document.getElementById("aviso-turno-fechado");
  const pdvArea = document.getElementById("area-operacao-pdv");

  if (turnoAtivo) {
    badge.innerHTML = `Caixa aberto · ${rotuloTurnoHTML(turnoAtivo.tipoTurno)}`;
    badge.className = "badge badge-open";
    aviso.classList.add("hidden");
    pdvArea.classList.remove("hidden");
  } else {
    badge.textContent = "Caixa fechado";
    badge.className = "badge badge-closed";
    marcarPeriodoSugerido();
    aviso.classList.remove("hidden");
    pdvArea.classList.add("hidden");
  }

  renderizarInfoTurno();
  atualizarAvisoFimTurno();
  atualizarBarraAtalhos();
}

// Painel "Meu turno em andamento": números do turno, totais por forma e ações
function renderizarInfoTurno() {
  const infoTurno = document.getElementById("info-turno-atual");
  if (!infoTurno || !usuarioLogado) return;

  if (!turnoAtivo) {
    infoTurno.innerHTML = `
      <div class="estado-vazio">
        <i class="ri-time-line"></i>
        <span>Você não tem turno aberto. Abra o caixa na aba PDV.</span>
      </div>`;
    return;
  }

  const modoAnterior = document.getElementById("modo-encerrar")?.value ?? "vendas";
  const resumo = resumoDasVendas(cacheVendas.filter(v => mesmoId(v.turnoId, turnoAtivo.id)));
  const nomeAtual = obterNomePerfil(turnoAtivo.usuarioId, turnoAtivo.operadorNome);
  const maiorForma = Math.max(1, ...Object.values(resumo.porForma));
  const formas = ["DINHEIRO", "PIX", "CREDITO", "DEBITO"];

  infoTurno.innerHTML = `
    <div class="turno-topo">
      <span class="badge badge-open">Aberto</span>
      ${periodosDoTurno(turnoAtivo).length > 1 ? `<span class="badge badge-dobra"><i class="ri-repeat-line"></i> Dobra</span>` : ""}
      <strong>${esc(turnoAtivo.tipoTurno)}</strong>
      <span class="texto-suave">${esc(nomeAtual)} · desde ${formatarDataCurta(turnoAtivo.dataHoraAbertura)} · ${duracaoTexto(Date.now() - turnoAtivo.dataHoraAbertura)}</span>
      <button type="button" class="link-btn link-corrigir" onclick="alternarCorrecaoPeriodo()"><i class="ri-edit-line"></i> Corrigir período</button>
    </div>
    ${painelCorrecaoAberto ? `
    <div class="corrigir-periodo">
      <span class="rotulo-grupo">Abriu no período errado? O turno começa na:</span>
      ${PERIODOS.map(p => `<button type="button" class="btn ${p.nome === periodosDoTurno(turnoAtivo)[0] ? "btn-secondary" : "btn-primary"}" ${p.nome === periodosDoTurno(turnoAtivo)[0] ? "disabled" : ""} onclick="corrigirPeriodoTurno('${p.nome}')">${p.nome.charAt(0) + p.nome.slice(1).toLowerCase()} <small>${HORA_2(p.inicio)}-${HORA_2(p.fim)}</small></button>`).join("")}
      <button type="button" class="link-btn" onclick="alternarCorrecaoPeriodo()">Cancelar</button>
    </div>` : ""}

    <div class="kpi-grid kpi-turno">
      <div class="kpi-card kpi-teal"><span>Vendas</span><strong>${resumo.qtd}</strong></div>
      <div class="kpi-card kpi-purple"><span>Total do turno</span><strong class="mono">${fmt(resumo.total)}</strong></div>
      <div class="kpi-card kpi-blue"><span>Ticket médio</span><strong class="mono">${fmt(resumo.ticket)}</strong></div>
      <div class="kpi-card kpi-amber"><span>Recebido em dinheiro</span><strong class="mono">${fmt(resumo.porForma.DINHEIRO)}</strong></div>
    </div>

    <div class="formas-turno">
      ${formas.map(f => `
        <div class="forma-linha pag-${f.toLowerCase()}">
          <span class="forma-nome"><i class="${ICONE_FORMA[f]}"></i> ${ROTULO_FORMA[f]}</span>
          <span class="forma-barra"><i style="width: ${Math.round((resumo.porForma[f] / maiorForma) * 100)}%"></i></span>
          <strong class="mono">${fmt(resumo.porForma[f])}</strong>
        </div>
      `).join("")}
      ${resumo.canceladas ? `<p class="texto-suave">${resumo.canceladas} ${resumo.canceladas === 1 ? "venda cancelada" : "vendas canceladas"} neste turno, fora dos totais.</p>` : ""}
    </div>

    ${blocoPeriodosHTML(turnoAtivo, cacheVendas)}

    <div class="turno-acoes">
      ${proximoPeriodo(turnoAtivo) ? `
      <div class="grupo-acoes">
        <span class="rotulo-grupo">Vai ficar mais um período?</span>
        <button class="btn btn-primary" onclick="estenderTurno()">
          <i class="ri-add-circle-line"></i> Estender para a ${proximoPeriodo(turnoAtivo).nome.toLowerCase()}
        </button>
      </div>` : ""}
      <div class="grupo-acoes">
        <span class="rotulo-grupo">Imprimir parcial</span>
        <button class="btn btn-secondary" onclick="imprimirRelatorioTurno80mm('${esc(turnoAtivo.id)}', 'vendas')">
          <i class="ri-printer-line"></i> Por vendas
        </button>
        <button class="btn btn-secondary" onclick="imprimirRelatorioTurno80mm('${esc(turnoAtivo.id)}', 'produtos')">
          <i class="ri-list-check-2"></i> Por produtos
        </button>
      </div>
      <div class="grupo-acoes">
        <label class="rotulo-grupo" for="modo-encerrar">Ao encerrar, imprimir</label>
        <select id="modo-encerrar">
          <option value="vendas">Por vendas</option>
          <option value="produtos">Por produtos</option>
          <option value="">Não imprimir</option>
        </select>
        <button class="btn btn-danger-solid" onclick="encerrarTurnoSelecionado()">
          <i class="ri-lock-password-line"></i> Encerrar turno
        </button>
      </div>
    </div>
  `;

  const select = document.getElementById("modo-encerrar");
  if (select) select.value = modoAnterior;
}

// Total de cada período de um turno dobrado (vendas separadas pelo horário de fim de cada período)
function totaisPorPeriodo(t, vendas) {
  const lista = periodosDoTurno(t);
  if (lista.length < 2) return [];
  const fins = finsDosPeriodos(t);
  const totais = lista.map(nome => ({ nome, qtd: 0, total: 0 }));
  vendas.filter(v => mesmoId(v.turnoId, t.id) && v.status === "CONCLUIDA").forEach(v => {
    let i = fins.findIndex(f => v.dataHora < f);
    if (i < 0) i = lista.length - 1;
    totais[i].qtd += 1;
    totais[i].total = r2(totais[i].total + v.valorFinal);
  });
  return totais;
}

function blocoPeriodosHTML(t, vendas) {
  const totais = totaisPorPeriodo(t, vendas);
  if (!totais.length) return "";
  return `
    <div class="periodos-turno">
      ${totais.map(p => `
        <div class="periodo-item">
          <span>${esc(p.nome)}</span>
          <strong class="mono">${fmt(p.total)}</strong>
          <small>${p.qtd} ${p.qtd === 1 ? "venda" : "vendas"}</small>
        </div>`).join("")}
    </div>`;
}

function encerrarTurnoSelecionado() {
  const modo = document.getElementById("modo-encerrar")?.value || "";
  fecharTurnoAtual(modo || null);
}

// 12. CARRINHO
// Adiciona pelo ID do produto (nome e preço vêm do catálogo, nunca do HTML).
// Sem quantidade informada, usa o multiplicador da busca ("6*").
function adicionarProdutoPorId(produtoId, qtd = null) {
  const p = cacheProdutos.find(item => item.id === Number(produtoId) && item.ativo);
  if (!p) return;
  const busca = lerBusca();
  const quantidade = qtd ?? busca.qtd;
  const sub = p.subcategoria || "Diversos";
  adicionarAoCarrinho(p.id, `${p.nome} (${sub})`, p.precoUnitario, quantidade);
  if (busca.temMultiplicador) limparBusca();
}

// Código lido pelo leitor com o cursor fora da busca
function lancarCodigoLido(codigo) {
  const texto = String(codigo).trim();
  const alvo = semAcento(texto);
  const produto = cacheProdutos.find(p => p.ativo && p.codigoInterno && semAcento(p.codigoInterno) === alvo);
  if (!produto) {
    tocarSom("erro");
    avisar(`Código ${texto} não encontrado no catálogo.`, { tipo: "erro" });
    return false;
  }
  adicionarProdutoPorId(produto.id);
  return true;
}

function adicionarAoCarrinho(produtoId, nomeSnapshot, precoUnitarioSnapshot, quantidade = 1) {
  const qtd = Math.max(1, Math.round(Number(quantidade) || 1));
  const itemExistente = carrinho.find(i => i.produtoId === produtoId);
  if (itemExistente) {
    itemExistente.quantidade += qtd;
    itemExistente.subtotal = r2(itemExistente.quantidade * itemExistente.precoUnitarioSnapshot);
  } else {
    carrinho.push({
      produtoId,
      nomeSnapshot,
      precoUnitarioSnapshot,
      quantidade: qtd,
      subtotal: r2(qtd * precoUnitarioSnapshot)
    });
  }
  ultimoProdutoAdicionado = produtoId;
  tocarSom("ok");
  atualizarCarrinhoUI();
}

function alterarQtdItem(index, delta) {
  const item = carrinho[index];
  if (!item) return;
  const novaQuantidade = item.quantidade + delta;
  if (novaQuantidade <= 0) {
    removerItemCarrinho(index);
    return;
  }
  item.quantidade = novaQuantidade;
  item.subtotal = r2(item.quantidade * item.precoUnitarioSnapshot);
  if (delta > 0) ultimoProdutoAdicionado = item.produtoId;
  atualizarCarrinhoUI();
}

// Remover não pergunta nada: o aviso traz "Desfazer"
function removerItemCarrinho(index) {
  const [removido] = carrinho.splice(index, 1);
  if (!removido) return;
  const sessao = sessaoCarrinho;
  atualizarCarrinhoUI();
  avisar(`${removido.nomeSnapshot} saiu da venda.`, {
    acao: {
      rotulo: "Desfazer",
      fn: () => {
        if (sessao !== sessaoCarrinho) return;
        carrinho.splice(Math.min(index, carrinho.length), 0, removido);
        ultimoProdutoAdicionado = removido.produtoId;
        atualizarCarrinhoUI();
      }
    }
  });
}

// Esvazia o carrinho (uso interno: depois da venda, ao bloquear, ao entrar)
function limparCarrinho() {
  carrinho = [];
  idadeConfirmadaNestaVenda = false;
  sessaoCarrinho += 1;
  atualizarCarrinhoUI();
}

// F9 / botão Limpar: esvazia a venda, com "Desfazer"
function limparVendaAtual() {
  if (!carrinho.length) return;
  const copia = carrinho.map(i => ({ ...i }));
  const idadeConfirmada = idadeConfirmadaNestaVenda;
  limparCarrinho();
  const sessao = sessaoCarrinho;
  avisar(`Venda limpa (${copia.length} ${copia.length === 1 ? "item" : "itens"}).`, {
    acao: {
      rotulo: "Desfazer",
      fn: () => {
        if (sessao !== sessaoCarrinho || carrinho.length) return;
        carrinho = copia;
        idadeConfirmadaNestaVenda = idadeConfirmada;
        atualizarCarrinhoUI();
      }
    }
  });
}

function atualizarCarrinhoUI() {
  const container = document.getElementById("lista-carrinho");
  if (!container) return;

  if (!carrinho.length) {
    container.innerHTML = `
      <div class="carrinho-vazio">
        <i class="ri-shopping-cart-2-line"></i>
        <span>Nenhum item na venda.</span>
        <small class="esc-hint">Escolha um produto ou passe o código de barras.</small>
      </div>`;
  } else {
    container.innerHTML = carrinho.map((item, idx) => {
      const produto = cacheProdutos.find(p => p.id === Number(item.produtoId));
      const classeCat = produto ? classeCategoria(categoriaDe(produto)) : "cat-outra";
      const novo = mesmoId(item.produtoId, ultimoProdutoAdicionado) ? " novo" : "";
      return `
      <div class="linha-carrinho ${classeCat}${novo}">
        <strong class="linha-carrinho-nome">${esc(item.nomeSnapshot)}</strong>
        <strong class="linha-carrinho-subtotal mono">${fmt(item.subtotal)}</strong>
        <span class="linha-carrinho-unit mono">${item.quantidade} × ${fmt(item.precoUnitarioSnapshot)}</span>
        <div class="qty-controles">
          <button type="button" class="qty-btn" onclick="alterarQtdItem(${idx}, -1)" aria-label="Diminuir quantidade">−</button>
          <span class="qty-num mono">${item.quantidade}</span>
          <button type="button" class="qty-btn" onclick="alterarQtdItem(${idx}, 1)" aria-label="Aumentar quantidade">+</button>
          <button type="button" class="qty-btn qty-remover" onclick="removerItemCarrinho(${idx})" aria-label="Remover item"><i class="ri-close-line"></i></button>
        </div>
      </div>`;
    }).join("");
    container.querySelector(".linha-carrinho.novo")?.scrollIntoView({ block: "nearest" });
  }
  ultimoProdutoAdicionado = null;

  const totalEl = document.getElementById("valor-final");
  const textoTotal = fmt(calcularTotalVendaCarrinho());
  if (totalEl && totalEl.textContent !== textoTotal) {
    totalEl.textContent = textoTotal;
    totalEl.classList.remove("pulso");
    if (carrinho.length) {
      void totalEl.offsetWidth;
      totalEl.classList.add("pulso");
    }
  }

  const qtdItens = carrinho.reduce((acc, i) => acc + i.quantidade, 0);
  const textoItens = `${qtdItens} ${qtdItens === 1 ? "item" : "itens"}`;
  const contagem = document.getElementById("contagem-itens");
  if (contagem) contagem.textContent = textoItens;
  const mobileTotal = document.getElementById("mobile-total");
  if (mobileTotal) mobileTotal.textContent = textoTotal;
  const mobileItens = document.getElementById("mobile-itens");
  if (mobileItens) mobileItens.textContent = `Venda atual · ${textoItens}`;
}

// Celular: o botão da barra de baixo leva até a lista da venda
function irParaVenda() {
  document.querySelector(".carrinho-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 12b. BLOQUEIO, ATALHOS, FAVORITOS, CONFIGURAÇÃO E STATUS DA NUVEM
// Esc / "Trocar operador": com itens na venda, pergunta antes de descartar
async function pedirBloqueio() {
  if (carrinho.length) {
    const ok = await confirmar({
      titulo: "Trocar de operador?",
      mensagem: `A venda atual tem ${carrinho.length} ${carrinho.length === 1 ? "item" : "itens"} (${fmt(calcularTotalVendaCarrinho())}) e será descartada.`,
      confirmarTexto: "Descartar e bloquear",
      cancelarTexto: "Voltar",
      tipo: "perigo"
    });
    if (!ok) return;
  }
  bloquearCaixa();
}

function reiniciarTimerInatividade() {
  clearTimeout(timerInatividade);
  const minutos = Number(configPDV.bloqueioInatividadeMin) || 0;
  if (!usuarioLogado || minutos <= 0) return;
  timerInatividade = setTimeout(bloquearPorInatividade, minutos * 60 * 1000);
}

// Só bloqueia sozinho com a venda vazia e nenhuma tela aberta por cima
function bloquearPorInatividade() {
  if (!usuarioLogado) return;
  const algumaJanelaAberta = document.querySelector(".modal-overlay.active:not(#modal-bloqueio)");
  if (carrinho.length || algumaJanelaAberta) {
    reiniciarTimerInatividade();
    return;
  }
  bloquearCaixa();
  avisar("Caixa bloqueado por inatividade.", { tipo: "info" });
}

function atualizarBarraAtalhos() {
  const visivel = Boolean(usuarioLogado && turnoAtivo && document.getElementById("tela-pdv")?.classList.contains("active"));
  document.getElementById("barra-atalhos")?.classList.toggle("hidden", !visivel);
  document.getElementById("barra-venda-mobile")?.classList.toggle("hidden", !visivel);
  document.body.classList.toggle("com-atalhos", visivel);
}

// No computador, deixa o cursor na busca para o leitor e a digitação
function focarBuscaPDV() {
  if (!turnoAtivo || !window.matchMedia("(min-width: 1024px)").matches) return;
  setTimeout(() => {
    if (document.querySelector(".modal-overlay.active")) return;
    document.getElementById("busca-produto-pdv")?.focus();
  }, 60);
}

function preencherConfigPDV() {
  const chk = document.getElementById("cfg-bloquear-apos-venda");
  const sel = document.getElementById("cfg-bloqueio-inatividade");
  if (chk) chk.checked = configPDV.bloquearAposVenda !== false;
  if (sel) sel.value = String(configPDV.bloqueioInatividadeMin || 0);
}

function salvarConfigPDV(e) {
  e.preventDefault();
  const bloquearAposVenda = document.getElementById("cfg-bloquear-apos-venda").checked;
  const bloqueioInatividadeMin = Number(document.getElementById("cfg-bloqueio-inatividade").value) || 0;
  configPDV = { ...configPDV, bloquearAposVenda, bloqueioInatividadeMin };
  reiniciarTimerInatividade();
  setDoc(doc(db, "configuracoes", "pdv"), { bloquearAposVenda, bloqueioInatividadeMin }, { merge: true })
    .catch(erro => {
      console.error("Erro ao salvar a configuração:", erro);
      avisar("Não foi possível salvar a configuração na nuvem.", { tipo: "erro" });
    });
  avisar("Configuração do bloqueio salva.", { tipo: "sucesso" });
}

function alternarFavorito(id) {
  const lista = (configPDV.favoritos || []).map(Number);
  const idNum = Number(id);
  const pos = lista.indexOf(idNum);
  if (pos >= 0) {
    lista.splice(pos, 1);
  } else {
    if (lista.length >= 12) {
      avisar("Já são 12 favoritos. Tire um antes de adicionar outro.", { tipo: "alerta" });
      return;
    }
    lista.push(idNum);
  }
  salvarFavoritos(lista);
}

function moverFavorito(id, direcao) {
  const lista = (configPDV.favoritos || []).map(Number);
  const i = lista.indexOf(Number(id));
  const j = i + direcao;
  if (i < 0 || j < 0 || j >= lista.length) return;
  [lista[i], lista[j]] = [lista[j], lista[i]];
  salvarFavoritos(lista);
}

function salvarFavoritos(lista) {
  configPDV = { ...configPDV, favoritos: lista };
  carregarProdutos();
  setDoc(doc(db, "configuracoes", "pdv"), { favoritos: lista }, { merge: true })
    .catch(erro => {
      console.error("Erro ao salvar os favoritos:", erro);
      avisar("Não foi possível salvar os favoritos na nuvem.", { tipo: "erro" });
    });
}

function renderizarFavoritosAdmin() {
  const el = document.getElementById("lista-favoritos");
  if (!el) return;
  const porId = new Map(cacheProdutos.filter(p => p.ativo).map(p => [Number(p.id), p]));
  const favoritos = (configPDV.favoritos || []).map(id => porId.get(Number(id))).filter(Boolean);
  if (!favoritos.length) {
    el.innerHTML = `<p class="vazio-texto">Nenhum favorito ainda. O PDV está mostrando os mais vendidos.</p>`;
    return;
  }
  el.innerHTML = favoritos.map((p, i) => `
    <div class="favorito-chip ${classeCategoria(categoriaDe(p))}">
      <span class="ordem mono">${i + 1}</span>
      <span>${esc(p.nome)} <small class="esc-hint">${esc(p.subcategoria || "")}</small></span>
      <button type="button" class="icon-btn" onclick="moverFavorito(${Number(p.id)}, -1)" aria-label="Mover para antes" ${i === 0 ? "disabled" : ""}><i class="ri-arrow-left-s-line"></i></button>
      <button type="button" class="icon-btn" onclick="moverFavorito(${Number(p.id)}, 1)" aria-label="Mover para depois" ${i === favoritos.length - 1 ? "disabled" : ""}><i class="ri-arrow-right-s-line"></i></button>
      <button type="button" class="icon-btn" onclick="alternarFavorito(${Number(p.id)})" aria-label="Tirar dos favoritos"><i class="ri-close-line"></i></button>
    </div>
  `).join("");
}

// Status real da nuvem: online, enviando vendas pendentes ou sem internet
function iniciarStatusNuvem() {
  window.addEventListener("online", atualizarStatusNuvem);
  window.addEventListener("offline", atualizarStatusNuvem);
  // Mesmo filtro da escuta de vendas: o Firebase reaproveita a mesma conexão
  onSnapshot(
    query(collection(db, "vendas"), where("dataHora", ">=", LIMITE_JANELA_MS)),
    { includeMetadataChanges: true },
    (snapshot) => {
      pendentesEnvio = snapshot.docs.filter(d => d.metadata.hasPendingWrites).length;
      servidorRespondeu = servidorRespondeu || !snapshot.metadata.fromCache;
      atualizarStatusNuvem();
    },
    (erro) => {
      console.error("Erro no status da nuvem:", erro);
      atualizarStatusNuvem();
    }
  );
  atualizarStatusNuvem();
}

function atualizarStatusNuvem() {
  const online = navigator.onLine !== false;
  const vendasTexto = n => `${n} ${n === 1 ? "venda" : "vendas"}`;
  let classe;
  let rotulo;
  let dica;

  if (!online) {
    classe = "offline";
    rotulo = pendentesEnvio > 0 ? `Sem internet · ${pendentesEnvio} ${pendentesEnvio === 1 ? "pendente" : "pendentes"}` : "Sem internet";
    dica = pendentesEnvio > 0
      ? `${vendasTexto(pendentesEnvio)} salvas neste computador, aguardando a internet voltar para ir à nuvem.`
      : "As vendas continuam salvas neste computador e vão para a nuvem quando a internet voltar.";
  } else if (pendentesEnvio > 0) {
    classe = "enviando";
    rotulo = `Enviando ${vendasTexto(pendentesEnvio)}…`;
    dica = "Vendas salvas neste computador, enviando para a nuvem.";
  } else if (!servidorRespondeu) {
    classe = "enviando";
    rotulo = "Conectando…";
    dica = "Conectando à nuvem.";
  } else {
    classe = "ok";
    rotulo = "Online";
    dica = "Tudo salvo na nuvem.";
  }

  ["status-nuvem", "status-nuvem-bloqueio"].forEach(id => {
    const chip = document.getElementById(id);
    if (!chip) return;
    chip.className = `status-nuvem ${classe}`;
    chip.title = dica;
    const texto = chip.querySelector(".status-texto");
    if (texto) texto.textContent = rotulo;
  });
}

// 13. HISTÓRICO DE TURNOS
function carregarHistoricoTurnos() {
  if (!usuarioLogado) return;
  const filtroData = document.getElementById("filtro-data").value;

  let turnos = [...cacheTurnos]
    .filter(t => usuarioLogado.isAdmin || mesmoId(t.usuarioId, usuarioLogado.id))
    .sort((a, b) => b.dataHoraAbertura - a.dataHoraAbertura);

  if (filtroData) {
    turnos = turnos.filter(t => dataLocalISO(t.dataHoraAbertura) === filtroData);
    // Turnos antigos: busca as vendas deles no banco e redesenha quando chegarem
    garantirVendasDosTurnos(turnos).then(carregou => { if (carregou) carregarHistoricoTurnos(); });
  } else {
    // Sem filtro: turnos abertos + turnos dos últimos JANELA_TEMPO_REAL_DIAS dias
    turnos = turnos.filter(t => t.status === "ABERTO" || t.dataHoraAbertura >= LIMITE_JANELA_MS);
  }

  const vendasConhecidas = todasVendas();
  const container = document.getElementById("lista-historico-turnos");
  if (!turnos.length) {
    container.innerHTML = `
      <div class="estado-vazio">
        <i class="ri-history-line"></i>
        <span>Nenhum turno registrado para este filtro.</span>
      </div>`;
    return;
  }

  container.innerHTML = turnos.map(t => {
    const nomeOperador = obterNomePerfil(t.usuarioId, t.operadorNome);
    const vendasDoTurno = vendasConhecidas.filter(v => mesmoId(v.turnoId, t.id));
    const concluidas = vendasDoTurno
      .filter(v => v.status === "CONCLUIDA")
      .sort((a, b) => a.dataHora - b.dataHora);
    const canceladasVisiveis = vendasDoTurno.filter(v => v.status === "CANCELADA" && v.constarNoFechamento !== false);
    const total = r2(concluidas.reduce((acc, v) => acc + v.valorFinal, 0));
    const aberto = t.status === "ABERTO";
    const chave = String(t.id);
    const estaAberto = estadoTurnoHistorico.has(chave) ? estadoTurnoHistorico.get(chave) : aberto;

    const listaVendasHTML = concluidas.length
      ? concluidas.map(v => `
          <div class="venda-turno">
            <span class="venda-hora mono">${formatarHora(v.dataHora)}</span>
            <span class="venda-itens">${esc((v.itens || []).map(i => `${i.quantidade}× ${i.nomeSnapshot}`).join(", "))}</span>
            <span class="venda-turno-pag">${chipsPagamentoHTML(v)}</span>
            <strong class="mono">${fmt(v.valorFinal)}</strong>
            <button type="button" class="icon-btn" onclick="imprimirCupomVenda80mm('${esc(v.id)}')" title="Imprimir 2ª via" aria-label="Imprimir 2ª via">
              <i class="ri-printer-line"></i>
            </button>
          </div>
        `).join("")
      : `<p class="vazio-texto">Nenhuma venda concluída neste turno.</p>`;

    return `
      <details class="turno-card" ${estaAberto ? "open" : ""} ontoggle="registrarTurnoAberto('${esc(t.id)}', this.open)">
        <summary>
          <div class="turno-card-titulo">
            <span class="badge ${aberto ? "badge-open" : "badge-neutro"}">${aberto ? "Aberto" : "Fechado"}</span>
            <strong>${esc(t.tipoTurno)}</strong>
            <span class="texto-suave">${esc(nomeOperador)} · ${formatarDataCurta(t.dataHoraAbertura)} → ${t.dataHoraFechamento ? formatarDataCurta(t.dataHoraFechamento) : "agora"}</span>
          </div>
          <div class="turno-card-numeros">
            <span class="texto-suave">${concluidas.length} ${concluidas.length === 1 ? "venda" : "vendas"}</span>
            ${canceladasVisiveis.length ? `<span class="badge badge-closed">${canceladasVisiveis.length} ${canceladasVisiveis.length === 1 ? "cancelada" : "canceladas"}</span>` : ""}
            <strong class="mono">${fmt(total)}</strong>
            <i class="ri-arrow-down-s-line seta" aria-hidden="true"></i>
          </div>
        </summary>
        <div class="turno-card-corpo">
          <div class="turno-card-acoes">
            <span class="rotulo-grupo">Imprimir extrato</span>
            <button class="btn btn-secondary btn-sm" onclick="imprimirRelatorioTurno80mm('${esc(t.id)}', 'vendas')">
              <i class="ri-printer-line"></i> Por vendas
            </button>
            <button class="btn btn-secondary btn-sm" onclick="imprimirRelatorioTurno80mm('${esc(t.id)}', 'produtos')">
              <i class="ri-list-check-2"></i> Por produtos
            </button>
          </div>
          <div class="vendas-turno">${listaVendasHTML}</div>
        </div>
      </details>
    `;
  }).join("");
}

// 14. MOTOR DE IMPRESSÃO TÉRMICA 80MM (ELGIN i8)
// Dinheiro com troco: mostra quanto foi recebido e o troco no cupom
function linhasTrocoCupom(v) {
  const dinheiro = (v.pagamentos || []).filter(p => p.forma === "DINHEIRO");
  const troco = r2(dinheiro.reduce((acc, p) => acc + (Number(p.troco) || 0), 0));
  if (troco <= 0) return "";
  const recebido = r2(dinheiro.reduce((acc, p) => acc + (Number(p.recebido) || Number(p.valor) || 0), 0));
  return `<div>Recebido em dinheiro: ${fmt(recebido)}</div><div>Troco: ${fmt(troco)}</div>`;
}

function imprimirCupomVenda80mm(vendaId, callbackPosImpressao = null) {
  let v = buscarVenda(vendaId);
  if (!v && ultimaVendaObjeto && mesmoId(ultimaVendaObjeto.id, vendaId)) {
    v = ultimaVendaObjeto;
  }
  if (!v) return;

  const nomeOperador = obterNomePerfil(v.usuarioId, v.operadorNome);
  const area = document.getElementById("area-impressao");
  area.innerHTML = `
    <div class="cupom-header">
      <h3>CAIXA PETROVIA</h3>
      <div>COMPROVANTE DE VENDA #${esc(v.id)} ${v.status === "CANCELADA" ? "(CANCELADA)" : ""}</div>
      <div>Operador: ${esc(nomeOperador)}</div>
      <div>Data: ${new Date(v.dataHora).toLocaleString("pt-BR")}</div>
      <div>Pgto: ${esc(formatarPagamentoTexto(v))}</div>
    </div>

    <table class="cupom-table">
      <thead>
        <tr>
          <th>ITEM</th>
          <th class="cupom-right">QTD x UN</th>
          <th class="cupom-right">SUB</th>
        </tr>
      </thead>
      <tbody>
        ${v.itens.map(i => `
          <tr>
            <td>${esc(i.nomeSnapshot)}</td>
            <td class="cupom-right">${i.quantidade}x ${fmtNum(i.precoUnitarioSnapshot)}</td>
            <td class="cupom-right">${fmtNum(i.subtotal)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <div class="cupom-divider"></div>
    ${v.desconto > 0 ? `
      <div>Subtotal Bruto: ${fmt(v.valorBruto)}</div>
      <div>Desconto: ${fmt(v.desconto)}</div>
    ` : ""}
    <div class="cupom-total">TOTAL: ${fmt(v.valorFinal)}</div>
    ${linhasTrocoCupom(v)}
    ${Array.isArray(v.alteracoesPagamento) && v.alteracoesPagamento.length
      ? `<div>Forma de pagamento corrigida em ${formatarDataCurta(v.alteracoesPagamento[v.alteracoesPagamento.length - 1].dataHora)}</div>`
      : ""}

    <div class="cupom-footer">
      Obrigado pela preferência!
    </div>
  `;

  window.print();
  if (callbackPosImpressao) callbackPosImpressao();
}

async function imprimirRelatorioTurno80mm(turnoId, modo = "vendas", turnoOverride = null) {
  const t = turnoOverride || cacheTurnos.find(item => mesmoId(item.id, turnoId));
  if (!t) return;

  // Turno antigo (fora da janela em tempo real): busca as vendas antes de imprimir
  await garantirVendasDosTurnos([t]);

  const nomeOperador = obterNomePerfil(t.usuarioId, t.operadorNome);
  const vendasConhecidas = todasVendas();
  const vendas = vendasConhecidas
    .filter(v => mesmoId(v.turnoId, t.id) && v.status === "CONCLUIDA")
    .sort((a, b) => a.dataHora - b.dataHora);
  const canceladas = vendasConhecidas.filter(
    v => mesmoId(v.turnoId, t.id) && v.status === "CANCELADA" && v.constarNoFechamento !== false
  );

  const totalBruto = r2(vendas.reduce((acc, v) => acc + v.valorBruto, 0));
  const totalDescontos = r2(vendas.reduce((acc, v) => acc + (Number(v.desconto) || 0), 0));
  const totalLiquido = r2(vendas.reduce((acc, v) => acc + v.valorFinal, 0));
  const totalCancelado = r2(canceladas.reduce((acc, v) => acc + v.valorFinal, 0));

  // Agrupamento financeiro unificado (suportando pagamentos mistos e parciais)
  const resumoPagamentos = {};
  vendas.forEach(v => {
    if (v.pagamentos && v.pagamentos.length > 0) {
      v.pagamentos.forEach(p => {
        const chave = p.forma === "DINHEIRO" || p.forma === "PIX"
          ? p.forma
          : `${p.forma} - ${(p.bandeira || "OUTRA").toUpperCase()}${p.forma === "CREDITO" ? " (1x)" : ""}`;
        resumoPagamentos[chave] = r2((resumoPagamentos[chave] || 0) + p.valor);
      });
    } else if (v.formaPagamento) {
      const chave = formatarPagamentoTexto(v);
      resumoPagamentos[chave] = r2((resumoPagamentos[chave] || 0) + v.valorFinal);
    }
  });

  const linhasResumoPag = Object.entries(resumoPagamentos)
    .sort((a, b) => a[0].localeCompare(b[0], "pt-BR"))
    .map(([label, valor]) => `<div>${esc(label)}: ${fmt(valor)}</div>`)
    .join("");

  const linhasPeriodos = totaisPorPeriodo(t, vendas)
    .map(p => `<div>${esc(p.nome)}: ${fmt(p.total)} (${p.qtd} ${p.qtd === 1 ? "venda" : "vendas"})</div>`)
    .join("");

  // Corpo principal alterna entre "Por Produtos" e "Por Vendas"
  let tituloRelatorio = `EXTRATO DE TURNO #${t.id}`;
  let corpoTabelaHTML = "";

  if (modo === "produtos") {
    tituloRelatorio = `FECHAMENTO POR PRODUTO - #${t.id}`;
    const mapaProdutos = {};
    let totalUnidades = 0;

    vendas.forEach(v => {
      (v.itens || []).forEach(item => {
        const nome = item.nomeSnapshot || "Produto";
        const qtd = Number(item.quantidade) || 0;
        const sub = Number(item.subtotal) || 0;

        if (!mapaProdutos[nome]) {
          mapaProdutos[nome] = { nome, quantidade: 0, total: 0 };
        }
        mapaProdutos[nome].quantidade += qtd;
        mapaProdutos[nome].total = r2(mapaProdutos[nome].total + sub);
        totalUnidades += qtd;
      });
    });

    const listaAgrupada = Object.values(mapaProdutos)
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

    corpoTabelaHTML = `
      <table class="cupom-table">
        <thead>
          <tr>
            <th>PRODUTO</th>
            <th class="cupom-right">QTD</th>
            <th class="cupom-right">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          ${listaAgrupada.length ? listaAgrupada.map(p => `
            <tr>
              <td>${esc(p.nome)}</td>
              <td class="cupom-right">${p.quantidade}x</td>
              <td class="cupom-right">${fmtNum(p.total)}</td>
            </tr>
          `).join("") : `<tr><td colspan="3">Nenhum produto vendido neste turno.</td></tr>`}
        </tbody>
      </table>

      <div class="cupom-divider"></div>
      <strong>TOTAL DE PRODUTOS VENDIDOS: ${totalUnidades} un.</strong>
    `;
  } else {
    corpoTabelaHTML = `
      <table class="cupom-table">
        <thead>
          <tr>
            <th>HORA / #ID</th>
            <th>ITENS / PGTO</th>
            <th class="cupom-right">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          ${vendas.map(v => `
            <tr>
              <td>${new Date(v.dataHora).toLocaleTimeString("pt-BR")} (#${esc(v.id)})</td>
              <td>
                ${esc(v.itens.map(i => `${i.quantidade}x ${i.nomeSnapshot}`).join(", "))}<br>
                <small>[${esc(formatarPagamentoTexto(v))}]</small>
              </td>
              <td class="cupom-right">${fmtNum(v.valorFinal)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  const area = document.getElementById("area-impressao");
  area.innerHTML = `
    <div class="cupom-header">
      <h3>CAIXA PETROVIA</h3>
      <div>${esc(tituloRelatorio)}</div>
      <div>Turno: ${esc(t.tipoTurno)} (${esc(t.status)})</div>
      <div>Operador: ${esc(nomeOperador)}</div>
      <div>Início: ${new Date(t.dataHoraAbertura).toLocaleString("pt-BR")}</div>
      <div>Fim: ${t.dataHoraFechamento ? new Date(t.dataHoraFechamento).toLocaleString("pt-BR") : "Em andamento"}</div>
    </div>

    ${corpoTabelaHTML}

    ${linhasPeriodos ? `
    <div class="cupom-divider"></div>
    <strong>TOTAL POR PERÍODO:</strong>
    ${linhasPeriodos}` : ""}

    <div class="cupom-divider"></div>
    <strong>RESUMO POR PAGAMENTO:</strong>
    ${linhasResumoPag || "<div>Sem movimentação</div>"}

    <div class="cupom-divider"></div>
    <div>Qtd. Vendas Concluídas: ${vendas.length}</div>
    ${totalDescontos > 0 ? `
      <div>Total Bruto: ${fmt(totalBruto)}</div>
      <div>Total Descontos: ${fmt(totalDescontos)}</div>
    ` : ""}
    <div class="cupom-total">TOTAL DO TURNO: ${fmt(totalLiquido)}</div>
    ${canceladas.length ? `<div style="margin-top:4px; font-size:11px;">Auditoria - Canceladas: ${canceladas.length} (${fmt(totalCancelado)})</div>` : ""}

    <div class="cupom-footer">
      Fechamento emitido em ${new Date().toLocaleString("pt-BR")}
    </div>
  `;

  window.print();
}

// Expõe todas as funções para os eventos inline do HTML
Object.assign(window, {
  estenderTurno,
  corrigirPeriodoTurno,
  alternarCorrecaoPeriodo,
  dispensarAvisoFimTurno,
  irParaEncerrarTurno,
  autenticarOperador,
  bloquearCaixa,
  navegar,
  salvarConfigMaster,
  prepararEdicaoOperador,
  cancelarEdicaoOperador,
  salvarOperador,
  removerOperador,
  prepararEdicaoProduto,
  cancelarEdicaoProduto,
  salvarProduto,
  atualizarSubcategoriasForm,
  selecionarCategoriaPDV,
  selecionarSubcategoriaPDV,
  carregarProdutos,
  desativarProduto,
  aoDigitarBuscaPDV,
  processarTeclasBuscaPDV,
  abrirModalPagamento,
  fecharModalPagamento,
  voltarParaEscolhaForma,
  selecionarFormaPagamento,
  confirmarValorParcial,
  selecionarBandeiraPagamento,
  removerPagamentoParcial,
  finalizarVendaComposta,
  confirmarImpressaoPosVenda,
  carregarAbaVendas,
  limparFiltrosVendas,
  abrirModalCancelamento,
  fecharModalCancelamento,
  confirmarCancelamentoVenda,
  renderizarDashboard,
  limparFiltroDashboard,
  abrirTurno,
  fecharTurnoAtual,
  adicionarAoCarrinho,
  adicionarProdutoPorId,
  alterarQtdItem,
  removerItemCarrinho,
  irParaVenda,
  limparCarrinho,
  limparVendaAtual,
  venderDinheiroExato,
  atualizarPreviaTroco,
  pedirBloqueio,
  alternarSom,
  alternarTema,
  alternarFavorito,
  moverFavorito,
  salvarConfigPDV,
  alternarCampoSenha,
  mostrarSenhaOperador,
  encerrarTurnoSelecionado,
  abrirAlteracaoPagamento,
  alterarPagamentoUltimaVenda,
  cancelarPagamento,
  concluirPagamento,
  registrarTurnoAberto,
  atualizarCarrinhoUI,
  carregarHistoricoTurnos,
  imprimirCupomVenda80mm,
  imprimirRelatorioTurno80mm
});
