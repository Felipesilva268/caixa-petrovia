import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

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

// Habilita banco de dados com persistência Offline no navegador
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

let usuarioLogado = null;
let turnoAtivo = null;
let carrinho = [];
let ultimaVendaId = null;

let categoriaAtivaPDV = "TODAS";
let subcategoriaAtivaPDV = "TODAS";

const SENHA_MASTER = "admin123";

const MAPA_CATEGORIAS = {
  "Cervejas": ["Latão", "Big Latão", "Palito", "Sleek", "Long", "Litrinho", "Litrão", "Outros"],
  "Refrigerantes": ["Lata", "600ml", "1 Litro", "2 Litros", "Outros"],
  "Energéticos": ["Lata (250/269ml)", "Latão (473ml)", "Garrafa 2L", "Outros"],
  "Águas & Sucos": ["Sem Gás", "Com Gás", "Suco", "Água de Coco", "Gelo", "Outros"],
  "Automotivos": ["Óleo Lubrificante", "Aditivo", "Fluído de Freio", "Estética / Limpeza", "Outros"],
  "Conveniência": ["Cigarros", "Salgados / Doces", "Carvão", "Diversos"]
};

// Gera um ID numérico sequencial limpo (#1, #2, #3...)
function gerarProximoId(lista) {
  if (!lista.length) return 1;
  return Math.max(...lista.map(item => Number(item.id) || 0)) + 1;
}

// 2. ESCUTA EM TEMPO REAL DO FIREBASE (SINCRONIZAÇÃO ENTRE TELAS)
function iniciarSincronizacaoFirebase() {
  onSnapshot(collection(db, "usuarios"), (snapshot) => {
    cacheUsuarios = snapshot.docs.map(d => d.data());
    if (usuarioLogado?.isAdmin) carregarOperadores();
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
    }
  });

  onSnapshot(collection(db, "vendas"), (snapshot) => {
    cacheVendas = snapshot.docs.map(d => d.data());
    if (usuarioLogado) carregarHistoricoTurnos();
  });
}

// Inicialização da interface
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

function atualizarSubcategoriasForm() {
  const catSelecionada = document.getElementById("prod-categoria").value;
  const selectSub = document.getElementById("prod-subcategoria");
  const subcategorias = MAPA_CATEGORIAS[catSelecionada] || ["Geral"];

  selectSub.innerHTML = subcategorias.map(sub => `<option value="${sub}">${sub}</option>`).join("");
}

// 3. ATALHO GLOBAL DA TECLA ESC (LIMPA CARRINHO E TRAVA CAIXA)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modalPosVenda = document.getElementById("modal-pos-venda");
    if (modalPosVenda.classList.contains("active")) {
      confirmarImpressaoPosVenda(false);
      return;
    }

    const modalBloqueio = document.getElementById("modal-bloqueio");
    if (!modalBloqueio.classList.contains("active")) {
      e.preventDefault();
      bloquearCaixa();
    }
  }
});

function focarInputSenha() {
  setTimeout(() => {
    const input = document.getElementById("input-senha-acesso");
    if (input) input.focus();
  }, 80);
}

// 4. AUTENTICAÇÃO TRANSACIONAL E BLOQUEIO (ESC)
function autenticarOperador(e) {
  e.preventDefault();
  const input = document.getElementById("input-senha-acesso");
  const senhaDigitada = input.value.trim();
  const msgErro = document.getElementById("msg-erro-login");

  if (senhaDigitada === SENHA_MASTER) {
    usuarioLogado = { id: "admin", nome: "Admin Master", isAdmin: true };
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

  document.getElementById("input-senha-acesso").value = "";
  document.getElementById("msg-erro-login").classList.add("hidden");
  document.getElementById("modal-bloqueio").classList.remove("active");

  document.getElementById("badge-operador").innerHTML = `
    <i class="ri-user-3-line"></i> ${usuarioLogado.nome}
  `;

  const tabAdmin = document.getElementById("tab-admin");
  if (usuarioLogado.isAdmin) {
    tabAdmin.classList.remove("hidden");
    carregarOperadores();
  } else {
    tabAdmin.classList.add("hidden");
  }

  navegar("pdv", document.getElementById("tab-pdv"));
  verificarTurnoAbertoDoUsuario();
  carregarProdutos();
  carregarHistoricoTurnos();
}

function bloquearCaixa() {
  limparCarrinho();
  usuarioLogado = null;
  turnoAtivo = null;

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

  if (aba === "turnos") carregarHistoricoTurnos();
  if (aba === "produtos") carregarProdutos();
  if (aba === "admin" && usuarioLogado?.isAdmin) carregarOperadores();
}

// 6. GESTÃO DE OPERADORES (ABA ADMIN)
function salvarOperador(e) {
  e.preventDefault();
  const nome = document.getElementById("op-nome").value.trim();
  const senha = document.getElementById("op-senha").value.trim();

  if (senha === SENHA_MASTER) {
    alert("Essa senha já é reservada ao Admin Master. Escolha outra.");
    return;
  }

  const jaExiste = cacheUsuarios.some(u => u.senha === senha && u.ativo !== false);
  if (jaExiste) {
    alert("Já existe um operador usando esta senha. Escolha uma senha diferente.");
    return;
  }

  const novoId = gerarProximoId(cacheUsuarios);
  const novoOperador = { id: novoId, nome, senha, ativo: true };

  setDoc(doc(db, "usuarios", String(novoId)), novoOperador);
  document.getElementById("form-operador").reset();
}

function removerOperador(id) {
  deleteDoc(doc(db, "usuarios", String(id)));
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
        <strong>${op.nome}</strong>
        <div class="mono" style="font-size:0.82rem; color:var(--text-muted);">Senha: ${op.senha} | ID: #${op.id}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removerOperador(${op.id})">
        <i class="ri-delete-bin-line"></i> Excluir
      </button>
    </div>
  `).join("");
}

// 7. CATÁLOGO DE PRODUTOS, AGRUPAMENTO POR CATEGORIA E ORDENAÇÃO
function salvarProduto(e) {
  e.preventDefault();
  const nome = document.getElementById("prod-nome").value.trim();
  const categoria = document.getElementById("prod-categoria").value;
  const subcategoria = document.getElementById("prod-subcategoria").value;
  const precoUnitario = parseFloat(document.getElementById("prod-preco").value);
  const codigoInterno = document.getElementById("prod-codigo").value.trim();

  const novoId = gerarProximoId(cacheProdutos);
  const novoProd = {
    id: novoId,
    nome,
    categoria,
    subcategoria,
    precoUnitario,
    codigoInterno,
    ativo: true
  };

  setDoc(doc(db, "produtos", String(novoId)), novoProd);

  document.getElementById("prod-nome").value = "";
  document.getElementById("prod-preco").value = "";
  document.getElementById("prod-codigo").value = "";
}

function selecionarCategoriaPDV(cat) {
  categoriaAtivaPDV = cat;
  subcategoriaAtivaPDV = "TODAS";
  carregarProdutos();
}

function selecionarSubcategoriaPDV(sub) {
  subcategoriaAtivaPDV = sub;
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
      onclick="selecionarCategoriaPDV('${cat}')"
    >
      ${cat === "TODAS" ? "Catálogo Completo (Todos)" : cat}
    </button>
  `).join("");

  if (categoriaAtivaPDV !== "TODAS" && MAPA_CATEGORIAS[categoriaAtivaPDV]) {
    const subs = ["TODAS", ...MAPA_CATEGORIAS[categoriaAtivaPDV]];
    barraSub.classList.remove("hidden");
    barraSub.innerHTML = subs.map(sub => `
      <button 
        type="button"
        class="pill-btn ${subcategoriaAtivaPDV === sub ? 'active' : ''}" 
        onclick="selecionarSubcategoriaPDV('${sub}')"
      >
        ${sub === "TODAS" ? "Todos os tamanhos" : sub}
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

function carregarProdutos() {
  renderizarFiltrosCategoriaPDV();

  const termoBusca = (document.getElementById("busca-produto-pdv")?.value || "").toLowerCase();
  const criterioOrdemPDV = document.getElementById("ordenacao-pdv")?.value || "nome-asc";
  const filtroCatCadastro = document.getElementById("filtro-cat-cadastro")?.value || "TODAS";
  const criterioOrdemCadastro = document.getElementById("ordenacao-cadastro")?.value || "nome-asc";

  const todosAtivos = cacheProdutos
    .filter(p => p.ativo)
    .map(p => ({
      ...p,
      categoria: p.categoria || "Conveniência",
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
  const prod = cacheProdutos.find(p => p.id === id);
  if (!prod) return;
  setDoc(doc(db, "produtos", String(id)), { ...prod, ativo: false });
}

function renderizarGradePDV(produtos, criterioOrdem) {
  const container = document.getElementById("grade-produtos-pdv");
  if (!produtos.length) {
    container.innerHTML = `<p style="color:var(--text-muted);">Nenhum produto cadastrado ou encontrado para este filtro.</p>`;
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
        const nomeCompleto = `${p.nome} (${p.subcategoria})`;
        return `
          <div class="produto-card" onclick="adicionarAoCarrinho(${p.id}, '${nomeCompleto.replace(/'/g, "\\'")}', ${p.precoUnitario})">
            <div>
              <span class="prod-cat-tag">${p.subcategoria}</span>
              <strong>${p.nome}</strong>
            </div>
            <span class="preco-tag">R$ ${p.precoUnitario.toFixed(2)}</span>
          </div>
        `;
      }).join("");

      return `
        <div class="subcategoria-bloco">
          <div class="subcategoria-titulo">${sub}</div>
          <div class="produtos-grid">${cardsHTML}</div>
        </div>
      `;
    }).join("");

    return `
      <div class="catalogo-secao">
        <div class="catalogo-secao-header">
          <h3><i class="ri-folder-open-line"></i> ${categoria}</h3>
          <span class="badge badge-user">${produtosDaCategoria.length} ${produtosDaCategoria.length === 1 ? 'item' : 'itens'}</span>
        </div>
        ${blocosSubcategoriaHTML}
      </div>
    `;
  }).join("");

  container.innerHTML = secoesHTML;
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
          <span class="prod-cat-tag">${p.subcategoria}</span>
          <strong>${p.nome}</strong> ${p.codigoInterno ? `<small>(${p.codigoInterno})</small>` : ""}
          <div class="mono" style="color:var(--success); font-size:0.85rem; margin-top:0.15rem;">
            R$ ${p.precoUnitario.toFixed(2)}
          </div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="desativarProduto(${p.id})">Remover</button>
      </div>
    `).join("");

    return `
      <div class="catalogo-secao" style="margin-bottom: 1rem;">
        <div class="catalogo-secao-header">
          <h3><i class="ri-price-tag-3-line"></i> ${categoria}</h3>
          <span class="badge badge-user">${itensCat.length}</span>
        </div>
        ${linhasHTML}
      </div>
    `;
  }).join("");
}

// 8. TURNOS INDEPENDENTES POR USUÁRIO
function verificarTurnoAbertoDoUsuario() {
  if (!usuarioLogado) return;
  turnoAtivo = cacheTurnos.find(
    t => t.status === "ABERTO" && t.usuarioId === usuarioLogado.id
  ) || null;
  atualizarStatusTurnoUI();
}

function abrirTurno(tipoTurno) {
  if (!usuarioLogado) return;
  const novoId = gerarProximoId(cacheTurnos);
  const novoTurno = {
    id: novoId,
    usuarioId: usuarioLogado.id,
    operadorNome: usuarioLogado.nome,
    tipoTurno,
    dataHoraAbertura: Date.now(),
    dataHoraFechamento: null,
    status: "ABERTO"
  };

  setDoc(doc(db, "turnos", String(novoId)), novoTurno);
}

function fecharTurnoAtual(imprimirFechamento = false) {
  if (!turnoAtivo) return;
  const turnoIdParaImprimir = turnoAtivo.id;

  const turnoEncerrado = {
    ...turnoAtivo,
    status: "FECHADO",
    dataHoraFechamento: Date.now()
  };

  setDoc(doc(db, "turnos", String(turnoAtivo.id)), turnoEncerrado);
  limparCarrinho();

  if (imprimirFechamento) {
    setTimeout(() => imprimirRelatorioTurno80mm(turnoIdParaImprimir), 150);
  }
}

function atualizarStatusTurnoUI() {
  const badge = document.getElementById("status-turno-badge");
  const aviso = document.getElementById("aviso-turno-fechado");
  const pdvArea = document.getElementById("area-operacao-pdv");
  const infoTurno = document.getElementById("info-turno-atual");

  if (turnoAtivo) {
    badge.textContent = `Caixa Aberto: ${turnoAtivo.tipoTurno}`;
    badge.className = "badge badge-open";
    aviso.classList.add("hidden");
    pdvArea.classList.remove("hidden");

    infoTurno.innerHTML = `
      <p style="margin:0.6rem 0; color:var(--text-muted);">
        Operador: <strong style="color:var(--text-main);">${turnoAtivo.operadorNome}</strong> |
        Turno: <strong style="color:var(--text-main);">${turnoAtivo.tipoTurno}</strong> |
        Abertura: ${new Date(turnoAtivo.dataHoraAbertura).toLocaleString("pt-BR")}
      </p>
      <div style="display:flex; gap:0.75rem; flex-wrap:wrap; margin-top:0.75rem;">
        <button class="btn btn-primary" onclick="imprimirRelatorioTurno80mm(${turnoAtivo.id})">
          <i class="ri-printer-line"></i> Imprimir Parcial do Turno
        </button>
        <button class="btn btn-danger" onclick="fecharTurnoAtual(true)">
          <i class="ri-lock-password-line"></i> Encerrar e Imprimir Fechamento
        </button>
        <button class="btn btn-secondary" onclick="fecharTurnoAtual(false)">
          Encerrar sem Imprimir
        </button>
      </div>
    `;
  } else {
    badge.textContent = "Caixa Fechado";
    badge.className = "badge badge-closed";
    aviso.classList.remove("hidden");
    pdvArea.classList.add("hidden");
    infoTurno.innerHTML = `<p style="color:var(--text-muted); margin-top:0.5rem;">Você não possui turno aberto no momento. Abra seu caixa na aba PDV.</p>`;
  }
}

// 9. CARRINHO E FINALIZAÇÃO DE VENDA DIRETA
function adicionarAoCarrinho(produtoId, nomeSnapshot, precoUnitarioSnapshot) {
  const itemExistente = carrinho.find(i => i.produtoId === produtoId);
  if (itemExistente) {
    itemExistente.quantidade += 1;
    itemExistente.subtotal = itemExistente.quantidade * itemExistente.precoUnitarioSnapshot;
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
    carrinho[index].subtotal = carrinho[index].quantidade * carrinho[index].precoUnitarioSnapshot;
  }
  atualizarCarrinhoUI();
}

function limparCarrinho() {
  carrinho = [];
  const inputDesc = document.getElementById("input-desconto");
  if (inputDesc) inputDesc.value = 0;
  atualizarCarrinhoUI();
}

function atualizarCarrinhoUI() {
  const container = document.getElementById("lista-carrinho");
  if (!container) return;

  if (!carrinho.length) {
    container.innerHTML = `<p style="color:var(--text-muted);">Nenhum item selecionado.</p>`;
  } else {
    container.innerHTML = carrinho.map((item, idx) => `
      <div class="item-carrinho">
        <div>
          <strong>${item.nomeSnapshot}</strong>
          <div class="mono" style="font-size:0.82rem; color:var(--text-muted);">
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

  const bruto = carrinho.reduce((acc, i) => acc + i.subtotal, 0);
  const desconto = parseFloat(document.getElementById("input-desconto")?.value) || 0;
  const final = Math.max(0, bruto - desconto);

  document.getElementById("valor-bruto").textContent = `R$ ${bruto.toFixed(2)}`;
  document.getElementById("valor-final").textContent = `R$ ${final.toFixed(2)}`;
}

function finalizarVenda() {
  if (!usuarioLogado || !turnoAtivo || !carrinho.length) return;

  const valorBruto = carrinho.reduce((acc, i) => acc + i.subtotal, 0);
  const desconto = parseFloat(document.getElementById("input-desconto").value) || 0;
  const valorFinal = Math.max(0, valorBruto - desconto);

  const novoId = gerarProximoId(cacheVendas);
  const venda = {
    id: novoId,
    turnoId: turnoAtivo.id,
    usuarioId: usuarioLogado.id,
    operadorNome: usuarioLogado.nome,
    dataHora: Date.now(),
    valorBruto,
    desconto,
    valorFinal,
    status: "CONCLUIDA",
    itens: [...carrinho]
  };

  // Grava imediatamente no cache local e sincroniza na nuvem do Firebase
  setDoc(doc(db, "vendas", String(novoId)), venda);

  ultimaVendaId = novoId;
  document.getElementById("resumo-modal-venda").textContent = `Total: R$ ${valorFinal.toFixed(2)}`;
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

// 10. HISTÓRICO, 2ª VIA DE VENDA E IMPRESSÃO DO TURNO COMPLETO
function carregarHistoricoTurnos() {
  if (!usuarioLogado) return;
  const filtroData = document.getElementById("filtro-data").value;

  let turnos = [...cacheTurnos]
    .filter(t => usuarioLogado.isAdmin || t.usuarioId === usuarioLogado.id)
    .sort((a, b) => b.dataHoraAbertura - a.dataHoraAbertura);

  if (filtroData) {
    turnos = turnos.filter(t => {
      const dataIso = new Date(t.dataHoraAbertura).toISOString().split("T")[0];
      return dataIso === filtroData;
    });
  }

  const container = document.getElementById("lista-historico-turnos");
  if (!turnos.length) {
    container.innerHTML = `<p style="color:var(--text-muted);">Nenhum turno registrado para este filtro.</p>`;
    return;
  }

  container.innerHTML = turnos.map(t => {
    const vendasTurno = cacheVendas
      .filter(v => v.turnoId === t.id && v.status === "CONCLUIDA")
      .sort((a, b) => a.dataHora - b.dataHora);
    const totalTurno = vendasTurno.reduce((acc, v) => acc + v.valorFinal, 0);

    const listaVendasHTML = vendasTurno.length
      ? vendasTurno.map(v => `
          <div class="venda-linha">
            <div>
              <span class="mono">#${v.id} (${new Date(v.dataHora).toLocaleTimeString("pt-BR")})</span> —
              ${v.itens.map(i => `${i.quantidade}x ${i.nomeSnapshot}`).join(", ")}
            </div>
            <div style="display:flex; align-items:center; gap:0.6rem;">
              <strong class="mono" style="color:#34d399;">R$ ${v.valorFinal.toFixed(2)}</strong>
              <button class="btn btn-secondary btn-sm" onclick="imprimirCupomVenda80mm(${v.id})">
                <i class="ri-printer-line"></i> 2ª Via
              </button>
            </div>
          </div>
        `).join("")
      : `<small style="color:var(--text-muted);">Nenhuma venda registrada neste turno.</small>`;

    return `
      <div class="turno-historico-card">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
          <div>
            <strong>Turno #${t.id} — ${t.tipoTurno}</strong>
            <span class="badge ${t.status === 'ABERTO' ? 'badge-open' : 'badge-closed'}">${t.status}</span>
            <div style="font-size:0.83rem; color:var(--text-muted); margin-top:0.25rem;">
              Operador: <strong>${t.operadorNome || "Operador"}</strong> |
              Início: ${new Date(t.dataHoraAbertura).toLocaleString("pt-BR")}
              ${t.dataHoraFechamento ? ` | Fim: ${new Date(t.dataHoraFechamento).toLocaleString("pt-BR")}` : ""}
            </div>
            <div style="margin-top:0.35rem; font-size:0.9rem;">
              Vendas: <strong>${vendasTurno.length}</strong> |
              Total do Turno: <strong class="mono" style="color:#34d399;">R$ ${totalTurno.toFixed(2)}</strong>
            </div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="imprimirRelatorioTurno80mm(${t.id})">
            <i class="ri-printer-cloud-line"></i> Imprimir Turno Completo
          </button>
        </div>

        <div class="vendas-sublista">
          ${listaVendasHTML}
        </div>
      </div>
    `;
  }).join("");
}

// 11. MOTOR DE IMPRESSÃO TÉRMICA 80MM (ELGIN i8)
function imprimirCupomVenda80mm(vendaId, callbackPosImpressao = null) {
  const v = cacheVendas.find(item => item.id === Number(vendaId));
  if (!v) return;

  const area = document.getElementById("area-impressao");
  area.innerHTML = `
    <div class="cupom-header">
      <h3>CAIXA PETROVIA</h3>
      <div>COMPROVANTE DE VENDA #${v.id}</div>
      <div>Operador: ${v.operadorNome || "---"}</div>
      <div>Data: ${new Date(v.dataHora).toLocaleString("pt-BR")}</div>
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
            <td>${i.nomeSnapshot}</td>
            <td class="cupom-right">${i.quantidade}x ${i.precoUnitarioSnapshot.toFixed(2)}</td>
            <td class="cupom-right">${i.subtotal.toFixed(2)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <div class="cupom-divider"></div>
    <div>Subtotal Bruto: R$ ${v.valorBruto.toFixed(2)}</div>
    <div>Desconto: R$ ${v.desconto.toFixed(2)}</div>
    <div class="cupom-total">TOTAL FINAL: R$ ${v.valorFinal.toFixed(2)}</div>

    <div class="cupom-footer">
      Obrigado pela preferência!
    </div>
  `;

  window.print();
  if (callbackPosImpressao) callbackPosImpressao();
}

function imprimirRelatorioTurno80mm(turnoId) {
  const t = cacheTurnos.find(item => item.id === Number(turnoId));
  if (!t) return;

  const vendas = cacheVendas
    .filter(v => v.turnoId === Number(turnoId) && v.status === "CONCLUIDA")
    .sort((a, b) => a.dataHora - b.dataHora);

  const totalBruto = vendas.reduce((acc, v) => acc + v.valorBruto, 0);
  const totalDescontos = vendas.reduce((acc, v) => acc + v.desconto, 0);
  const totalLiquido = vendas.reduce((acc, v) => acc + v.valorFinal, 0);

  const area = document.getElementById("area-impressao");
  area.innerHTML = `
    <div class="cupom-header">
      <h3>CAIXA PETROVIA</h3>
      <div>EXTRATO DE TURNO #${t.id}</div>
      <div>Turno: ${t.tipoTurno} (${t.status})</div>
      <div>Operador: ${t.operadorNome || "---"}</div>
      <div>Início: ${new Date(t.dataHoraAbertura).toLocaleString("pt-BR")}</div>
      <div>Fim: ${t.dataHoraFechamento ? new Date(t.dataHoraFechamento).toLocaleString("pt-BR") : "Em andamento"}</div>
    </div>

    <table class="cupom-table">
      <thead>
        <tr>
          <th>HORA / #ID</th>
          <th>ITENS</th>
          <th class="cupom-right">TOTAL</th>
        </tr>
      </thead>
      <tbody>
        ${vendas.map(v => `
          <tr>
            <td>${new Date(v.dataHora).toLocaleTimeString("pt-BR")} (#${v.id})</td>
            <td>${v.itens.map(i => `${i.quantidade}x ${i.nomeSnapshot}`).join(", ")}</td>
            <td class="cupom-right">${v.valorFinal.toFixed(2)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <div class="cupom-divider"></div>
    <div>Qtd. Vendas: ${vendas.length}</div>
    <div>Total Bruto: R$ ${totalBruto.toFixed(2)}</div>
    <div>Total Descontos: R$ ${totalDescontos.toFixed(2)}</div>
    <div class="cupom-total">TOTAL LÍQUIDO: R$ ${totalLiquido.toFixed(2)}</div>

    <div class="cupom-footer">
      Fechamento emitido em ${new Date().toLocaleString("pt-BR")}
    </div>
  `;

  window.print();
}

// Expõe as funções para os eventos onclick do HTML
Object.assign(window, {
  autenticarOperador,
  bloquearCaixa,
  navegar,
  salvarOperador,
  removerOperador,
  salvarProduto,
  atualizarSubcategoriasForm,
  selecionarCategoriaPDV,
  selecionarSubcategoriaPDV,
  carregarProdutos,
  desativarProduto,
  abrirTurno,
  fecharTurnoAtual,
  adicionarAoCarrinho,
  alterarQtdItem,
  limparCarrinho,
  atualizarCarrinhoUI,
  finalizarVenda,
  confirmarImpressaoPosVenda,
  carregarHistoricoTurnos,
  imprimirCupomVenda80mm,
  imprimirRelatorioTurno80mm
});