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
      return `${rotulo}: R$ ${p.valor.toFixed(2)}`;
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
  });

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
  });

  onSnapshot(collection(db, "produtos"), (snapshot) => {
    cacheProdutos = snapshot.docs.map(d => d.data());
    if (usuarioLogado) carregarProdutos();
  });

  onSnapshot(collection(db, "turnos"), (snapshot) => {
    cacheTurnos = snapshot.docs.map(d => d.data());
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
      carregarHistoricoTurnos();
      carregarAbaVendas();
      if (document.getElementById("tela-dashboard")?.classList.contains("active")) {
        renderizarDashboard();
      }
    }
  });
}

inicializarSeletoresCategorias();
iniciarSincronizacaoFirebase();
focarInputSenha();

function inicializarSeletoresCategorias() {
  const selectCatForm = document.getElementById("prod-categoria");
  const selectFiltroCadastro = document.getElementById("filtro-cat-cadastro");
  const categorias = Object.keys(MAPA_CATEGORIAS);

  if (selectCatForm) {
    selectCatForm.innerHTML = categorias.map(c => `<option value="${c}">${c}</option>`).join("");
    atualizarSubcategoriasForm();
  }

  if (selectFiltroCadastro) {
    selectFiltroCadastro.innerHTML = `<option value="TODAS">Todas as Categorias</option>` +
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

// 3. MOTOR DE ATALHOS DE TECLADO (SETAS, MAIS VENDIDOS E PAGAMENTO MISTO)
window.addEventListener("keydown", (e) => {
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
    }
    return;
  }

  if (modalPagamento.classList.contains("active")) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (pagamentoPassoAtual === 1.1 || pagamentoPassoAtual === 2) {
        voltarParaEscolhaForma();
      } else {
        fecharModalPagamento();
      }
      return;
    }

    if (pagamentoPassoAtual === 1) {
      if (e.key === "1") { e.preventDefault(); selecionarFormaPagamento("DINHEIRO"); }
      else if (e.key === "2") { e.preventDefault(); selecionarFormaPagamento("PIX"); }
      else if (e.key === "3") { e.preventDefault(); selecionarFormaPagamento("CREDITO"); }
      else if (e.key === "4") { e.preventDefault(); selecionarFormaPagamento("DEBITO"); }
      else if (e.key === "F2") {
        e.preventDefault();
        const btnConcluir = document.getElementById("btn-concluir-pagamento-misto");
        if (btnConcluir && !btnConcluir.classList.contains("hidden")) {
          finalizarVendaComposta();
        }
      }
    } else if (pagamentoPassoAtual === 1.1) {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmarValorParcial();
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
    if (carrinho.length && !confirm("Há itens na venda atual. Bloquear o caixa e descartar a venda?")) return;
    bloquearCaixa();
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

  if (e.key === "F9") {
    e.preventDefault();
    limparCarrinho();
    return;
  }

  const elAtivo = document.activeElement;
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
  if (cards.length > 0 && document.getElementById("busca-produto-pdv").value.trim() !== "") {
    indiceFocoPDV = 0;
    atualizarDestaqueCardPDV();
  }
}

function processarTeclasBuscaPDV(e) {
  if (e.key !== "Enter") return;
  e.preventDefault();

  const input = document.getElementById("busca-produto-pdv");
  const termo = (input.value || "").trim().toLowerCase();

  if (termo) {
    const ativos = cacheProdutos.filter(p => p.ativo);
    const porCodigo = ativos.find(p => p.codigoInterno && p.codigoInterno.toLowerCase() === termo);
    if (porCodigo) {
      adicionarProdutoPorId(porCodigo.id);
      input.value = "";
      indiceFocoPDV = -1;
      carregarProdutos();
      return;
    }
  }

  const cards = obterCardsPDV();
  if (indiceFocoPDV >= 0 && indiceFocoPDV < cards.length) {
    cards[indiceFocoPDV].click();
  } else if (cards.length === 1) {
    cards[0].click();
    input.value = "";
    indiceFocoPDV = -1;
    carregarProdutos();
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
}

function bloquearCaixa() {
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
    carregarOperadores();
  }
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
    alert("Esta senha já está sendo usada por um operador. Escolha outra senha Master.");
    return;
  }

  setDoc(doc(db, "configuracoes", "master"), {
    nome: novoNome,
    senha: novaSenha
  });

  alert("Perfil e Senha Master atualizados com sucesso!");
}

function prepararEdicaoOperador(id) {
  const op = cacheUsuarios.find(u => u.id === Number(id));
  if (!op) return;

  document.getElementById("op-id-edicao").value = op.id;
  document.getElementById("op-nome").value = op.nome;
  document.getElementById("op-senha").value = op.senha;

  document.getElementById("titulo-form-operador").innerHTML = `<i class="ri-edit-line"></i> Editando Operador #${op.id}`;
  document.getElementById("btn-submit-operador").innerHTML = `<i class="ri-save-line"></i> Salvar Alterações`;
  document.getElementById("btn-cancelar-edicao").classList.remove("hidden");
  document.getElementById("op-nome").focus();
}

function cancelarEdicaoOperador() {
  const form = document.getElementById("form-operador");
  if (form) form.reset();
  const idInput = document.getElementById("op-id-edicao");
  if (idInput) idInput.value = "";

  const titulo = document.getElementById("titulo-form-operador");
  if (titulo) titulo.innerHTML = `<i class="ri-user-add-line"></i> Cadastrar Novo Operador`;

  const btnSubmit = document.getElementById("btn-submit-operador");
  if (btnSubmit) btnSubmit.innerHTML = `<i class="ri-user-follow-line"></i> Cadastrar Operador`;

  const btnCancelar = document.getElementById("btn-cancelar-edicao");
  if (btnCancelar) btnCancelar.classList.add("hidden");
}

function salvarOperador(e) {
  e.preventDefault();
  const idEdicao = document.getElementById("op-id-edicao").value;
  const nome = document.getElementById("op-nome").value.trim();
  const senha = document.getElementById("op-senha").value.trim();

  if (senha === configMaster.senha) {
    alert("Essa senha é reservada ao Admin Master. Escolha outra.");
    return;
  }

  const idNum = idEdicao ? Number(idEdicao) : null;
  const jaExiste = cacheUsuarios.some(u => u.senha === senha && u.ativo !== false && u.id !== idNum);
  if (jaExiste) {
    alert("Já existe outro operador usando esta senha. Escolha uma senha exclusiva.");
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
  } else {
    const novoId = gerarProximoId(cacheUsuarios);
    setDoc(doc(db, "usuarios", String(novoId)), {
      id: novoId,
      nome,
      senha,
      ativo: true
    });
    document.getElementById("form-operador").reset();
  }
}

function removerOperador(id) {
  if (!confirm("Deseja remover o acesso deste operador? O histórico de turnos dele será mantido.")) return;
  deleteDoc(doc(db, "usuarios", String(id)));
  if (Number(document.getElementById("op-id-edicao").value) === Number(id)) {
    cancelarEdicaoOperador();
  }
}

function carregarOperadores() {
  const container = document.getElementById("lista-operadores");
  const operadores = [...cacheUsuarios].sort((a, b) => a.id - b.id);

  if (!operadores.length) {
    container.innerHTML = `<p style="color:var(--text-muted); margin-top:0.5rem;">Nenhum operador cadastrado.</p>`;
    return;
  }

  container.innerHTML = operadores.map(op => `
    <div class="item-carrinho">
      <div>
        <strong>${esc(op.nome)}</strong>
        <div class="mono" style="font-size:0.82rem; color:var(--text-muted);">Senha: ${esc(op.senha)} | ID Fixo: #${esc(op.id)}</div>
      </div>
      <div style="display:flex; gap:0.4rem;">
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

  document.getElementById("titulo-form-produto").innerHTML = `<i class="ri-edit-line"></i> Editando Produto #${p.id}`;
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
  if (titulo) titulo.innerHTML = `<i class="ri-add-circle-line"></i> Cadastrar Produto no Catálogo`;

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
    <button 
      type="button"
      class="pill-btn ${categoriaAtivaPDV === cat ? 'active' : ''}" 
      onclick="selecionarCategoriaPDV('${esc(cat)}')"
    >
      ${cat === "TODAS" ? "Catálogo Completo (Todos)" : esc(cat)}
    </button>
  `).join("");

  if (categoriaAtivaPDV !== "TODAS" && MAPA_CATEGORIAS[categoriaAtivaPDV]) {
    const subs = ["TODAS", ...MAPA_CATEGORIAS[categoriaAtivaPDV]];
    barraSub.classList.remove("hidden");
    barraSub.innerHTML = subs.map(sub => `
      <button 
        type="button"
        class="pill-btn ${subcategoriaAtivaPDV === sub ? 'active' : ''}" 
        onclick="selecionarSubcategoriaPDV('${esc(sub)}')"
      >
        ${sub === "TODAS" ? "Todos os tamanhos" : esc(sub)}
      </button>
    `).join("");
  } else {
    barraSub.classList.add("hidden");
  }
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

// FAIXA DE MAIS VENDIDOS NO TOPO DO PDV
function renderizarFaixaMaisVendidos() {
  const container = document.getElementById("faixa-mais-vendidos");
  if (!container) return;

  const termoBusca = (document.getElementById("busca-produto-pdv")?.value || "").trim();

  if (categoriaAtivaPDV !== "TODAS" || termoBusca !== "") {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

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

  const topProdutos = cacheProdutos
    .filter(p => p.ativo && contagemPorId[p.id] > 0)
    .map(p => ({
      ...p,
      subcategoria: p.subcategoria || "Diversos",
      qtdVendida: contagemPorId[p.id]
    }))
    .sort((a, b) => b.qtdVendida - a.qtdVendida)
    .slice(0, 8);

  if (!topProdutos.length) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const cardsHTML = topProdutos.map(p => {
    return `
      <div class="produto-card" onclick="adicionarProdutoPorId(${Number(p.id)})">
        <div>
          <span class="prod-cat-tag">${esc(p.subcategoria)}</span>
          <strong>${esc(p.nome)}</strong>
        </div>
        <span class="preco-tag">R$ ${p.precoUnitario.toFixed(2)}</span>
      </div>
    `;
  }).join("");

  container.classList.remove("hidden");
  container.innerHTML = `
    <div class="mais-vendidos-header">
      <h3><i class="ri-fire-fill"></i> Mais Vendidos (Acesso Rápido)</h3>
      <span class="badge badge-user">Top ${topProdutos.length}</span>
    </div>
    <div class="mais-vendidos-grid-wrap">
      <div class="produtos-grid">${cardsHTML}</div>
    </div>
  `;

  if (indiceFocoPDV >= 0) atualizarDestaqueCardPDV();
}

function carregarProdutos() {
  renderizarFiltrosCategoriaPDV();
  renderizarFaixaMaisVendidos();

  const termoBusca = (document.getElementById("busca-produto-pdv")?.value || "").toLowerCase();
  const criterioOrdemPDV = document.getElementById("ordenacao-pdv")?.value || "nome-asc";
  const filtroCatCadastro = document.getElementById("filtro-cat-cadastro")?.value || "TODAS";
  const criterioOrdemCadastro = document.getElementById("ordenacao-cadastro")?.value || "nome-asc";

  const todosAtivos = cacheProdutos
    .filter(p => p.ativo)
    .map(p => ({
      ...p,
      categoria: p.categoria === "Conveniência" ? "Cigarros" : (p.categoria || "Cigarros"),
      subcategoria: p.subcategoria || "Diversos"
    }));

  const filtradosPDV = todosAtivos.filter(p => {
    const bateCategoria = categoriaAtivaPDV === "TODAS" || p.categoria === categoriaAtivaPDV;
    const bateSubcategoria = subcategoriaAtivaPDV === "TODAS" || p.subcategoria === subcategoriaAtivaPDV;
    const bateBusca =
      p.nome.toLowerCase().includes(termoBusca) ||
      p.categoria.toLowerCase().includes(termoBusca) ||
      p.subcategoria.toLowerCase().includes(termoBusca) ||
      (p.codigoInterno && p.codigoInterno.toLowerCase().includes(termoBusca));
    return bateCategoria && bateSubcategoria && bateBusca;
  });

  renderizarGradePDV(filtradosPDV, criterioOrdemPDV);

  const filtradosCadastro = todosAtivos.filter(p =>
    filtroCatCadastro === "TODAS" || p.categoria === filtroCatCadastro
  );

  renderizarListaCadastro(filtradosCadastro, criterioOrdemCadastro);
}

function desativarProduto(id) {
  const prod = cacheProdutos.find(p => p.id === Number(id));
  if (!prod) return;
  setDoc(doc(db, "produtos", String(prod.id)), { ...prod, ativo: false });
}

function renderizarGradePDV(produtos, criterioOrdem) {
  const container = document.getElementById("grade-produtos-pdv");
  if (!produtos.length) {
    container.innerHTML = `<p style="color:var(--text-muted); font-weight:600;">Nenhum produto cadastrado ou encontrado para este filtro.</p>`;
    indiceFocoPDV = -1;
    return;
  }

  const ordemCategorias = [
    ...Object.keys(MAPA_CATEGORIAS),
    ...new Set(produtos.map(p => p.categoria).filter(c => !MAPA_CATEGORIAS[c]))
  ];

  const secoesHTML = ordemCategorias.map(categoria => {
    const produtosDaCategoria = produtos.filter(p => p.categoria === categoria);
    if (!produtosDaCategoria.length) return "";

    const subcategoriasPadrao = MAPA_CATEGORIAS[categoria] || [];
    const subcategoriasExtras = [...new Set(produtosDaCategoria.map(p => p.subcategoria))]
      .filter(s => !subcategoriasPadrao.includes(s));
    const ordemSubcategorias = [...subcategoriasPadrao, ...subcategoriasExtras];

    const blocosSubcategoriaHTML = ordemSubcategorias.map(sub => {
      const itensSub = ordenarListaProdutos(
        produtosDaCategoria.filter(p => p.subcategoria === sub),
        criterioOrdem
      );
      if (!itensSub.length) return "";

      const cardsHTML = itensSub.map(p => {
        return `
          <div class="produto-card" onclick="adicionarProdutoPorId(${Number(p.id)})">
            <div>
              <span class="prod-cat-tag">${esc(p.subcategoria)}</span>
              <strong>${esc(p.nome)}</strong>
            </div>
            <span class="preco-tag">R$ ${p.precoUnitario.toFixed(2)}</span>
          </div>
        `;
      }).join("");

      return `
        <div class="subcategoria-bloco">
          <div class="subcategoria-titulo">${esc(sub)}</div>
          <div class="produtos-grid">${cardsHTML}</div>
        </div>
      `;
    }).join("");

    return `
      <div class="catalogo-secao">
        <div class="catalogo-secao-header">
          <h3><i class="ri-folder-open-line"></i> ${esc(categoria)}</h3>
          <span class="badge badge-user">${produtosDaCategoria.length} ${produtosDaCategoria.length === 1 ? 'item' : 'itens'}</span>
        </div>
        <div class="catalogo-secao-body">
          ${blocosSubcategoriaHTML}
        </div>
      </div>
    `;
  }).join("");

  container.innerHTML = secoesHTML;
  if (indiceFocoPDV >= 0) atualizarDestaqueCardPDV();
}

function renderizarListaCadastro(produtos, criterioOrdem) {
  const container = document.getElementById("lista-produtos-cadastro");
  if (!produtos.length) {
    container.innerHTML = `<p style="color:var(--text-muted); margin-top:0.5rem;">Nenhum produto cadastrado nesta categoria.</p>`;
    return;
  }

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

    const linhasHTML = itensCat.map(p => `
      <div class="item-carrinho">
        <div>
          <span class="prod-cat-tag">${esc(p.subcategoria)}</span>
          <strong>${esc(p.nome)}</strong> ${p.codigoInterno ? `<small class="mono">[${esc(p.codigoInterno)}]</small>` : ""}
          <div class="mono" style="color:var(--success-text); font-size:0.88rem; font-weight:800; margin-top:0.15rem;">
            R$ ${p.precoUnitario.toFixed(2)}
          </div>
        </div>
        <div style="display:flex; gap:0.4rem;">
          <button class="btn btn-secondary btn-sm" onclick="prepararEdicaoProduto(${Number(p.id)})">
            <i class="ri-edit-line"></i> Editar
          </button>
          <button class="btn btn-danger btn-sm" onclick="desativarProduto(${Number(p.id)})">Remover</button>
        </div>
      </div>
    `).join("");

    return `
      <div class="catalogo-secao" style="margin-bottom: 1rem;">
        <div class="catalogo-secao-header">
          <h3><i class="ri-price-tag-3-line"></i> ${esc(categoria)}</h3>
          <span class="badge badge-user">${itensCat.length}</span>
        </div>
        <div class="catalogo-secao-body">
          ${linhasHTML}
        </div>
      </div>
    `;
  }).join("");
}

// 8. MODAL DE PAGAMENTO MISTO / PARCIAL E FINALIZAÇÃO
function abrirModalPagamento() {
  if (!usuarioLogado || !turnoAtivo || !carrinho.length) return;

  pagamentoPassoAtual = 1;
  pagamentoFormaSelecionada = null;
  pagamentoValorParcialAtual = 0;
  pagamentosParciaisVenda = [];

  atualizarInterfaceModalPagamento();
  document.getElementById("modal-pagamento").classList.add("active");
}

function fecharModalPagamento() {
  document.getElementById("modal-pagamento").classList.remove("active");
  pagamentoPassoAtual = 1;
  pagamentoFormaSelecionada = null;
  pagamentoValorParcialAtual = 0;
  pagamentosParciaisVenda = [];
}

function calcularTotalVendaCarrinho() {
  return r2(carrinho.reduce((acc, i) => acc + i.subtotal, 0));
}

function calcularValorPagoParcialmente() {
  return r2(pagamentosParciaisVenda.reduce((acc, p) => acc + p.valor, 0));
}

function atualizarInterfaceModalPagamento() {
  const totalVenda = calcularTotalVendaCarrinho();
  const totalPago = calcularValorPagoParcialmente();
  const restante = r2(Math.max(0, totalVenda - totalPago));

  document.getElementById("pag-val-total").textContent = `R$ ${totalVenda.toFixed(2)}`;
  document.getElementById("pag-val-pago").textContent = `R$ ${totalPago.toFixed(2)}`;
  document.getElementById("pag-val-restante").textContent = `R$ ${restante.toFixed(2)}`;

  const listaEl = document.getElementById("lista-pagamentos-parciais");
  if (!pagamentosParciaisVenda.length) {
    listaEl.innerHTML = `<small style="color:var(--text-muted); font-weight:600;">Nenhum pagamento adicionado ainda.</small>`;
  } else {
    listaEl.innerHTML = pagamentosParciaisVenda.map((p, idx) => `
      <div class="parcial-item-tag mono">
        <span>${esc(p.forma)}${p.bandeira ? ` (${esc(p.bandeira)})` : ""}: R$ ${p.valor.toFixed(2)}</span>
        <button type="button" class="btn btn-secondary btn-sm" style="padding:0.15rem 0.45rem;" onclick="removerPagamentoParcial(${idx})">✕</button>
      </div>
    `).join("");
  }

  const btnConcluir = document.getElementById("btn-concluir-pagamento-misto");
  const passo1El = document.getElementById("pagamento-passo-1");
  const passoValorEl = document.getElementById("pagamento-passo-valor");
  const passo2El = document.getElementById("pagamento-passo-2");

  passo1El.classList.add("hidden");
  passoValorEl.classList.add("hidden");
  passo2El.classList.add("hidden");

  if (pagamentoPassoAtual === 1) {
    passo1El.classList.remove("hidden");
    if (restante <= 0.005) {
      btnConcluir.classList.remove("hidden");
    } else {
      btnConcluir.classList.add("hidden");
    }
  } else if (pagamentoPassoAtual === 1.1) {
    passoValorEl.classList.remove("hidden");
    const labelEl = document.getElementById("label-valor-parcial");
    if (labelEl) {
      labelEl.textContent = `Valor para ${pagamentoFormaSelecionada} (aperte Enter para o restante total):`;
    }
    const inputVal = document.getElementById("input-valor-parcial");
    inputVal.value = restante.toFixed(2);
    setTimeout(() => { inputVal.focus(); inputVal.select(); }, 50);
  } else if (pagamentoPassoAtual === 2) {
    passo2El.classList.remove("hidden");
  }
}

function selecionarFormaPagamento(forma) {
  const totalVenda = calcularTotalVendaCarrinho();
  const totalPago = calcularValorPagoParcialmente();
  const restante = r2(Math.max(0, totalVenda - totalPago));

  if (restante <= 0.005) return;

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

function confirmarValorParcial() {
  const inputVal = document.getElementById("input-valor-parcial");
  const valorDigitado = r2(parseFloat(inputVal.value) || 0);
  const totalVenda = calcularTotalVendaCarrinho();
  const totalPago = calcularValorPagoParcialmente();
  const restante = r2(Math.max(0, totalVenda - totalPago));

  if (valorDigitado <= 0 || valorDigitado > restante + 0.005) {
    alert(`Valor inválido. O restante a pagar é R$ ${restante.toFixed(2)}.`);
    inputVal.focus();
    return;
  }

  const forma = pagamentoFormaSelecionada;
  if (forma === "DINHEIRO" || forma === "PIX") {
    pagamentosParciaisVenda.push({
      forma,
      bandeira: null,
      valor: valorDigitado
    });
    voltarParaEscolhaForma();
  } else {
    pagamentoValorParcialAtual = valorDigitado;
    pagamentoPassoAtual = 2;
    const bandeiras = BANDEIRAS_PAGAMENTO[forma] || [];
    const titulo = forma === "CREDITO"
      ? `Crédito (1x) [R$ ${valorDigitado.toFixed(2)}] — Escolha a bandeira:`
      : `Débito [R$ ${valorDigitado.toFixed(2)}] — Escolha a bandeira:`;

    document.getElementById("pagamento-titulo-bandeira").textContent = titulo;
    document.getElementById("pagamento-lista-bandeiras").innerHTML = bandeiras.map((bandeira, idx) => `
      <button type="button" class="btn-pag-opcao" onclick="selecionarBandeiraPagamento('${esc(bandeira)}')">
        <span class="tecla-badge mono">${idx + 1}</span>
        <span>${esc(bandeira)}</span>
      </button>
    `).join("");

    atualizarInterfaceModalPagamento();
  }
}

function selecionarBandeiraPagamento(bandeira) {
  if (!pagamentoFormaSelecionada || pagamentoValorParcialAtual <= 0) return;
  pagamentosParciaisVenda.push({
    forma: pagamentoFormaSelecionada,
    bandeira,
    valor: pagamentoValorParcialAtual
  });
  voltarParaEscolhaForma();
}

function removerPagamentoParcial(index) {
  pagamentosParciaisVenda.splice(index, 1);
  voltarParaEscolhaForma();
}

function finalizarVendaComposta() {
  const totalVenda = calcularTotalVendaCarrinho();
  const totalPago = calcularValorPagoParcialmente();

  if (Math.abs(totalVenda - totalPago) > 0.01) {
    alert("O total pago ainda não cobre o valor da venda!");
    return;
  }

  const pagamentosFinalizados = pagamentosParciaisVenda.map(p => ({ ...p, valor: r2(p.valor) }));
  const valorBruto = calcularTotalVendaCarrinho();
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
    status: "CONCLUIDA",
    itens: itensVenda
  };

  setDoc(doc(db, "vendas", String(novoId)), venda);

  ultimaVendaId = novoId;
  ultimaVendaObjeto = venda;

  document.getElementById("resumo-modal-venda").innerHTML = `
    <div>Venda #${esc(novoId)} — Total: R$ ${valorFinal.toFixed(2)}</div>
    <div style="font-size:0.84rem; color:#e0e7ff; margin-top:0.25rem;">${esc(formatarPagamentoTexto(venda))}</div>
  `;
  document.getElementById("modal-pos-venda").classList.add("active");
  document.getElementById("btn-confirmar-impressao").focus();
}

function confirmarImpressaoPosVenda(desejaImprimir) {
  document.getElementById("modal-pos-venda").classList.remove("active");

  if (desejaImprimir && ultimaVendaId) {
    imprimirCupomVenda80mm(ultimaVendaId, () => {
      bloquearCaixa();
    });
  } else {
    bloquearCaixa();
  }
}

// 9. ABA DE VENDAS E CANCELAMENTO COM AUDITORIA (ADMIN VS. OPERADOR)
function podeCancelarVenda(venda) {
  if (!usuarioLogado || venda.status === "CANCELADA") return false;
  if (usuarioLogado.isAdmin) return true;
  return Boolean(turnoAtivo && mesmoId(venda.turnoId, turnoAtivo.id) && mesmoId(venda.usuarioId, usuarioLogado.id));
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

  if (!vendas.length) {
    container.innerHTML = `<p style="color:var(--text-muted); margin-top:0.5rem; font-weight:600;">Nenhuma venda encontrada para este filtro.</p>`;
    return;
  }

  container.innerHTML = vendas.map(v => {
    const cancelada = v.status === "CANCELADA";
    const ocultaNoCaixa = cancelada && v.constarNoFechamento === false;
    const nomeOperador = obterNomePerfil(v.usuarioId, v.operadorNome);
    const permiteCancelar = podeCancelarVenda(v);

    return `
      <div class="venda-card ${cancelada ? "venda-cancelada" : ""}">
        <div style="flex: 1; min-width: 240px;">
          <div class="venda-meta-row">
            <strong class="mono">#${esc(v.id)}</strong>
            <span class="badge ${cancelada ? "badge-closed" : "badge-open"}">${esc(v.status)}</span>
            ${ocultaNoCaixa && usuarioLogado.isAdmin ? `<span class="badge badge-oculta">Oculta no caixa</span>` : ""}
            <span class="badge badge-pagamento">${esc(formatarPagamentoTexto(v))}</span>
            <span style="font-size:0.82rem; font-weight:600; color:var(--text-muted);">
              ${new Date(v.dataHora).toLocaleString("pt-BR")} • ${esc(nomeOperador)} (Turno #${esc(v.turnoId)})
            </span>
          </div>
          <div class="venda-itens-texto">
            ${esc(v.itens.map(i => `${i.quantidade}x ${i.nomeSnapshot}`).join(", "))}
          </div>
          ${cancelada ? `
            <div class="motivo-cancelamento">
              <i class="ri-close-circle-line"></i> Cancelada por ${esc(v.canceladoPor || "Sistema")} em ${v.dataHoraCancelamento ? new Date(v.dataHoraCancelamento).toLocaleString("pt-BR") : "---"} — Motivo: "${esc(v.motivoCancelamento || "Não informado")}"
            </div>
          ` : ""}
        </div>

        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <strong class="mono venda-valor-texto">
            R$ ${v.valorFinal.toFixed(2)}
          </strong>
          <button class="btn btn-secondary btn-sm" onclick="imprimirCupomVenda80mm('${esc(v.id)}')">
            <i class="ri-printer-line"></i> 2ª Via
          </button>
          ${permiteCancelar ? `
            <button class="btn btn-danger btn-sm" onclick="abrirModalCancelamento('${esc(v.id)}')">
              <i class="ri-close-circle-line"></i> Cancelar
            </button>
          ` : ""}
        </div>
      </div>
    `;
  }).join("");
}

function abrirModalCancelamento(vendaId) {
  const v = buscarVenda(vendaId);
  if (!v || !podeCancelarVenda(v)) return;

  document.getElementById("cancelar-venda-id").value = v.id;
  document.getElementById("cancelar-venda-motivo").value = "";
  document.getElementById("cancelar-venda-info").textContent =
    `Venda #${v.id} — R$ ${v.valorFinal.toFixed(2)} (${formatarPagamentoTexto(v)}). Informe o motivo do cancelamento:`;

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

// 10. DASHBOARD ANALÍTICO (PALETA SAAS ROXO & VERDE-ÁGUA)
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

  const faturamentoTotal = r2(vendasConcluidas.reduce((acc, v) => acc + v.valorFinal, 0));
  let totalItensVendidos = 0;

  const vendasPorHora = Array(24).fill(0);
  const rankingProdutos = {};

  vendasConcluidas.forEach(v => {
    const hora = new Date(v.dataHora).getHours();
    vendasPorHora[hora] += 1;

    v.itens.forEach(item => {
      totalItensVendidos += item.quantidade;
      rankingProdutos[item.nomeSnapshot] = (rankingProdutos[item.nomeSnapshot] || 0) + item.quantidade;
    });
  });

  const maxVendasHora = Math.max(...vendasPorHora);
  const indicePico = maxVendasHora > 0 ? vendasPorHora.indexOf(maxVendasHora) : -1;
  const textoPico = indicePico >= 0
    ? `${String(indicePico).padStart(2, "0")}h (${maxVendasHora} ${maxVendasHora === 1 ? "venda" : "vendas"})`
    : "---";

  document.getElementById("kpi-faturamento").textContent = `R$ ${faturamentoTotal.toFixed(2)}`;
  document.getElementById("kpi-qtd-vendas").textContent = String(vendasConcluidas.length);
  document.getElementById("kpi-itens-vendidos").textContent = String(totalItensVendidos);
  document.getElementById("kpi-hora-pico").textContent = textoPico;

  const top10 = Object.entries(rankingProdutos)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (typeof Chart === "undefined") return;

  Chart.defaults.color = "#475569";
  Chart.defaults.borderColor = "#e2e8f0";

  const ctxPicos = document.getElementById("chart-picos")?.getContext("2d");
  if (ctxPicos) {
    if (chartInstanciaPicos) chartInstanciaPicos.destroy();
    chartInstanciaPicos = new Chart(ctxPicos, {
      type: "bar",
      data: {
        labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}h`),
        datasets: [{
          label: "Vendas no Horário",
          data: vendasPorHora,
          backgroundColor: "#5b46f6",
          hoverBackgroundColor: "#4338ca",
          borderColor: "#4338ca",
          borderWidth: 0,
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
  }

  const ctxProdutos = document.getElementById("chart-produtos")?.getContext("2d");
  if (ctxProdutos) {
    if (chartInstanciaProdutos) chartInstanciaProdutos.destroy();
    chartInstanciaProdutos = new Chart(ctxProdutos, {
      type: "bar",
      data: {
        labels: top10.length ? top10.map(item => item[0]) : ["Sem vendas"],
        datasets: [{
          label: "Unidades Vendidas",
          data: top10.length ? top10.map(item => item[1]) : [0],
          backgroundColor: "#059669",
          hoverBackgroundColor: "#047857",
          borderColor: "#047857",
          borderWidth: 0,
          borderRadius: 6
        }]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
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

function abrirTurno(tipoTurno) {
  if (!usuarioLogado || abrindoTurno) return;

  const turnoExistente = obterTurnoAbertoDoUsuario(usuarioLogado.id);
  if (turnoExistente) {
    alert(`Você já possui um turno aberto (${turnoExistente.tipoTurno}). Encerre-o antes de abrir outro.`);
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
    dataHoraAbertura: Date.now(),
    dataHoraFechamento: null,
    status: "ABERTO"
  };

  // Ativa localmente na hora, sem esperar a resposta da nuvem
  turnoAtivo = novoTurno;
  if (!cacheTurnos.some(t => mesmoId(t.id, novoId))) cacheTurnos.push(novoTurno);
  atualizarStatusTurnoUI();

  setDoc(doc(db, "turnos", String(novoId)), novoTurno)
    .catch(erro => console.error("Erro ao abrir turno:", erro))
    .finally(() => {
      abrindoTurno = false;
      document.querySelectorAll(".turno-actions button").forEach(b => { b.disabled = false; });
    });
}

function fecharTurnoAtual(modoImpressao = null) {
  if (!turnoAtivo) return;

  const vendasDoTurno = cacheVendas.filter(v => mesmoId(v.turnoId, turnoAtivo.id) && v.status === "CONCLUIDA");
  const totalDoTurno = r2(vendasDoTurno.reduce((acc, v) => acc + v.valorFinal, 0));
  const confirmou = confirm(
    `Encerrar o turno ${turnoAtivo.tipoTurno}?\n\n` +
    `${vendasDoTurno.length} ${vendasDoTurno.length === 1 ? "venda" : "vendas"} — Total R$ ${totalDoTurno.toFixed(2)}`
  );
  if (!confirmou) return;

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
  const infoTurno = document.getElementById("info-turno-atual");

  if (turnoAtivo) {
    const nomeAtual = obterNomePerfil(turnoAtivo.usuarioId, turnoAtivo.operadorNome);
    badge.textContent = `Caixa Aberto: ${turnoAtivo.tipoTurno}`;
    badge.className = "badge badge-open";
    aviso.classList.add("hidden");
    pdvArea.classList.remove("hidden");

    infoTurno.innerHTML = `
      <p style="margin:0.6rem 0; color:var(--text-muted); font-weight:600;">
        Operador: <strong style="color:var(--text-main);">${esc(nomeAtual)}</strong> |
        Turno: <strong style="color:var(--text-main);">${esc(turnoAtivo.tipoTurno)}</strong> |
        Abertura: ${new Date(turnoAtivo.dataHoraAbertura).toLocaleString("pt-BR")}
      </p>
      <div style="display:flex; gap:0.6rem; flex-wrap:wrap; margin-top:0.85rem;">
        <button class="btn btn-primary" onclick="imprimirRelatorioTurno80mm('${esc(turnoAtivo.id)}', 'vendas')">
          <i class="ri-printer-line"></i> Parcial (Por Vendas)
        </button>
        <button class="btn btn-primary" onclick="imprimirRelatorioTurno80mm('${esc(turnoAtivo.id)}', 'produtos')">
          <i class="ri-list-check-2"></i> Parcial (Por Produtos)
        </button>
        <button class="btn btn-danger-solid" onclick="fecharTurnoAtual('vendas')">
          <i class="ri-lock-password-line"></i> Encerrar (Por Vendas)
        </button>
        <button class="btn btn-danger-solid" onclick="fecharTurnoAtual('produtos')">
          <i class="ri-lock-password-line"></i> Encerrar (Por Produtos)
        </button>
        <button class="btn btn-secondary" onclick="fecharTurnoAtual(null)">
          Encerrar sem Imprimir
        </button>
      </div>
    `;
  } else {
    badge.textContent = "Caixa Fechado";
    badge.className = "badge badge-closed";
    aviso.classList.remove("hidden");
    pdvArea.classList.add("hidden");
    infoTurno.innerHTML = `<p style="color:var(--text-muted); margin-top:0.5rem; font-weight:600;">Você não possui turno aberto no momento. Abra seu caixa na aba PDV.</p>`;
  }
}

// 12. CARRINHO
// Adiciona pelo ID do produto (nome e preço vêm do catálogo, nunca do HTML)
function adicionarProdutoPorId(produtoId) {
  const p = cacheProdutos.find(item => item.id === Number(produtoId) && item.ativo);
  if (!p) return;
  const sub = p.subcategoria || "Diversos";
  adicionarAoCarrinho(p.id, `${p.nome} (${sub})`, p.precoUnitario);
}

function adicionarAoCarrinho(produtoId, nomeSnapshot, precoUnitarioSnapshot) {
  const itemExistente = carrinho.find(i => i.produtoId === produtoId);
  if (itemExistente) {
    itemExistente.quantidade += 1;
    itemExistente.subtotal = r2(itemExistente.quantidade * itemExistente.precoUnitarioSnapshot);
  } else {
    carrinho.push({
      produtoId,
      nomeSnapshot,
      precoUnitarioSnapshot,
      quantidade: 1,
      subtotal: precoUnitarioSnapshot
    });
  }
  atualizarCarrinhoUI();
}

function alterarQtdItem(index, delta) {
  carrinho[index].quantidade += delta;
  if (carrinho[index].quantidade <= 0) {
    carrinho.splice(index, 1);
  } else {
    carrinho[index].subtotal = r2(carrinho[index].quantidade * carrinho[index].precoUnitarioSnapshot);
  }
  atualizarCarrinhoUI();
}

function limparCarrinho() {
  carrinho = [];
  atualizarCarrinhoUI();
}

function atualizarCarrinhoUI() {
  const container = document.getElementById("lista-carrinho");
  if (!container) return;

  if (!carrinho.length) {
    container.innerHTML = `<p style="color:var(--text-muted); font-weight:600;">Nenhum item selecionado.</p>`;
  } else {
    container.innerHTML = carrinho.map((item, idx) => `
      <div class="item-carrinho">
        <div>
          <strong>${esc(item.nomeSnapshot)}</strong>
          <div class="mono" style="font-size:0.84rem; font-weight:700; color:var(--text-muted);">
            ${item.quantidade}x R$ ${item.precoUnitarioSnapshot.toFixed(2)} = R$ ${item.subtotal.toFixed(2)}
          </div>
        </div>
        <div style="display:flex; gap:0.35rem;">
          <button class="btn btn-secondary btn-sm" onclick="alterarQtdItem(${idx}, -1)">-</button>
          <button class="btn btn-secondary btn-sm" onclick="alterarQtdItem(${idx}, 1)">+</button>
          <button class="btn btn-danger btn-sm" onclick="alterarQtdItem(${idx}, -999)">✕</button>
        </div>
      </div>
    `).join("");
  }

  const total = calcularTotalVendaCarrinho();
  document.getElementById("valor-final").textContent = `R$ ${total.toFixed(2)}`;
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
    container.innerHTML = `<p style="color:var(--text-muted); font-weight:600;">Nenhum turno registrado para este filtro.</p>`;
    return;
  }

  container.innerHTML = turnos.map(t => {
    const nomeOperadorAtual = obterNomePerfil(t.usuarioId, t.operadorNome);
    const vendasTurno = vendasConhecidas
      .filter(v => mesmoId(v.turnoId, t.id) && v.status === "CONCLUIDA")
      .sort((a, b) => a.dataHora - b.dataHora);
    const canceladasVisiveis = vendasConhecidas.filter(
      v => mesmoId(v.turnoId, t.id) && v.status === "CANCELADA" && v.constarNoFechamento !== false
    );
    const totalTurno = r2(vendasTurno.reduce((acc, v) => acc + v.valorFinal, 0));

    const listaVendasHTML = vendasTurno.length
      ? vendasTurno.map(v => `
          <div class="venda-linha">
            <div>
              <span class="mono">#${esc(v.id)} (${new Date(v.dataHora).toLocaleTimeString("pt-BR")})</span>
              <span class="badge badge-pagamento" style="margin:0 0.3rem;">${esc(formatarPagamentoTexto(v))}</span>
              ${esc(v.itens.map(i => `${i.quantidade}x ${i.nomeSnapshot}`).join(", "))}
            </div>
            <div style="display:flex; align-items:center; gap:0.6rem;">
              <strong class="mono" style="color:var(--success-text); font-weight:800;">R$ ${v.valorFinal.toFixed(2)}</strong>
              <button class="btn btn-secondary btn-sm" onclick="imprimirCupomVenda80mm('${esc(v.id)}')">
                <i class="ri-printer-line"></i> 2ª Via
              </button>
            </div>
          </div>
        `).join("")
      : `<small style="color:var(--text-muted); font-weight:600;">Nenhuma venda concluída neste turno.</small>`;

    return `
      <div class="turno-historico-card">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
          <div>
            <strong>Turno #${esc(t.id)} — ${esc(t.tipoTurno)}</strong>
            <span class="badge ${t.status === 'ABERTO' ? 'badge-open' : 'badge-closed'}">${esc(t.status)}</span>
            <div style="font-size:0.84rem; font-weight:600; color:var(--text-muted); margin-top:0.25rem;">
              Operador: <strong style="color:var(--text-main);">${esc(nomeOperadorAtual)}</strong> |
              Início: ${new Date(t.dataHoraAbertura).toLocaleString("pt-BR")}
              ${t.dataHoraFechamento ? ` | Fim: ${new Date(t.dataHoraFechamento).toLocaleString("pt-BR")}` : ""}
            </div>
            <div style="margin-top:0.35rem; font-size:0.92rem; font-weight:700;">
              Vendas: <strong>${vendasTurno.length}</strong>
              ${canceladasVisiveis.length ? ` | <span style="color:var(--danger);">Canceladas: ${canceladasVisiveis.length}</span>` : ""} |
              Total do Turno: <strong class="mono" style="color:var(--success-text);">R$ ${totalTurno.toFixed(2)}</strong>
            </div>
          </div>
          <div style="display:flex; gap:0.45rem; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="imprimirRelatorioTurno80mm('${esc(t.id)}', 'vendas')">
              <i class="ri-printer-cloud-line"></i> Por Vendas
            </button>
            <button class="btn btn-secondary btn-sm" onclick="imprimirRelatorioTurno80mm('${esc(t.id)}', 'produtos')">
              <i class="ri-list-check-2"></i> Por Produtos
            </button>
          </div>
        </div>

        <div class="vendas-sublista">
          ${listaVendasHTML}
        </div>
      </div>
    `;
  }).join("");
}

// 14. MOTOR DE IMPRESSÃO TÉRMICA 80MM (ELGIN i8)
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
            <td class="cupom-right">${i.quantidade}x ${i.precoUnitarioSnapshot.toFixed(2)}</td>
            <td class="cupom-right">${i.subtotal.toFixed(2)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <div class="cupom-divider"></div>
    ${v.desconto > 0 ? `
      <div>Subtotal Bruto: R$ ${v.valorBruto.toFixed(2)}</div>
      <div>Desconto: R$ ${v.desconto.toFixed(2)}</div>
    ` : ""}
    <div class="cupom-total">TOTAL: R$ ${v.valorFinal.toFixed(2)}</div>

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
    .map(([label, valor]) => `<div>${esc(label)}: R$ ${valor.toFixed(2)}</div>`)
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
              <td class="cupom-right">${p.total.toFixed(2)}</td>
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
              <td class="cupom-right">${v.valorFinal.toFixed(2)}</td>
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

    <div class="cupom-divider"></div>
    <strong>RESUMO POR PAGAMENTO:</strong>
    ${linhasResumoPag || "<div>Sem movimentação</div>"}

    <div class="cupom-divider"></div>
    <div>Qtd. Vendas Concluídas: ${vendas.length}</div>
    ${totalDescontos > 0 ? `
      <div>Total Bruto: R$ ${totalBruto.toFixed(2)}</div>
      <div>Total Descontos: R$ ${totalDescontos.toFixed(2)}</div>
    ` : ""}
    <div class="cupom-total">TOTAL DO TURNO: R$ ${totalLiquido.toFixed(2)}</div>
    ${canceladas.length ? `<div style="margin-top:4px; font-size:11px;">Auditoria - Canceladas: ${canceladas.length} (R$ ${totalCancelado.toFixed(2)})</div>` : ""}

    <div class="cupom-footer">
      Fechamento emitido em ${new Date().toLocaleString("pt-BR")}
    </div>
  `;

  window.print();
}

// Expõe todas as funções para os eventos inline do HTML
Object.assign(window, {
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
  limparCarrinho,
  atualizarCarrinhoUI,
  carregarHistoricoTurnos,
  imprimirCupomVenda80mm,
  imprimirRelatorioTurno80mm
});
