const KEY = 'perfumaria_final_v1';
const DEFAULT_DB = {
  clients: [],
  sales: [],
  products: [],
  settings: { store: 'Perfumaria', pixKey: '', city: '' }
};
const $ = id => document.getElementById(id);
let firebaseUser = null;
let cloudReady = false;
let saveTimer = null;
let active = null;
let selectedSaleProductId = null;

function nextProductCode(products = db.products) {
  const used = new Set((products || []).map(p => String(p.code || '').trim().toLowerCase()).filter(Boolean));
  let n = 1001;
  while (used.has(String(n).toLowerCase())) n++;
  return String(n);
}

function normalizeDatabase(input) {
  const data = input && typeof input === 'object' ? input : {};
  let changed = false;
  const normalized = {
    ...DEFAULT_DB,
    ...data,
    clients: Array.isArray(data.clients) ? data.clients : [],
    sales: Array.isArray(data.sales) ? data.sales : [],
    products: Array.isArray(data.products) ? data.products : [],
    settings: { ...DEFAULT_DB.settings, ...(data.settings || {}) }
  };
  if (!Array.isArray(data.clients) || !Array.isArray(data.sales) || !Array.isArray(data.products)) changed = true;
  const used = new Set(normalized.products.map(p => String(p.code || '').trim().toLowerCase()).filter(Boolean));
  let candidate = 1001;
  normalized.products.forEach(product => {
    if (!String(product.code || '').trim()) {
      while (used.has(String(candidate).toLowerCase())) candidate++;
      product.code = String(candidate);
      used.add(String(candidate).toLowerCase());
      candidate++;
      changed = true;
    }
  });
  return { db: normalized, changed };
}

let initialData;
try { initialData = JSON.parse(localStorage.getItem(KEY) || 'null') || DEFAULT_DB; }
catch (_) { initialData = DEFAULT_DB; }
let db = normalizeDatabase(initialData).db;
localStorage.setItem(KEY, JSON.stringify(db));

const setSync = text => { const el = $('syncBar'); if (el) el.textContent = text; };
const today = () => new Date().toISOString().slice(0, 10);
const money = n => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR');
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[char]));
}
function addM(date, months) {
  const d = new Date(date + 'T12:00:00');
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
function activeSales() { return db.sales.filter(s => !s.cancelled); }
function st(installment) {
  if (installment.paid) return '<span class="badge ok">Pago</span>';
  if (installment.due < today()) return '<span class="badge danger">Atrasada</span>';
  if (installment.due === today()) return '<span class="badge">Vence hoje</span>';
  return '<span class="badge">Pendente</span>';
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(db));
  render();
  if (firebaseUser && cloudReady) {
    setSync('Salvando na nuvem…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await firebase.firestore().collection('users').doc(firebaseUser.uid)
          .collection('appData').doc('main')
          .set({ data: db, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        setSync('Sincronizado na nuvem ✓');
      } catch (error) {
        console.error(error);
        setSync('Erro ao salvar na nuvem. Confira a conexão e as regras do Firestore.');
      }
    }, 400);
  }
}

function render() {
  let open = 0, received = 0, late = 0, profit = 0;
  const pending = [];
  activeSales().forEach(sale => {
    const cost = Number(sale.cost || 0);
    (sale.installments || []).forEach(installment => {
      if (installment.paid) received += Number(installment.value || 0);
      else {
        open += Number(installment.value || 0);
        pending.push({ ...installment, sid: sale.id, cid: sale.clientId, desc: sale.desc });
        if (installment.due < today()) late += Number(installment.value || 0);
      }
    });
    profit += Number(sale.price || sale.total || 0) - cost;
  });
  $('open').textContent = money(open);
  $('received').textContent = money(received);
  $('late').textContent = money(late);
  $('profit').textContent = money(profit);
  pending.sort((a, b) => a.due.localeCompare(b.due));
  $('next').innerHTML = pending.slice(0, 7).map(chargeHTML).join('') || '<div class="empty">Nenhum vencimento pendente.</div>';
  $('chargeList').innerHTML = pending.map(chargeHTML).join('') || '<div class="empty">Nenhuma cobrança pendente.</div>';

  const clientQuery = ($('search').value || '').toLowerCase().trim();
  $('clientList').innerHTML = db.clients.filter(c => String(c.name || '').toLowerCase().includes(clientQuery)).map(client => {
    let balance = 0;
    activeSales().filter(sale => sale.clientId === client.id).forEach(sale => {
      (sale.installments || []).forEach(installment => { if (!installment.paid) balance += Number(installment.value || 0); });
    });
    return `<div class="client"><div><b>${esc(client.name)}</b><div class="muted">${esc(client.phone || 'Sem WhatsApp')} • ${money(balance)} em aberto</div></div><button onclick="openClient('${esc(client.id)}')">Abrir</button></div>`;
  }).join('') || '<div class="empty">Nenhum cliente.</div>';

  $('productList').innerHTML = db.products.map(product => `
    <div class="product">
      <div><b>${esc(product.name)}</b><div class="muted">Código: <strong>${esc(product.code || '—')}</strong> • Venda ${money(product.price)} • Custo ${money(product.cost)} • Lucro ${money(Number(product.price || 0) - Number(product.cost || 0))}</div></div>
      <div class="stock-actions"><strong>Estoque: ${Number(product.stock || 0)}</strong><button class="small" onclick="adjustStock('${esc(product.id)}')">Ajustar estoque</button></div>
    </div>`).join('') || '<div class="empty">Nenhum perfume cadastrado.</div>';
}

function chargeHTML(installment) {
  const client = db.clients.find(c => c.id === installment.cid);
  return `<div class="charge"><div><b>${esc(client?.name || 'Cliente')} — ${money(installment.value)}</b><div class="muted">${esc(installment.desc)} • ${fmt(installment.due)} ${st(installment)}</div></div><div><button class="small" onclick="showPix('${esc(installment.sid)}','${esc(installment.id)}')">PIX</button> <button class="small green" onclick="pay('${esc(installment.sid)}','${esc(installment.id)}')">Recebido</button></div></div>`;
}

// Navegação entre abas.
document.querySelectorAll('.tab').forEach(button => button.onclick = () => {
  document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
  button.classList.add('active');
  document.querySelectorAll('.page').forEach(page => page.classList.add('hidden'));
  $(button.dataset.t).classList.remove('hidden');
});
$('search').oninput = render;

// Clientes.
$('newClient').onclick = () => { $('clientForm').reset(); $('clientDlg').showModal(); };
$('clientForm').onsubmit = event => {
  event.preventDefault();
  db.clients.push({ id: crypto.randomUUID(), name: $('cName').value.trim(), phone: $('cPhone').value.trim(), notes: $('cNotes').value.trim() });
  save();
  $('clientDlg').close();
};

// Produtos e códigos únicos.
$('newProduct').onclick = () => {
  $('productForm').reset();
  $('pCode').value = nextProductCode();
  $('productDlg').showModal();
};
$('productForm').onsubmit = event => {
  event.preventDefault();
  const name = $('pName').value.trim();
  const code = $('pCode').value.trim() || nextProductCode();
  if (db.products.some(product => String(product.code || '').trim().toLowerCase() === code.toLowerCase())) {
    alert('Esse código já está cadastrado. Escolha outro código.');
    $('pCode').focus();
    return;
  }
  db.products.push({
    id: crypto.randomUUID(), code, name,
    cost: Number($('pCost').value) || 0,
    price: Number($('pPrice').value),
    stock: Number($('pStock').value) || 0
  });
  save();
  $('productDlg').close();
};
window.adjustStock = id => {
  const product = db.products.find(item => item.id === id);
  if (!product) return;
  const answer = prompt(`Estoque atual de ${product.name}: ${product.stock}\nDigite a NOVA quantidade total (não a diferença):`, String(product.stock));
  if (answer === null) return;
  const quantity = Number(answer);
  if (!Number.isInteger(quantity) || quantity < 0) { alert('Digite uma quantidade inteira igual ou maior que zero.'); return; }
  product.stock = quantity;
  save();
  alert('Estoque atualizado.');
};

// Busca de produtos por nome ou código no formulário da venda.
function renderProductSearch() {
  const query = $('sProductSearch').value.trim().toLowerCase();
  const results = $('sProductResults');
  const selected = db.products.find(product => product.id === selectedSaleProductId);
  if (selected && $('sProductSearch').value === `${selected.code} — ${selected.name}`) {
    results.innerHTML = `<div class="selected-product"><span>Selecionado: <b>${esc(selected.code)} — ${esc(selected.name)}</b><br><small>Estoque disponível: ${Number(selected.stock || 0)} • ${money(selected.price)} por unidade</small></span><button type="button" class="small" id="clearSaleProduct">Remover</button></div>`;
    $('clearSaleProduct').onclick = () => clearSaleProduct();
    return;
  }
  if (!query) {
    results.innerHTML = '<div class="muted search-help">Digite o nome ou o código para pesquisar. Você também pode deixar vazio para uma venda sem produto do estoque.</div>';
    return;
  }
  const matches = db.products.filter(product =>
    String(product.name || '').toLowerCase().includes(query) || String(product.code || '').toLowerCase().includes(query)
  ).slice(0, 8);
  const matchMarkup = matches.map(product => `<button type="button" class="product-result" data-product-id="${esc(product.id)}"><span><b>${esc(product.name)}</b><small>Código: ${esc(product.code || '—')} • Estoque: ${Number(product.stock || 0)}</small></span><strong>${money(product.price)}</strong></button>`).join('');
  results.innerHTML = matchMarkup || '<div class="muted search-help">Nenhum produto encontrado com esse nome ou código.</div>';
  if (matches.length) results.querySelectorAll('[data-product-id]').forEach(button => {
    button.onclick = () => selectSaleProduct(button.dataset.productId);
  });
  results.insertAdjacentHTML('beforeend', '<button type="button" class="small clear-search-button" id="saleWithoutStock">Limpar pesquisa e fazer venda avulsa</button>');
  $('saleWithoutStock').onclick = () => clearSaleProduct(true);
}
function selectSaleProduct(id) {
  const product = db.products.find(item => item.id === id);
  if (!product) return;
  selectedSaleProductId = product.id;
  $('sProductSearch').value = `${product.code} — ${product.name}`;
  $('sDesc').value = product.name;
  const quantity = Math.max(1, Number($('sQty').value) || 1);
  $('sTotal').value = (Number(product.price || 0) * quantity).toFixed(2);
  $('stockHint').textContent = `Estoque disponível: ${product.stock}. Ao concluir a venda, serão baixadas ${quantity} unidade(s).`;
  renderProductSearch();
}
function clearSaleProduct(clearDescription = false) {
  selectedSaleProductId = null;
  $('sProductSearch').value = '';
  if (clearDescription) $('sDesc').value = '';
  $('stockHint').textContent = 'Sem produto selecionado: esta venda não dará baixa automática no estoque.';
  renderProductSearch();
}
$('sProductSearch').addEventListener('input', () => {
  if (selectedSaleProductId) {
    const selected = db.products.find(product => product.id === selectedSaleProductId);
    if (!selected || $('sProductSearch').value !== `${selected.code} — ${selected.name}`) selectedSaleProductId = null;
  }
  renderProductSearch();
});
$('sQty').oninput = () => {
  const product = db.products.find(item => item.id === selectedSaleProductId);
  if (product) {
    const quantity = Math.max(1, Number($('sQty').value) || 1);
    $('sTotal').value = (Number(product.price || 0) * quantity).toFixed(2);
    $('stockHint').textContent = `Estoque disponível: ${product.stock}. Ao concluir a venda, serão baixadas ${quantity} unidade(s).`;
  }
};

// Detalhes do cliente e vendas vinculadas.
window.openClient = id => {
  active = db.clients.find(client => client.id === id);
  if (!active) return;
  const sales = activeSales().filter(sale => sale.clientId === id);
  let html = `<h2>${esc(active.name)}</h2><p class="muted">${esc(active.phone || 'Sem WhatsApp')}</p><button class="primary" onclick="newSale()">+ Nova venda fiada</button>`;
  if (!sales.length) html += '<div class="empty">Este cliente ainda não tem vendas ativas.</div>';
  sales.forEach(sale => {
    const product = db.products.find(item => item.id === sale.productId);
    html += `<div class="sale-heading"><div><b>${esc(sale.desc)} — ${money(sale.total)}</b>${sale.productId ? `<div class="muted">Produto: ${esc(product?.name || 'Produto removido')} • Código: ${esc(product?.code || '—')} • Quantidade: ${Number(sale.quantity || 1)}</div>` : ''}</div><button class="small danger-button" onclick="cancelSale('${esc(sale.id)}')">Cancelar venda</button></div>`;
    (sale.installments || []).forEach((installment, index) => {
      html += `<div class="installment"><div class="row"><span>${index + 1}/${sale.installments.length} • ${money(installment.value)}</span><span>${fmt(installment.due)}</span></div><div class="row">${st(installment)} ${installment.paid ? `<span class="muted">Pago ${fmt(installment.paidAt || today())}</span><button type="button" class="small warning-button" onclick="undoPayment('${esc(sale.id)}','${esc(installment.id)}')">Desfazer recebimento</button>` : `<button class="small" onclick="showPix('${esc(sale.id)}','${esc(installment.id)}')">PIX</button><button class="small green" onclick="pay('${esc(sale.id)}','${esc(installment.id)}')">Recebido</button>`}</div></div>`;
    });
  });
  $('view').innerHTML = html;
  $('viewDlg').showModal();
};

window.newSale = () => {
  $('viewDlg').close();
  $('saleForm').reset();
  selectedSaleProductId = null;
  $('sProductSearch').value = '';
  $('sQty').value = '1';
  $('stockHint').textContent = 'Pesquise pelo nome ou código e escolha um produto para dar baixa no estoque automaticamente.';
  $('saleWho').textContent = 'Cliente: ' + active.name;
  $('sDate').value = today();
  renderProductSearch();
  $('saleDlg').showModal();
};

$('saleForm').onsubmit = event => {
  event.preventDefault();
  const total = Number($('sTotal').value);
  const installmentsCount = Number($('sN').value);
  const quantity = Number($('sQty').value) || 1;
  const product = selectedSaleProductId ? db.products.find(item => item.id === selectedSaleProductId) : null;
  if ($('sProductSearch').value.trim() && !product) {
    alert('Escolha um produto na lista de resultados ou limpe a pesquisa para fazer uma venda sem vincular ao estoque.');
    $('sProductSearch').focus();
    return;
  }
  if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(installmentsCount) || installmentsCount < 1) {
    alert('Confira o valor total e a quantidade de parcelas.'); return;
  }
  if (!Number.isInteger(quantity) || quantity < 1) { alert('A quantidade deve ser um número inteiro maior que zero.'); return; }
  if (product && Number(product.stock || 0) < quantity) {
    alert(`Estoque insuficiente de ${product.name}. Disponível: ${product.stock}.`); return;
  }
  let base = Math.floor(total / installmentsCount * 100) / 100;
  let last = Math.round((total - base * (installmentsCount - 1)) * 100) / 100;
  db.sales.push({
    id: crypto.randomUUID(), clientId: active.id,
    productId: product ? product.id : null,
    productCode: product ? String(product.code || '') : null,
    quantity: product ? quantity : null,
    desc: $('sDesc').value.trim(), total, price: total,
    cost: product ? Number(product.cost || 0) * quantity : 0,
    cancelled: false,
    installments: Array.from({ length: installmentsCount }, (_, index) => ({
      id: crypto.randomUUID(), value: index === installmentsCount - 1 ? last : base,
      due: addM($('sDate').value, index), paid: false
    }))
  });
  if (product) product.stock = Number(product.stock || 0) - quantity;
  save();
  $('saleDlg').close();
  openClient(active.id);
};

window.pay = (saleId, installmentId) => {
  const sale = db.sales.find(item => item.id === saleId && !item.cancelled);
  const installment = sale?.installments.find(item => item.id === installmentId);
  if (!sale || !installment || installment.paid) return;
  installment.paid = true;
  installment.paidAt = today();
  save();
  if (active) openClient(active.id);
};

window.undoPayment = (saleId, installmentId) => {
  const sale = db.sales.find(item => item.id === saleId && !item.cancelled);
  const installment = sale?.installments.find(item => item.id === installmentId);
  if (!sale || !installment || !installment.paid) return;
  const confirmed = confirm('Use esta opção somente se marcou a parcela como recebida por engano. A parcela voltará a ficar pendente; o aplicativo não devolve dinheiro. Deseja continuar?');
  if (!confirmed) return;
  installment.paid = false;
  delete installment.paidAt;
  save();
  if (active) openClient(active.id);
};

window.cancelSale = saleId => {
  const sale = db.sales.find(item => item.id === saleId && !item.cancelled);
  if (!sale) return;
  const paidInstallments = (sale.installments || []).filter(installment => installment.paid);
  if (paidInstallments.length) {
    const confirmedRefund = confirm('Esta venda tem parcela(s) marcada(s) como recebida(s).\n\nSó confirme o cancelamento se todo o dinheiro recebido já foi devolvido ao cliente. Se marcou o recebimento por engano, cancele esta janela e use “Desfazer recebimento” na parcela.\n\nVocê já devolveu os valores recebidos?');
    if (!confirmedRefund) return;
  }
  const product = db.products.find(item => item.id === sale.productId);
  const question = `Cancelar a venda “${sale.desc}” de ${money(sale.total)}?\n\nO saldo devedor será recalculado e${product ? ` ${Number(sale.quantity || 1)} unidade(s) de ${product.name} voltarão ao estoque` : ' o estoque não será alterado'}. Esta venda ficará marcada como cancelada.`;
  if (!confirm(question)) return;
  sale.cancelled = true;
  sale.cancelledAt = today();
  if (product) product.stock = Number(product.stock || 0) + Number(sale.quantity || 1);
  save();
  if (active) openClient(active.id);
  alert('Venda cancelada. O saldo do cliente, o resumo financeiro e o estoque foram atualizados.');
};

// PIX Copia e Cola.
function crc(str) {
  let value = 0xffff;
  for (let index = 0; index < str.length; index++) {
    value ^= str.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit++) value = (value & 0x8000) ? ((value << 1) ^ 0x1021) & 0xffff : (value << 1) & 0xffff;
  }
  return value.toString(16).toUpperCase().padStart(4, '0');
}
function fld(id, value) { return id + String(value.length).padStart(2, '0') + value; }
function pix(key, amount, name, city, tx) {
  const merchant = fld('00', 'BR.GOV.BCB.PIX') + fld('01', key);
  const m = fld('26', merchant);
  const additional = fld('62', fld('05', tx.slice(0, 25)));
  const body = fld('00', '01') + fld('01', '12') + m + fld('52', '0000') + fld('53', '986') + fld('54', amount.toFixed(2)) + fld('58', 'BR') + fld('59', name.slice(0, 25)) + fld('60', city.slice(0, 15)) + additional + '6304';
  return body + crc(body);
}
window.showPix = (saleId, installmentId) => {
  const sale = db.sales.find(item => item.id === saleId && !item.cancelled);
  const installment = sale?.installments.find(item => item.id === installmentId);
  if (!sale || !installment) return;
  const client = db.clients.find(item => item.id === sale.clientId);
  const key = db.settings.pixKey;
  if (!key) { alert('Cadastre sua chave PIX em Configurações.'); return; }
  const code = pix(key, installment.value, db.settings.store || 'PERFUMARIA', db.settings.city || 'BRASIL', installmentId.replaceAll('-', ''));
  const message = `Olá, ${client?.name || 'cliente'}! Sua parcela de ${money(installment.value)} vence em ${fmt(installment.due)}. PIX Copia e Cola:\n${code}\nApós pagar, envie o comprovante.`;
  $('pixView').innerHTML = `<h2>PIX da parcela</h2><p><b>${money(installment.value)}</b> • vencimento ${fmt(installment.due)}</p><p class="muted">PIX Copia e Cola</p><div class="copy">${esc(code)}</div><div class="actions"><button class="primary" id="copyPix">Copiar PIX</button><button id="copyCharge">Copiar cobrança</button></div><p class="muted">Para QR Code, esta tela pode ser ampliada em uma próxima versão com uma biblioteca de QR.</p>`;
  $('copyPix').onclick = async () => { try { await navigator.clipboard.writeText(code); alert('PIX copiado!'); } catch (_) { alert('Não foi possível copiar automaticamente. Selecione e copie o código.'); } };
  $('copyCharge').onclick = async () => { try { await navigator.clipboard.writeText(message); alert('Mensagem copiada!'); } catch (_) { alert('Não foi possível copiar automaticamente.'); } };
  $('pixDlg').showModal();
};

// Configurações.
$('saveSettings').onclick = () => {
  db.settings.store = $('storeName').value.trim() || 'Perfumaria';
  db.settings.pixKey = $('pixKey').value.trim();
  db.settings.city = $('pixCity').value.trim() || 'BRASIL';
  save();
  alert('Configurações salvas.');
};
$('storeName').value = db.settings.store;
$('pixKey').value = db.settings.pixKey;
$('pixCity').value = db.settings.city;
render();

// Firebase Auth + Firestore. Os dados locais permanecem como cópia neste aparelho.
(function setupCloud() {
  try {
    firebase.initializeApp(firebaseConfig);
  } catch (error) {
    console.error(error);
    $('loginMessage').textContent = 'Não foi possível iniciar o Firebase. Confira firebase-config.js.';
    return;
  }
  const auth = firebase.auth();
  const store = firebase.firestore();
  $('loginBtn').onclick = async () => {
    const email = $('loginEmail').value.trim(), password = $('loginPassword').value;
    if (!email || !password) { $('loginMessage').textContent = 'Digite seu e-mail e sua senha.'; return; }
    $('loginMessage').textContent = 'Entrando…';
    try { await auth.signInWithEmailAndPassword(email, password); }
    catch (error) { $('loginMessage').textContent = authMessage(error); }
  };
  $('createBtn').onclick = async () => {
    const email = $('loginEmail').value.trim(), password = $('loginPassword').value;
    if (!email || password.length < 6) { $('loginMessage').textContent = 'Digite um e-mail válido e uma senha com pelo menos 6 caracteres.'; return; }
    $('loginMessage').textContent = 'Criando conta…';
    try { await auth.createUserWithEmailAndPassword(email, password); }
    catch (error) { $('loginMessage').textContent = authMessage(error); }
  };
  $('logoutBtn').onclick = async () => {
    cloudReady = false;
    firebaseUser = null;
    await auth.signOut();
    $('appShell').classList.add('hidden');
    $('cloudLogin').classList.remove('hidden');
    $('loginMessage').textContent = 'Você saiu da conta. Seus dados locais continuam neste aparelho.';
  };
  auth.onAuthStateChanged(async user => {
    firebaseUser = user || null;
    cloudReady = false;
    if (!user) {
      $('appShell').classList.add('hidden');
      $('cloudLogin').classList.remove('hidden');
      setSync('Desconectado');
      return;
    }
    $('cloudLogin').classList.add('hidden');
    $('appShell').classList.remove('hidden');
    setSync('Carregando dados da nuvem…');
    try {
      const ref = store.collection('users').doc(user.uid).collection('appData').doc('main');
      const snapshot = await ref.get();
      let shouldWriteMigration = false;
      if (snapshot.exists && snapshot.data() && snapshot.data().data) {
        const normalized = normalizeDatabase(snapshot.data().data);
        db = normalized.db;
        shouldWriteMigration = normalized.changed;
        localStorage.setItem(KEY, JSON.stringify(db));
        setSync('Dados carregados da nuvem ✓');
      } else {
        let localDb;
        try { localDb = normalizeDatabase(JSON.parse(localStorage.getItem(KEY) || '{}')).db; }
        catch (_) { localDb = JSON.parse(JSON.stringify(DEFAULT_DB)); }
        const hasLocal = localDb.clients.length || localDb.sales.length || localDb.products.length;
        if (hasLocal) {
          const useLocal = confirm('Não há dados salvos na nuvem nesta conta. Deseja enviar para a nuvem os dados que já estão neste aparelho?\n\nEscolha Cancelar para começar com a nuvem vazia (os dados locais não serão apagados).');
          if (useLocal) db = localDb;
          else { db = JSON.parse(JSON.stringify(DEFAULT_DB)); localStorage.setItem(KEY, JSON.stringify(db)); }
        } else db = JSON.parse(JSON.stringify(DEFAULT_DB));
        await ref.set({ data: db, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      }
      // Garante que os códigos automáticos de produtos antigos também fiquem salvos na nuvem.
      const afterNormalize = normalizeDatabase(db);
      db = afterNormalize.db;
      if (shouldWriteMigration || afterNormalize.changed) {
        await ref.set({ data: db, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        localStorage.setItem(KEY, JSON.stringify(db));
      }
      cloudReady = true;
      render();
      $('storeName').value = db.settings.store || 'Perfumaria';
      $('pixKey').value = db.settings.pixKey || '';
      $('pixCity').value = db.settings.city || '';
      setSync('Sincronizado na nuvem ✓');
    } catch (error) {
      console.error(error);
      setSync('Não foi possível acessar a nuvem. Verifique as regras do Firestore.');
      alert('O login funcionou, mas não conseguimos ler ou gravar no Firestore. Confira as regras de segurança.');
    }
  });
  function authMessage(error) {
    const code = error && error.code;
    return ({
      'auth/invalid-email': 'O formato do e-mail parece inválido.',
      'auth/email-already-in-use': 'Esse e-mail já tem conta. Use Entrar.',
      'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
      'auth/invalid-credential': 'E-mail ou senha incorretos.',
      'auth/network-request-failed': 'Sem conexão com a internet. Tente novamente.'
    })[code] || ('Não foi possível concluir. Código: ' + (code || 'erro'));
  }
})();
