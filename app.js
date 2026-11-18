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

let categoriaAtivaPDV = "TODAS";
let subcategoriaAtivaPDV = "TODAS";

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

function gerarProximoId(lista) {
  if (!lista.length) return 1;
  return Math.max(...lista.map(item => Number(item.id) || 0)) + 1;
}

function obterNomePerfil(usuarioId, nomeSalvo) {
  if (usuarioId === "admin") return configMaster.nome;
  const op = cacheUsuarios.find(u => u.id === Number(usuarioId));
  return op ? op.nome : (nomeSalvo || "Operador");
}

// 2. ESCUTA EM TEMPO REAL DO FIREBASE
function iniciarSincronizacaoFirebase() {
  onSnapshot(collection(db, "configuracoes"), (snapshot) => {
    const docMaster = snapshot.docs.find(d => d.id === "master");
    if (docMaster) {
      configMaster = docMaster.data();
      if (usuarioLogado?.isAdmin) {
        usuarioLogado.nome = configMaster.nome;
        document.getElementById("badge-operador").innerHTML = `<i class="ri-user-3-line"></i> ${usuarioLogado.nome}`;
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
        document.getElementById("badge-operador").innerHTML = `<i class="ri-user-3-line"></i> ${usuarioLogado.nome}`;
      }
    }
    if (usuarioLogado?.isAdmin) carregarOperadores();
    if (usuarioLogado) {
      atualizarStatusTurnoUI();
      carregarHistoricoTurnos();
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
    }
  });

  onSnapshot(collection(db, "vendas"), (snapshot) => {
    cacheVendas = snapshot.docs.map(d => d.data());
    if (usuarioLogado) {
      carregarHistoricoTurnos();
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

// 3. MOTOR DE ATALHOS DE TECLADO (100% SHORTCUTS E BIPADOR)
window.addEventListener("keydown", (e) => {
  const modalBloqueio = document.getElementById("modal-bloqueio");
  const modalPosVenda = document.getElementById("modal-pos-venda");

  if (modalBloqueio.classList.contains("active")) return;

  // Se o modal pós-venda estiver aberto: Enter imprime, ESC cancela e bloqueia
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

  switch (e.key) {
    case "Escape":
      e.preventDefault();
      bloquearCaixa();
      break;
    case "F2":
      e.preventDefault();
      if (document.getElementById("tela-pdv").classList.contains("active")) {
        finalizarVenda();
      }
      break;
    case "F4":
      e.preventDefault();
      if (document.getElementById("tela-pdv").classList.contains("active")) {
        const inputBusca = document.getElementById("busca-produto-pdv");
        if (inputBusca) {
          inputBusca.focus();
          inputBusca.select();
        }
      }
      break;
    case "F9":
      e.preventDefault();
      if (document.getElementById("tela-pdv").classList.contains("active")) {
        limparCarrinho();
      }
      break;
  }
});

// Suporte a Leitor de Código de Barras / Enter direto na barra de busca
function processarEnterBuscaPDV(e) {
  if (e.key !== "Enter") return;
  e.preventDefault();

  const input = document.getElementById("busca-produto-pdv");
  const termo = (input.value || "").trim().toLowerCase();
  if (!termo) return;

  const ativos = cacheProdutos.filter(p => p.ativo);

  // 1º Tenta achar pelo código exato (Bipador USB)
  let encontrado = ativos.find(p => p.codigoInterno && p.codigoInterno.toLowerCase() === termo);

  // 2º Se não achou por código, mas só restou 1 produto filtrado na tela, adiciona ele
  if (!encontrado) {
    const filtrados = ativos.filter(p =>
      p.nome.toLowerCase().includes(termo) ||
      (p.subcategoria && p.subcategoria.toLowerCase().includes(termo)) ||
      (p.codigoInterno && p.codigoInterno.toLowerCase().includes(termo))
    );
    if (filtrados.length === 1) {
      encontrado = filtrados[0];
    }
  }

  if (encontrado) {
    const sub = encontrado.subcategoria || "Diversos";
    adicionarAoCarrinho(encontrado.id, `${encontrado.nome} (${sub})`, encontrado.precoUnitario);
    input.value = "";
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
  e.preventDefault();
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

  document.getElementById("input-senha-acesso").value = "";
  document.getElementById("msg-erro-login").classList.add("hidden");
  document.getElementById("modal-bloqueio").classList.remove("active");

  document.getElementById("badge-operador").innerHTML = `
    <i class="ri-user-3-line"></i> ${usuarioLogado.nome}
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
}

function bloquearCaixa() {
  limparCarrinho();
  cancelarEdicaoOperador();
  cancelarEdicaoProduto();
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
        <strong>${op.nome}</strong>
        <div class="mono" style="font-size:0.82rem; color:var(--text-muted);">Senha: ${op.senha} | ID Fixo: #${op.id}</div>
      </div>
      <div style="display:flex; gap:0.4rem;">
        <button class="btn btn-secondary btn-sm" onclick="prepararEdicaoOperador(${op.id})">
          <i class="ri-edit-line"></i> Editar
        </button>
        <button class="btn btn-danger btn-sm" onclick="removerOperador(${op.id})">
          <i class="ri-delete-bin-line"></i> Excluir
        </button>
      </div>
    </div>
  `).join("");
}

// 7. CATÁLOGO DE PRODUTOS, EDIÇÃO, AGRUPAMENTO E ORDENAÇÃO
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
  const precoUnitario = parseFloat(document.getElementById("prod-preco").value);
  const codigoInterno = document.getElementById("prod-codigo").value.trim();

  const idFinal = idEdicao ? Number(idEdicao) : gerarProximoId(cacheProdutos);

  const prodDados = {
    id: idFinal,
    nome,
    categoria,
    subcategoria,
    precoUnitario,
    codigoInterno,
    ativo: true
  };

  setDoc(doc(db, "produtos", String(idFinal)), prodDados);
  cancelarEdicaoProduto();
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
      // Migração transparente: se havia algum item salvo como "Conveniência", mapeia para "Cigarros"
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
          <strong>${p.nome}</strong> ${p.codigoInterno ? `<small class="mono">[${p.codigoInterno}]</small>` : ""}
          <div class="mono" style="color:var(--success); font-size:0.85rem; margin-top:0.15rem;">
            R$ ${p.precoUnitario.toFixed(2)}
          </div>
        </div>
        <div style="display:flex; gap:0.4rem;">
          <button class="btn btn-secondary btn-sm" onclick="prepararEdicaoProduto(${p.id})">
            <i class="ri-edit-line"></i> Editar
          </button>
          <button class="btn btn-danger btn-sm" onclick="desativarProduto(${p.id})">Remover</button>
        </div>
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

// 8. DASHBOARD ANALÍTICO (GRÁFICOS DE PICO E TOP PRODUTOS)
function limparFiltroDashboard() {
  const inputData = document.getElementById("filtro-data-dashboard");
  if (inputData) inputData.value = "";
  renderizarDashboard();
}

function renderizarDashboard() {
  if (!usuarioLogado?.isAdmin) return;

  const filtroData = document.getElementById("filtro-data-dashboard")?.value || "";
  let vendasConcluidas = cacheVendas.filter(v => v.status === "CONCLUIDA");

  if (filtroData) {
    vendasConcluidas = vendasConcluidas.filter(v => {
      const dataIso = new Date(v.dataHora).toISOString().split("T")[0];
      return dataIso === filtroData;
    });
  }

  const faturamentoTotal = vendasConcluidas.reduce((acc, v) => acc + v.valorFinal, 0);
  let totalItensVendidos = 0;

  // Contagem por hora (00h às 23h)
  const vendasPorHora = Array(24).fill(0);
  // Contagem de produtos
  const rankingProdutos = {};

  vendasConcluidas.forEach(v => {
    const hora = new Date(v.dataHora).getHours();
    vendasPorHora[hora] += 1;

    v.itens.forEach(item => {
      totalItensVendidos += item.quantidade;
      rankingProdutos[item.nomeSnapshot] = (rankingProdutos[item.nomeSnapshot] || 0) + item.quantidade;
    });
  });

  // Identifica horário de maior pico
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

  Chart.defaults.color = "#a1a1aa";
  Chart.defaults.borderColor = "rgba(255, 255, 255, 0.07)";

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
          backgroundColor: "rgba(99, 102, 241, 0.72)",
          borderColor: "#6366f1",
          borderWidth: 1,
          borderRadius: 5
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
          backgroundColor: "rgba(16, 185, 129, 0.72)",
          borderColor: "#10b981",
          borderWidth: 1,
          borderRadius: 5
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

// 9. TURNOS INDEPENDENTES POR USUÁRIO
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
    operadorNome: obterNomePerfil(turnoAtivo.usuarioId, turnoAtivo.operadorNome),
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
    const nomeAtual = obterNomePerfil(turnoAtivo.usuarioId, turnoAtivo.operadorNome);
    badge.textContent = `Caixa Aberto: ${turnoAtivo.tipoTurno}`;
    badge.className = "badge badge-open";
    aviso.classList.add("hidden");
    pdvArea.classList.remove("hidden");

    infoTurno.innerHTML = `
      <p style="margin:0.6rem 0; color:var(--text-muted);">
        Operador: <strong style="color:var(--text-main);">${nomeAtual}</strong> |
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

// 10. CARRINHO E FINALIZAÇÃO DE VENDA DIRETA
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

// 11. HISTÓRICO, 2ª VIA DE VENDA E IMPRESSÃO DO TURNO COMPLETO
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
    const nomeOperadorAtual = obterNomePerfil(t.usuarioId, t.operadorNome);
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
              Operador: <strong>${nomeOperadorAtual}</strong> |
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

// 12. MOTOR DE IMPRESSÃO TÉRMICA 80MM (ELGIN i8)
function imprimirCupomVenda80mm(vendaId, callbackPosImpressao = null) {
  const v = cacheVendas.find(item => item.id === Number(vendaId));
  if (!v) return;

  const nomeOperador = obterNomePerfil(v.usuarioId, v.operadorNome);
  const area = document.getElementById("area-impressao");
  area.innerHTML = `
    <div class="cupom-header">
      <h3>CAIXA PETROVIA</h3>
      <div>COMPROVANTE DE VENDA #${v.id}</div>
      <div>Operador: ${nomeOperador}</div>
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

  const nomeOperador = obterNomePerfil(t.usuarioId, t.operadorNome);
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
      <div>Operador: ${nomeOperador}</div>
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
  processarEnterBuscaPDV,
  renderizarDashboard,
  limparFiltroDashboard,
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
