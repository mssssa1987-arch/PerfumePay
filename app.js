// Chave antiga usada só para uma migração explícita e única. A versão segura não mantém dados de clientes no localStorage.
const LEGACY_KEY = 'perfumaria_final_v1';
const DEFAULT_DB = {
  clients: [],
  sales: [],
  products: [],
  bills: [],
  settings: { store: 'Perfumaria', pixKey: '', pixName: '', city: '' }
};
const $ = id => document.getElementById(id);
let firebaseUser = null;
let cloudReady = false;
let currentDocRef = null;
let saveTimer = null;
let inFlightSave = null;
let changeRevision = 0;
let savedRevision = 0;
let writeFailed = false;
let active = null;
let selectedSaleClientId = null;
let selectedSaleProductId = null;
let currentTab = 'home';
let settingsUnlocked = false;
let settingsAutoLockTimer = null;
let pinMode = 'unlock';
let pinWrongAttempts = 0;
let pinBlockedUntil = 0;

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
    bills: Array.isArray(data.bills) ? data.bills : [],
    settings: { ...DEFAULT_DB.settings, ...(data.settings || {}) }
  };
  if (!Array.isArray(data.clients) || !Array.isArray(data.sales) || !Array.isArray(data.products) || !Array.isArray(data.bills)) changed = true;
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

function emptyDatabase() { return JSON.parse(JSON.stringify(DEFAULT_DB)); }
// Não carregamos nenhuma cópia local antes da autenticação. Os dados só entram na memória
// depois de serem lidos com sucesso do documento Firestore pertencente à conta autenticada.
let db = emptyDatabase();

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
  // Bloqueia gravações se a sessão ou o documento remoto não estiverem prontos.
  if (!firebaseUser || !cloudReady || !currentDocRef) {
    setSync('Bloqueado: a nuvem não está pronta. Nenhuma alteração foi sincronizada.');
    render();
    return false;
  }
  changeRevision++;
  render();
  writeFailed = false;
  setSync('Alterações pendentes — salvando na nuvem…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flushPendingSave(); }, 350);
  return true;
}

function flushPendingSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (inFlightSave) {
    return inFlightSave.then(() => {
      if (cloudReady && firebaseUser && savedRevision < changeRevision && !writeFailed) return flushPendingSave();
      return !writeFailed && savedRevision >= changeRevision;
    });
  }
  if (!firebaseUser || !cloudReady || !currentDocRef) return Promise.resolve(false);
  if (savedRevision >= changeRevision && !writeFailed) return Promise.resolve(true);

  const userId = firebaseUser.uid;
  const docRef = currentDocRef;
  inFlightSave = (async () => {
    try {
      while (savedRevision < changeRevision) {
        const revisionBeingSaved = changeRevision;
        const payload = JSON.parse(JSON.stringify(db));
        await docRef.set({ data: payload, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        // Se a sessão mudou, não atualizamos o estado visual da nova conta com o resultado antigo.
        if (!firebaseUser || firebaseUser.uid !== userId || currentDocRef !== docRef) return false;
        savedRevision = revisionBeingSaved;
      }
      writeFailed = false;
      setSync('Sincronizado na nuvem ✓');
      return true;
    } catch (error) {
      console.error(error);
      writeFailed = true;
      setSync('FALHA ao sincronizar. Toque aqui para tentar novamente.');
      return false;
    }
  })();

  const promise = inFlightSave.finally(() => {
    inFlightSave = null;
    if (!writeFailed && cloudReady && firebaseUser && currentDocRef && savedRevision < changeRevision) {
      saveTimer = setTimeout(() => { void flushPendingSave(); }, 50);
    }
  });
  inFlightSave = promise;
  return promise;
}

$('syncBar').addEventListener('click', () => {
  if (writeFailed) {
    writeFailed = false;
    setSync('Tentando sincronizar novamente…');
    void flushPendingSave();
  }
});

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
    let overdue = 0;
    activeSales().filter(sale => sale.clientId === client.id).forEach(sale => {
      (sale.installments || []).forEach(installment => {
        if (!installment.paid) {
          balance += Number(installment.value || 0);
          if (installment.due < today()) overdue += Number(installment.value || 0);
        }
      });
    });
    const blocked = client.salesBlocked === true;
    return `<div class="client"><div><b>${esc(client.name)}</b>${blocked ? ' <span class="badge danger">Venda bloqueada</span>' : ''}<div class="muted">${esc(client.phone || 'Sem WhatsApp')} • ${money(balance)} em aberto${overdue > 0 ? ` • ${money(overdue)} atrasados` : ''}</div></div><div class="client-row-actions"><button type="button" data-action="open-client" data-id="${esc(client.id)}">Abrir</button><button type="button" class="small danger-button" data-action="delete-client" data-id="${esc(client.id)}">Excluir</button></div></div>`;
  }).join('') || '<div class="empty">Nenhum cliente.</div>';

  const renderProduct = product => {
    const discontinued = product.active === false;
    const actions = discontinued
      ? `<button type="button" class="small" data-action="restore-product" data-id="${esc(product.id)}">Reativar</button>`
      : `<button type="button" class="small" data-action="adjust-stock" data-id="${esc(product.id)}">Ajustar estoque</button><button type="button" class="small warning-button" data-action="archive-product" data-id="${esc(product.id)}">Descontinuar</button>`;
    return `
    <div class="product">
      <div><b>${esc(product.name)}</b>${discontinued ? ' <span class="badge">Descontinuado</span>' : ''}<div class="muted">Código: <strong>${esc(product.code || '—')}</strong> • Venda ${money(product.price)} • Custo ${money(product.cost)} • Lucro ${money(Number(product.price || 0) - Number(product.cost || 0))}</div></div>
      <div class="stock-actions"><strong>Estoque: ${Number(product.stock || 0)}</strong>${actions}<button type="button" class="small danger-button" data-action="delete-product" data-id="${esc(product.id)}">Excluir</button></div>
    </div>`;
  };
  const currentProducts = db.products.filter(product => product.active !== false);
  const discontinuedProducts = db.products.filter(product => product.active === false);
  const currentMarkup = currentProducts.map(renderProduct).join('') || '<div class="empty">Nenhum produto ativo cadastrado.</div>';
  const discontinuedMarkup = discontinuedProducts.length
    ? `<details class="discontinued-products"><summary>Produtos descontinuados (${discontinuedProducts.length})</summary>${discontinuedProducts.map(renderProduct).join('')}</details>`
    : '';
  $('productList').innerHTML = currentMarkup + discontinuedMarkup;
  renderReports();
  renderPayables();
}

function renderReports() {
  const monthInput = $('reportMonth');
  if (!monthInput) return;
  if (!monthInput.value) monthInput.value = today().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(monthInput.value) ? monthInput.value : today().slice(0, 7);
  const sales = activeSales();
  const salesForMonth = sales.filter(sale => String(sale.createdAt || sale.saleDate || sale.date || '').slice(0, 7) === month);
  const sumSales = salesForMonth.reduce((sum, sale) => sum + Number(sale.total || sale.price || 0), 0);
  const receivedInMonth = sales.flatMap(sale => (sale.installments || []).map(installment => ({ ...installment, saleId: sale.id })))
    .filter(installment => installment.paid && String(installment.paidAt || '').slice(0, 7) === month)
    .reduce((sum, installment) => sum + Number(installment.value || 0), 0);
  let openNow = 0, lateNow = 0;
  sales.forEach(sale => (sale.installments || []).forEach(installment => {
    if (!installment.paid) {
      const value = Number(installment.value || 0);
      openNow += value;
      if (installment.due < today()) lateNow += value;
    }
  }));
  const estimatedProfit = salesForMonth.reduce((sum, sale) => sum + Number(sale.total || sale.price || 0) - Number(sale.cost || 0), 0);
  $('reportSales').textContent = money(sumSales);
  $('reportSalesMeta').textContent = `${salesForMonth.length} venda(s) registrada(s)`;
  $('reportReceived').textContent = money(receivedInMonth);
  $('reportOpen').textContent = money(openNow);
  $('reportLate').textContent = money(lateNow);
  $('reportProfit').textContent = money(estimatedProfit);

  const [selectedYear, selectedMonth] = month.split('-').map(Number);
  const chartMonths = [];
  for (let offset = 5; offset >= 0; offset--) {
    const d = new Date(selectedYear, selectedMonth - 1 - offset, 1, 12, 0, 0);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const total = sales.filter(sale => String(sale.createdAt || sale.saleDate || sale.date || '').slice(0, 7) === key)
      .reduce((sum, sale) => sum + Number(sale.total || sale.price || 0), 0);
    chartMonths.push({ key, total, label: d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '') });
  }
  const maxChart = Math.max(1, ...chartMonths.map(item => item.total));
  $('salesChart').innerHTML = chartMonths.map(item => {
    const height = item.total > 0 ? Math.max(8, item.total / maxChart * 100) : 3;
    const compact = item.total > 0 ? `R$ ${Math.round(item.total).toLocaleString('pt-BR')}` : '—';
    return `<div class="chart-item"><strong>${compact}</strong><div class="bar-track"><div class="chart-bar" style="height:${height}%" title="${esc(item.label)}: ${money(item.total)}"></div></div><small>${esc(item.label)}</small></div>`;
  }).join('');

  const sortedSales = [...salesForMonth].sort((a, b) => String(b.createdAt || b.saleDate || b.date || '').localeCompare(String(a.createdAt || a.saleDate || a.date || '')));
  $('monthlySales').innerHTML = sortedSales.map(sale => {
    const client = db.clients.find(item => item.id === sale.clientId);
    const saleDate = String(sale.createdAt || sale.saleDate || sale.date || '').slice(0, 10);
    return `<div class="report-row"><div><b>${esc(sale.desc || 'Venda')}</b><small>${esc(client?.name || 'Cliente removido')} • ${saleDate ? fmt(saleDate) : 'Data não registrada'}${sale.productCode ? ` • Código ${esc(sale.productCode)}` : ''}</small></div><strong>${money(sale.total || sale.price || 0)}</strong></div>`;
  }).join('') || '<div class="empty">Nenhuma venda com data registrada neste mês.</div>';

  const activeProducts = db.products.filter(product => product.active !== false);
  const stockUnits = activeProducts.reduce((sum, product) => sum + Math.max(0, Number(product.stock || 0)), 0);
  const stockCost = activeProducts.reduce((sum, product) => sum + Math.max(0, Number(product.stock || 0)) * Number(product.cost || 0), 0);
  const lowStock = activeProducts.filter(product => Number(product.stock || 0) <= 3).sort((a, b) => Number(a.stock || 0) - Number(b.stock || 0));
  $('stockSummary').innerHTML = `<div class="stock-stat"><small>Produtos ativos</small><b>${activeProducts.length}</b><p>Itens cadastrados para venda</p></div><div class="stock-stat"><small>Unidades disponíveis</small><b>${stockUnits}</b><p>Somente produtos ativos</p></div><div class="stock-stat"><small>Valor de custo em estoque</small><b>${money(stockCost)}</b><p>Estimativa baseada no custo cadastrado</p></div><div class="stock-alerts"><h3>Estoque baixo (3 unidades ou menos)</h3>${lowStock.length ? lowStock.map(product => `<div class="report-row"><div><b>${esc(product.name)}</b><small>Código ${esc(product.code || '—')}</small></div><strong>${Number(product.stock || 0)} un.</strong></div>`).join('') : '<div class="empty">Nenhum produto com estoque baixo.</div>'}</div>`;

  const undatedSales = sales.filter(sale => !String(sale.createdAt || sale.saleDate || sale.date || '').trim()).length;
  const undatedPaid = sales.flatMap(sale => sale.installments || []).filter(installment => installment.paid && !String(installment.paidAt || '').trim()).length;
  let note = 'Os totais mensais usam a data registrada na venda e a data registrada no recebimento. O saldo em aberto e os atrasos representam a situação atual. Vendas canceladas não entram nos totais.';
  if (undatedSales || undatedPaid) note += ` Registros antigos sem data: ${undatedSales} venda(s) e ${undatedPaid} recebimento(s) pago(s) não podem ser atribuídos a um mês com segurança e, por isso, ficam fora dos totais mensais.`;
  $('reportNote').textContent = note;
}

function chargeHTML(installment) {
  const client = db.clients.find(c => c.id === installment.cid);
  return `<div class="charge"><div><b>${esc(client?.name || 'Cliente')} — ${money(installment.value)}</b><div class="muted">${esc(installment.desc)} • ${fmt(installment.due)} ${st(installment)}</div></div><div><button type="button" class="small" data-action="show-pix" data-sale-id="${esc(installment.sid)}" data-installment-id="${esc(installment.id)}">PIX</button> <button type="button" class="small green whatsapp-button" data-action="send-pix-whatsapp" data-sale-id="${esc(installment.sid)}" data-installment-id="${esc(installment.id)}">WhatsApp</button> <button type="button" class="small green" data-action="pay" data-sale-id="${esc(installment.sid)}" data-installment-id="${esc(installment.id)}">Recebido</button></div></div>`;
}

// Contas a pagar: lembretes internos, separados das vendas e dos recebimentos de clientes.
function safeBillInstallments(bill) { return Array.isArray(bill.installments) ? bill.installments : []; }
function payableStatus(bill) {
  const installments = safeBillInstallments(bill);
  if (installments.length && installments.every(item => item.paid)) return '<span class="badge ok">Quitada</span>';
  if (installments.some(item => item.paid)) return '<span class="badge">Parcialmente paga</span>';
  if (installments.some(item => !item.paid && String(item.due || '') < today())) return '<span class="badge danger">Vencida</span>';
  return '<span class="badge">Pendente</span>';
}
function renderPayables() {
  if (!$('payableList')) return;
  const bills = Array.isArray(db.bills) ? db.bills : [];
  const installments = bills.flatMap(bill => safeBillInstallments(bill).map(item => ({ ...item, billId: bill.id })));
  const open = installments.filter(item => !item.paid);
  const overdue = open.filter(item => String(item.due || '') < today());
  const thisMonth = today().slice(0, 7);
  const paidThisMonth = installments.filter(item => item.paid && String(item.paidAt || '').slice(0, 7) === thisMonth)
    .reduce((sum, item) => sum + Number(item.value || 0), 0);
  $('payableOpenTotal').textContent = money(open.reduce((sum, item) => sum + Number(item.value || 0), 0));
  $('payableOverdueTotal').textContent = money(overdue.reduce((sum, item) => sum + Number(item.value || 0), 0));
  $('payablePaidMonth').textContent = money(paidThisMonth);
  $('payableOpenCount').textContent = String(bills.filter(bill => safeBillInstallments(bill).some(item => !item.paid)).length);

  const nextDue = bill => safeBillInstallments(bill).filter(item => !item.paid).map(item => String(item.due || '9999-12-31')).sort()[0] || '9999-12-31';
  const sorted = [...bills].sort((a, b) => nextDue(a).localeCompare(nextDue(b)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  $('payableList').innerHTML = sorted.map(bill => {
    const parts = safeBillInstallments(bill);
    const paidSum = parts.filter(item => item.paid).reduce((sum, item) => sum + Number(item.value || 0), 0);
    const unpaidParts = parts.filter(item => !item.paid);
    const canDelete = !parts.some(item => item.paid);
    const partMarkup = parts.map(item => {
      const due = item.due ? fmt(item.due) : 'Sem vencimento';
      const paymentStatus = item.paid
        ? `<span class="badge ok">Paga${item.paidAt ? ' em ' + esc(fmt(item.paidAt)) : ''}</span>`
        : (String(item.due || '') < today() ? '<span class="badge danger">Vencida</span>' : '<span class="badge">Pendente</span>');
      const action = item.paid
        ? `<button type="button" class="small warning-button" data-action="undo-payable-payment" data-bill-id="${esc(bill.id)}" data-bill-installment-id="${esc(item.id)}">Desfazer baixa</button>`
        : `<button type="button" class="small green" data-action="pay-bill-installment" data-bill-id="${esc(bill.id)}" data-bill-installment-id="${esc(item.id)}">Dar baixa</button>`;
      return `<div class="payable-installment"><div><b>Parcela ${Number(item.number || 1)}/${parts.length} · ${money(item.value)}</b><small>Vencimento: ${due}</small><div class="payable-status-line">${paymentStatus}</div></div><div class="payable-row-action">${action}</div></div>`;
    }).join('');
    return `<article class="payable-item"><div class="payable-item-head"><div class="payable-title"><h3>${esc(bill.supplier || 'Fornecedor')}</h3><p>${esc(bill.description || 'Lembrete de pagamento')}</p><small>${esc(bill.paymentMethod || 'Forma de pagamento não informada')} · Criado em ${bill.createdAt ? esc(fmt(bill.createdAt)) : 'data não registrada'}</small></div><div class="payable-total"><b>${money(bill.totalAmount)}</b>${payableStatus(bill)}</div></div><div class="payable-progress"><span>Baixado: ${money(paidSum)} de ${money(bill.totalAmount)}</span><span>${parts.filter(item => item.paid).length}/${parts.length} parcelas</span></div>${bill.notes ? `<p class="payable-notes">${esc(bill.notes)}</p>` : ''}<div class="payable-installments-list">${partMarkup || '<div class="empty">Este lembrete ainda não tem parcelas.</div>'}</div><div class="payable-footer">${unpaidParts.length ? `<button type="button" class="small primary" data-action="settle-payable" data-bill-id="${esc(bill.id)}">Quitar todas as parcelas</button>` : ''}${canDelete ? `<button type="button" class="small danger-button" data-action="delete-payable" data-bill-id="${esc(bill.id)}">Excluir lembrete</button>` : '<small class="muted">O histórico permanece porque já há baixa registrada.</small>'}</div></article>`;
  }).join('') || '<div class="empty">Nenhum lembrete cadastrado. Toque em “Novo lembrete” para registrar uma conta a pagar.</div>';
}

function addMonthsClamped(dateString, months) {
  const parts = String(dateString || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return dateString;
  const [year, month, day] = parts;
  const first = new Date(year, month - 1 + months, 1, 12, 0, 0);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12, 0, 0).getDate();
  const finalDay = Math.min(day, lastDay);
  return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(finalDay).padStart(2, '0')}`;
}

$('newPayable').onclick = () => {
  $('payableForm').reset();
  $('payDue').value = today();
  $('payInstallmentCount').value = '1';
  $('payableDlg').showModal();
};
$('cancelPayable').onclick = () => { $('payableForm').reset(); $('payableDlg').close(); };
$('payableForm').onsubmit = event => {
  event.preventDefault();
  const supplier = $('paySupplier').value.trim();
  const description = $('payDescription').value.trim();
  const amount = Number($('payAmount').value);
  const firstDue = $('payDue').value;
  const count = Number($('payInstallmentCount').value);
  if (!supplier) { $('paySupplier').focus(); return; }
  if (!Number.isFinite(amount) || amount <= 0) { alert('Informe um valor total maior que zero.'); $('payAmount').focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDue)) { alert('Informe uma data de vencimento válida.'); $('payDue').focus(); return; }
  if (!Number.isInteger(count) || count < 1 || count > 60) { alert('A quantidade de parcelas deve ser de 1 a 60.'); $('payInstallmentCount').focus(); return; }
  const totalCents = Math.round(amount * 100);
  if (count > totalCents) { alert('Cada parcela precisa ter pelo menos R$ 0,01. Reduza a quantidade de parcelas ou aumente o valor total.'); $('payInstallmentCount').focus(); return; }
  const baseCents = Math.floor(totalCents / count);
  const remainder = totalCents - baseCents * count;
  const bill = {
    id: crypto.randomUUID(), supplier, description, totalAmount: totalCents / 100,
    paymentMethod: $('payMethod').value, notes: $('payNotes').value.trim(), createdAt: today(),
    installments: Array.from({ length: count }, (_, index) => ({
      id: crypto.randomUUID(), number: index + 1,
      value: (baseCents + (index < remainder ? 1 : 0)) / 100,
      due: addMonthsClamped(firstDue, index), paid: false, paidAt: ''
    }))
  };
  db.bills = Array.isArray(db.bills) ? db.bills : [];
  db.bills.unshift(bill);
  save();
  $('payableDlg').close();
  $('payableForm').reset();
  renderPayables();
};

window.payBillInstallment = (billId, installmentId) => {
  const bill = (db.bills || []).find(item => item.id === billId);
  const installment = bill && safeBillInstallments(bill).find(item => item.id === installmentId);
  if (!bill || !installment || installment.paid) return;
  if (!confirm(`Registrar a baixa da parcela ${installment.number} de “${bill.supplier}”, no valor de ${money(installment.value)}? Confira antes de confirmar que o pagamento foi realizado.`)) return;
  installment.paid = true;
  installment.paidAt = today();
  save();
  renderPayables();
};
window.undoPayablePayment = (billId, installmentId) => {
  const bill = (db.bills || []).find(item => item.id === billId);
  const installment = bill && safeBillInstallments(bill).find(item => item.id === installmentId);
  if (!bill || !installment || !installment.paid) return;
  if (!confirm(`Desfazer a baixa da parcela ${installment.number} de “${bill.supplier}”? Ela voltará a constar como pendente.`)) return;
  installment.paid = false;
  installment.paidAt = '';
  save();
  renderPayables();
};
window.settlePayable = billId => {
  const bill = (db.bills || []).find(item => item.id === billId);
  if (!bill) return;
  const pending = safeBillInstallments(bill).filter(item => !item.paid);
  if (!pending.length) return;
  const total = pending.reduce((sum, item) => sum + Number(item.value || 0), 0);
  if (!confirm(`Confirmar que todas as ${pending.length} parcela(s) restantes de “${bill.supplier}” foram pagas? Total da baixa: ${money(total)}.`)) return;
  pending.forEach(item => { item.paid = true; item.paidAt = today(); });
  save();
  renderPayables();
};
window.deletePayable = billId => {
  const bill = (db.bills || []).find(item => item.id === billId);
  if (!bill) return;
  if (safeBillInstallments(bill).some(item => item.paid)) {
    alert('Este lembrete já possui uma baixa registrada. O histórico será preservado; não é possível excluí-lo.');
    return;
  }
  if (!confirm(`Excluir o lembrete de pagamento de “${bill.supplier}”, no valor de ${money(bill.totalAmount)}? Esta ação não pode ser desfeita.`)) return;
  db.bills = (db.bills || []).filter(item => item.id !== billId);
  save();
  renderPayables();
};

// Delegação de eventos para botões dinâmicos. Valores vindos dos dados nunca entram em código inline.
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id, saleId, installmentId, billId, billInstallmentId } = button.dataset;
  switch (action) {
    case 'open-client': window.openClient(id); break;
    case 'adjust-stock': window.adjustStock(id); break;
    case 'show-pix': window.showPix(saleId, installmentId); break;
    case 'send-pix-whatsapp': window.sendPixWhatsApp(saleId, installmentId); break;
    case 'pay': window.pay(saleId, installmentId); break;
    case 'undo-payment': window.undoPayment(saleId, installmentId); break;
    case 'cancel-sale': window.cancelSale(saleId); break;
    case 'new-sale': window.newSale(id); break;
    case 'toggle-client-block': window.toggleClientSalesBlock(id); break;
    case 'delete-client': window.deleteClient(id); break;
    case 'archive-product': window.archiveProduct(id); break;
    case 'restore-product': window.restoreProduct(id); break;
    case 'delete-product': window.deleteProduct(id); break;
    case 'pay-bill-installment': window.payBillInstallment(billId, billInstallmentId); break;
    case 'undo-payable-payment': window.undoPayablePayment(billId, billInstallmentId); break;
    case 'settle-payable': window.settlePayable(billId); break;
    case 'delete-payable': window.deletePayable(billId); break;
  }
});

// Navegação. Configurações é bloqueada ao sair e exige PIN a cada nova entrada.
function showTab(tabName, options = {}) {
  if (tabName === 'settings' && !settingsUnlocked && !options.skipLock) { openPinDialog(hasSettingsPin() ? 'unlock' : 'setup'); return; }
  if (currentTab === 'settings' && tabName !== 'settings' && !options.skipLock) lockSettings(false);
  currentTab = tabName;
  document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item.dataset.t === tabName));
  document.querySelectorAll('.page').forEach(page => page.classList.toggle('hidden', page.id !== tabName));
  if (tabName === 'payables') renderPayables();
  if (tabName === 'reports') renderReports();
}
function hasSettingsPin() { return !!(db.settings && db.settings.configPinSalt && db.settings.configPinHash); }
function fillSettingsForm() {
  $('storeName').value = db.settings.store || 'Perfumaria';
  $('pixKey').value = db.settings.pixKey || '';
  $('pixName').value = db.settings.pixName || '';
  $('pixCity').value = db.settings.city || '';
}
function clearSettingsForm() {
  ['storeName', 'pixKey', 'pixName', 'pixCity'].forEach(id => { if ($(id)) $(id).value = ''; });
}
function armSettingsAutoLock() {
  clearTimeout(settingsAutoLockTimer);
  settingsAutoLockTimer = setTimeout(() => {
    if (currentTab === 'settings' && settingsUnlocked) {
      lockSettings(false);
      showTab('home', { skipLock: true });
      alert('Configurações bloqueadas por inatividade. Digite seu PIN para acessá-las novamente.');
    }
  }, 5 * 60 * 1000);
}
function lockSettings(navigateHome = false) {
  clearTimeout(settingsAutoLockTimer);
  settingsAutoLockTimer = null;
  settingsUnlocked = false;
  clearSettingsForm();
  if (navigateHome && currentTab === 'settings') showTab('home', { skipLock: true });
}
async function derivePinHash(pin, saltHex) {
  if (!window.crypto || !crypto.subtle) throw new Error('Este navegador não oferece a proteção criptográfica necessária. Abra o PerfumePay pelo endereço HTTPS.');
  const salt = new Uint8Array((saltHex.match(/.{1,2}/g) || []).map(pair => parseInt(pair, 16)));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, material, 256);
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
}
function newPinSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function openPinDialog(mode) {
  if (mode === 'change') { clearTimeout(settingsAutoLockTimer); settingsAutoLockTimer = null; }
  pinMode = mode;
  $('pinForm').reset();
  $('pinMessage').textContent = '';
  $('pinExistingGroup').classList.toggle('hidden', mode === 'setup');
  $('pinNewGroup').classList.toggle('hidden', mode === 'unlock');
  $('pinConfirmGroup').classList.toggle('hidden', mode === 'unlock');
  $('pinForgot').classList.toggle('hidden', mode !== 'unlock');
  $('pinTitle').textContent = mode === 'setup' ? 'Criar PIN das configurações' : mode === 'change' ? 'Alterar PIN das configurações' : 'Desbloquear configurações';
  $('pinIntro').textContent = mode === 'setup'
    ? 'Crie um PIN numérico de 6 a 8 dígitos. Ele será solicitado sempre que você abrir Configurações.'
    : mode === 'change'
      ? 'Confirme o PIN atual e escolha um novo PIN numérico de 6 a 8 dígitos.'
      : 'Digite seu PIN para liberar temporariamente esta área.';
  $('pinSubmit').textContent = mode === 'setup' ? 'Criar PIN e liberar' : mode === 'change' ? 'Salvar novo PIN' : 'Liberar acesso';
  $('pinDlg').showModal();
  setTimeout(() => $(mode === 'setup' ? 'pinNew' : 'pinExisting').focus(), 50);
}
function enterSettingsUnlocked() {
  settingsUnlocked = true;
  fillSettingsForm();
  showTab('settings', { skipLock: true });
  armSettingsAutoLock();
}
async function savePinVerifier(newPin) {
  const previousSalt = db.settings.configPinSalt;
  const previousHash = db.settings.configPinHash;
  const salt = newPinSalt();
  const hash = await derivePinHash(newPin, salt);
  db.settings.configPinSalt = salt;
  db.settings.configPinHash = hash;
  save();
  const synced = await flushPendingSave();
  if (!synced || writeFailed || savedRevision < changeRevision) {
    if (previousSalt) db.settings.configPinSalt = previousSalt; else delete db.settings.configPinSalt;
    if (previousHash) db.settings.configPinHash = previousHash; else delete db.settings.configPinHash;
    $('pinMessage').textContent = 'Não consegui salvar o PIN na nuvem. Verifique a conexão e tente novamente.';
    return false;
  }
  return true;
}
document.querySelectorAll('.tab').forEach(button => button.onclick = () => {
  const target = button.dataset.t;
  if (target === 'settings') {
    if (currentTab === 'settings' && settingsUnlocked) return;
    if (!cloudReady || !firebaseUser) { alert('Entre na sua conta e aguarde a sincronização antes de abrir Configurações.'); return; }
    openPinDialog(hasSettingsPin() ? 'unlock' : 'setup');
    return;
  }
  showTab(target);
});
$('pinCancel').onclick = () => $('pinDlg').close();
$('pinDlg').addEventListener('close', () => {
  ['pinExisting', 'pinNew', 'pinConfirm'].forEach(id => { $(id).value = ''; });
  $('pinMessage').textContent = '';
  if (settingsUnlocked && currentTab === 'settings') armSettingsAutoLock();
});
$('pinForm').onsubmit = async event => {
  event.preventDefault();
  if (Date.now() < pinBlockedUntil) {
    $('pinMessage').textContent = 'Muitas tentativas incorretas. Aguarde alguns segundos e tente novamente.';
    return;
  }
  const currentPin = $('pinExisting').value;
  const newPin = $('pinNew').value;
  const confirmPin = $('pinConfirm').value;
  const validPin = value => /^\d{6,8}$/.test(value);
  const userPinIsCorrect = async value => {
    const hash = await derivePinHash(value, db.settings.configPinSalt || '');
    return hash === db.settings.configPinHash;
  };
  try {
    if (pinMode === 'unlock') {
      if (!validPin(currentPin)) { $('pinMessage').textContent = 'Digite um PIN de 6 a 8 dígitos.'; return; }
      if (!(await userPinIsCorrect(currentPin))) {
        pinWrongAttempts++;
        if (pinWrongAttempts >= 5) { pinBlockedUntil = Date.now() + 30000; pinWrongAttempts = 0; }
        $('pinExisting').value = '';
        $('pinMessage').textContent = 'PIN incorreto. Confira os números e tente novamente.';
        return;
      }
      pinWrongAttempts = 0;
      $('pinDlg').close();
      enterSettingsUnlocked();
      return;
    }
    if (pinMode === 'change') {
      if (!validPin(currentPin)) { $('pinMessage').textContent = 'Digite seu PIN atual de 6 a 8 dígitos.'; return; }
      if (!(await userPinIsCorrect(currentPin))) { $('pinMessage').textContent = 'O PIN atual não confere.'; $('pinExisting').value = ''; return; }
    }
    if (!validPin(newPin)) { $('pinMessage').textContent = 'O novo PIN deve conter de 6 a 8 números.'; return; }
    if (newPin !== confirmPin) { $('pinMessage').textContent = 'Os PINs não são iguais. Digite-os novamente.'; $('pinConfirm').value = ''; return; }
    const saved = await savePinVerifier(newPin);
    if (!saved) return;
    $('pinDlg').close();
    if (pinMode === 'setup') enterSettingsUnlocked();
    else { settingsUnlocked = true; fillSettingsForm(); showTab('settings', { skipLock: true }); armSettingsAutoLock(); alert('PIN alterado com sucesso.'); }
  } catch (error) {
    console.error(error);
    $('pinMessage').textContent = error && error.message ? error.message : 'Não foi possível validar o PIN neste navegador.';
  }
};
$('pinForgot').onclick = async () => {
  const user = window.firebase && firebase.auth().currentUser;
  if (pinMode !== 'unlock' || !user || !user.email) {
    $('pinMessage').textContent = 'Não foi possível verificar a conta para redefinir o PIN.';
    return;
  }
  const password = prompt(`Para redefinir o PIN, confirme a senha da conta ${user.email}.`);
  if (password === null || password === '') return;
  const oldSalt = db.settings.configPinSalt;
  const oldHash = db.settings.configPinHash;
  try {
    const credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
    await user.reauthenticateWithCredential(credential);
    delete db.settings.configPinSalt;
    delete db.settings.configPinHash;
    save();
    const synced = await flushPendingSave();
    if (!synced || writeFailed || savedRevision < changeRevision) {
      if (oldSalt) db.settings.configPinSalt = oldSalt;
      if (oldHash) db.settings.configPinHash = oldHash;
      $('pinMessage').textContent = 'Não foi possível sincronizar a redefinição. Verifique a conexão e tente novamente.';
      return;
    }
    $('pinDlg').close();
    openPinDialog('setup');
  } catch (error) {
    console.error(error);
    $('pinMessage').textContent = 'A senha da conta não foi validada. O PIN não foi alterado.';
  }
};
$('changePinBtn').onclick = () => {
  if (!settingsUnlocked || currentTab !== 'settings') { alert('Desbloqueie Configurações com seu PIN primeiro.'); return; }
  openPinDialog('change');
};
$('settings').addEventListener('input', armSettingsAutoLock);
$('settings').addEventListener('click', armSettingsAutoLock);
$('search').oninput = render;
$('reportMonth').addEventListener('change', renderReports);
$('closeViewDlg').onclick = () => $('viewDlg').close();
$('closePixDlg').onclick = () => $('pixDlg').close();

// Clientes.
$('newClient').onclick = () => { $('clientForm').reset(); $('clientDlg').showModal(); };
$('cancelClient').onclick = () => { $('clientForm').reset(); $('clientDlg').close(); };
$('clientForm').onsubmit = event => {
  event.preventDefault();
  const name = $('cName').value.trim();
  if (!name) { $('cName').focus(); return; }
  db.clients.push({ id: crypto.randomUUID(), name, phone: $('cPhone').value.trim(), notes: $('cNotes').value.trim(), salesBlocked: false });
  save();
  $('clientDlg').close();
  $('clientForm').reset();
};

// Produtos e códigos únicos.
$('newProduct').onclick = () => {
  $('productForm').reset();
  $('pCode').value = nextProductCode();
  $('productDlg').showModal();
};
$('cancelProduct').onclick = () => { $('productForm').reset(); $('productDlg').close(); };
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
    stock: Number($('pStock').value) || 0,
    active: true
  });
  save();
  $('productDlg').close();
  $('productForm').reset();
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

// Descontinuar mantém o cadastro para preservar o histórico das vendas e permitir o cancelamento seguro.
window.archiveProduct = id => {
  const product = db.products.find(item => item.id === id);
  if (!product || product.active === false) return;
  if (!confirm(`Descontinuar “${product.name}”? O produto deixará de aparecer na pesquisa de novas vendas, mas será mantido para preservar o histórico e as operações de estoque.`)) return;
  product.active = false;
  product.discontinuedAt = today();
  save();
  render();
};

window.restoreProduct = id => {
  const product = db.products.find(item => item.id === id);
  if (!product || product.active !== false) return;
  if (!confirm(`Reativar “${product.name}” para que volte a aparecer na pesquisa de vendas?`)) return;
  product.active = true;
  delete product.discontinuedAt;
  save();
  render();
};

window.deleteProduct = id => {
  const product = db.products.find(item => item.id === id);
  if (!product) return;
  const linkedSales = db.sales.filter(sale => sale.productId === id);
  if (linkedSales.length) {
    alert('Este produto está vinculado ao histórico de vendas. Para preservar os registros e permitir cancelamentos corretos, não é possível excluí-lo permanentemente. Use “Descontinuar” para retirá-lo das novas vendas.');
    return;
  }
  if (Number(product.stock || 0) !== 0) {
    alert('Este produto ainda tem unidades no estoque. Ajuste a quantidade para zero antes de excluí-lo, ou use “Descontinuar” para manter o registro sem permitir novas vendas.');
    return;
  }
  if (!confirm(`Excluir permanentemente o produto “${product.name}” (${product.code || 'sem código'})? Esta ação não pode ser desfeita.`)) return;
  db.products = db.products.filter(item => item.id !== id);
  save();
  render();
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
  const matches = db.products.filter(product => product.active !== false && (
    String(product.name || '').toLowerCase().includes(query) || String(product.code || '').toLowerCase().includes(query)
  )).slice(0, 8);
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
  const blocked = active.salesBlocked === true;
  const overdueTotal = sales.reduce((total, sale) => total + (sale.installments || []).reduce((subtotal, installment) => {
    return subtotal + (!installment.paid && installment.due < today() ? Number(installment.value || 0) : 0);
  }, 0), 0);
  let html = `<h2>${esc(active.name)}</h2><p class="muted">${esc(active.phone || 'Sem WhatsApp')}</p>`;
  if (blocked) html += `<p class="client-blocked-notice"><b>VENDAS BLOQUEADAS</b><br>Motivo: ${esc(active.salesBlockReason || 'Atraso no pagamento')} • Desde ${esc(active.salesBlockedAt || 'data não registrada')}.</p>`;
  if (overdueTotal > 0) html += `<p class="late-notice">Parcelas vencidas em aberto: <b>${money(overdueTotal)}</b>.</p>`;
  html += `<div class="client-actions"><button type="button" class="primary" data-action="new-sale" data-id="${esc(active.id)}" ${blocked ? 'disabled' : ''}>${blocked ? 'Vendas bloqueadas' : '+ Nova venda fiada'}</button><button type="button" class="${blocked ? 'green' : 'warning-button'}" data-action="toggle-client-block" data-id="${esc(active.id)}">${blocked ? 'Desbloquear vendas' : 'Bloquear novas vendas por atraso'}</button><button type="button" class="small danger-button" data-action="delete-client" data-id="${esc(active.id)}">Excluir cliente</button></div>`;
  if (!sales.length) html += '<div class="empty">Este cliente ainda não tem vendas ativas.</div>';
  sales.forEach(sale => {
    const product = db.products.find(item => item.id === sale.productId);
    html += `<div class="sale-heading"><div><b>${esc(sale.desc)} — ${money(sale.total)}</b>${sale.productId ? `<div class="muted">Produto: ${esc(product?.name || 'Produto removido')} • Código: ${esc(product?.code || '—')} • Quantidade: ${Number(sale.quantity || 1)}</div>` : ''}</div><button type="button" class="small danger-button" data-action="cancel-sale" data-sale-id="${esc(sale.id)}">Cancelar venda</button></div>`;
    (sale.installments || []).forEach((installment, index) => {
      html += `<div class="installment"><div class="row"><span>${index + 1}/${sale.installments.length} • ${money(installment.value)}</span><span>${fmt(installment.due)}</span></div><div class="row">${st(installment)} ${installment.paid ? `<span class="muted">Pago ${fmt(installment.paidAt || today())}</span><button type="button" class="small warning-button" data-action="undo-payment" data-sale-id="${esc(sale.id)}" data-installment-id="${esc(installment.id)}">Desfazer recebimento</button>` : `<button type="button" class="small" data-action="show-pix" data-sale-id="${esc(sale.id)}" data-installment-id="${esc(installment.id)}">PIX</button><button type="button" class="small green" data-action="pay" data-sale-id="${esc(sale.id)}" data-installment-id="${esc(installment.id)}">Recebido</button>`}</div></div>`;
    });
  });
  $('view').innerHTML = html;
  $('viewDlg').showModal();
};

window.newSale = clientId => {
  // Vincula a venda explicitamente ao cliente escolhido, sem depender de uma referência
  // global que possa estar desatualizada em outra interação da interface.
  const targetId = clientId || active?.id;
  const currentClient = db.clients.find(client => client.id === targetId);
  if (!currentClient) {
    alert('Selecione um cliente válido antes de iniciar uma venda.');
    return;
  }
  if (currentClient.salesBlocked === true) {
    alert(`Não é possível iniciar uma nova venda fiada: ${currentClient.name} está com as vendas bloqueadas por atraso no pagamento. Desbloqueie o cliente primeiro, se decidir autorizar uma nova venda.`);
    if ($('saleDlg').open) $('saleDlg').close();
    openClient(currentClient.id);
    return;
  }
  active = currentClient;
  selectedSaleClientId = currentClient.id;
  $('viewDlg').close();
  $('saleForm').reset();
  // reset() também apaga o campo oculto, então o vínculo é definido depois do reset.
  selectedSaleClientId = currentClient.id;
  $('saleClientId').value = currentClient.id;
  selectedSaleProductId = null;
  $('sProductSearch').value = '';
  $('sQty').value = '1';
  $('stockHint').textContent = 'Pesquise pelo nome ou código e escolha um produto para dar baixa no estoque automaticamente.';
  $('saleWho').textContent = 'Cliente: ' + currentClient.name;
  $('sDate').value = today();
  renderProductSearch();
  $('saleDlg').showModal();
};

$('saleForm').onsubmit = event => {
  event.preventDefault();
  // Última barreira: valida o cliente vinculado ao formulário no instante de salvar.
  // Mesmo se a janela estava aberta antes do bloqueio, a venda precisa ser recusada.
  const submittedClientId = $('saleClientId').value || selectedSaleClientId;
  const currentClient = db.clients.find(client => client.id === submittedClientId);
  if (!currentClient) {
    alert('Selecione um cliente válido antes de registrar a venda. Feche o formulário e abra a venda novamente pelo cadastro correto.');
    $('saleDlg').close();
    return;
  }
  if (currentClient.salesBlocked === true) {
    alert(`Venda não registrada: ${currentClient.name} está com as vendas bloqueadas por atraso no pagamento. As cobranças e os pagamentos anteriores continuam disponíveis.`);
    $('saleDlg').close();
    selectedSaleClientId = null;
    $('saleClientId').value = '';
    openClient(currentClient.id);
    return;
  }
  const total = Number($('sTotal').value);
  const installmentsCount = Number($('sN').value);
  const quantity = Number($('sQty').value) || 1;
  const product = selectedSaleProductId ? db.products.find(item => item.id === selectedSaleProductId) : null;
  if (product && product.active === false) {
    alert('Este produto foi descontinuado e não pode ser usado em novas vendas. Escolha outro produto.');
    selectedSaleProductId = null;
    renderProductSearch();
    return;
  }
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
    id: crypto.randomUUID(), clientId: currentClient.id,
    createdAt: today(),
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
  $('saleForm').reset();
  selectedSaleClientId = null;
  $('saleClientId').value = '';
  openClient(currentClient.id);
};

$('cancelSale').onclick = () => {
  $('saleForm').reset();
  selectedSaleClientId = null;
  $('saleClientId').value = '';
  selectedSaleProductId = null;
  $('saleDlg').close();
  if (active && db.clients.some(client => client.id === active.id)) openClient(active.id);
};

window.toggleClientSalesBlock = id => {
  const client = db.clients.find(item => item.id === id);
  if (!client) return;
  if (client.salesBlocked === true) {
    if (!confirm(`Desbloquear novas vendas para ${client.name}? O aplicativo voltará a permitir novas vendas fiadas para este cliente.`)) return;
    client.salesBlocked = false;
    delete client.salesBlockedAt;
    delete client.salesBlockReason;
    save();
    render();
    if (active && active.id === id) openClient(id);
    alert('Cliente desbloqueado para novas vendas.');
    return;
  }

  const overdueInstallments = activeSales().filter(sale => sale.clientId === id).flatMap(sale => sale.installments || [])
    .filter(installment => !installment.paid && installment.due < today());
  if (!overdueInstallments.length) {
    alert('Este cliente não tem parcelas vencidas em aberto. O bloqueio por atraso só pode ser aplicado quando houver pelo menos uma parcela vencida.');
    return;
  }
  const overdueTotal = overdueInstallments.reduce((sum, installment) => sum + Number(installment.value || 0), 0);
  if (!confirm(`Bloquear novas vendas para ${client.name}?\n\nHá ${overdueInstallments.length} parcela(s) vencida(s), totalizando ${money(overdueTotal)}. O cliente continuará aparecendo no sistema e as cobranças existentes não serão alteradas.`)) return;
  client.salesBlocked = true;
  client.salesBlockedAt = today();
  client.salesBlockReason = 'Atraso no pagamento';
  save();
  render();
  if (active && active.id === id) openClient(id);
  alert('Novas vendas bloqueadas para este cliente. As vendas existentes e as cobranças continuam disponíveis.');
};

window.deleteClient = id => {
  const client = db.clients.find(item => item.id === id);
  if (!client) return;
  const linkedSales = db.sales.filter(sale => sale.clientId === id);
  const activeLinkedSales = linkedSales.filter(sale => !sale.cancelled);
  if (activeLinkedSales.length) {
    alert(`Não é possível excluir ${client.name} porque existem ${activeLinkedSales.length} venda(s) ativa(s) vinculada(s). Se a venda foi cadastrada por engano, cancele-a primeiro e depois tente excluir o cliente.`);
    return;
  }
  const hasReceivedPayments = linkedSales.some(sale => (sale.installments || []).some(installment => installment.paid));
  if (hasReceivedPayments) {
    alert('Não é possível excluir este cliente porque o histórico contém parcelas marcadas como recebidas. Mantenha o cadastro para preservar o histórico financeiro.');
    return;
  }
  const cancelledCount = linkedSales.length;
  const detail = cancelledCount
    ? `\n\nTambém serão removidas ${cancelledCount} venda(s) já cancelada(s), sem parcelas recebidas, vinculada(s) a esse cadastro.`
    : '';
  if (!confirm(`Excluir permanentemente o cadastro de ${client.name}? Esta ação não pode ser desfeita.${detail}`)) return;
  db.clients = db.clients.filter(item => item.id !== id);
  // Só são removidas vendas quando já estão canceladas e não possuem pagamentos registrados.
  db.sales = db.sales.filter(sale => sale.clientId !== id);
  if (active && active.id === id) active = null;
  save();
  render();
  if ($('viewDlg').open) $('viewDlg').close();
  alert('Cliente excluído. Como não havia vendas ativas nem parcelas recebidas, o resumo financeiro não foi alterado.');
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

// Pix estático Copia e Cola + QR Code gerado localmente no navegador.
function crc(str) {
  let value = 0xffff;
  for (let index = 0; index < str.length; index++) {
    value ^= str.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit++) value = (value & 0x8000) ? ((value << 1) ^ 0x1021) & 0xffff : (value << 1) & 0xffff;
  }
  return value.toString(16).toUpperCase().padStart(4, '0');
}
function fld(id, value) { return id + String(value.length).padStart(2, '0') + value; }
function pixAscii(value, maxLength) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 .\-]/g, '').trim().slice(0, maxLength);
}
function pix(key, amount, name, city, tx) {
  const pixKey = String(key || '').trim();
  if (!pixKey || /[^\x20-\x7E]/.test(pixKey)) throw new Error('A chave Pix precisa estar preenchida e conter somente caracteres ASCII. Confira a chave em Configurações.');
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('O valor da cobrança Pix precisa ser maior que zero.');
  const merchantName = pixAscii(name, 25);
  const merchantCity = pixAscii(city, 15);
  if (!merchantName || !merchantCity) throw new Error('Preencha o nome do titular da chave Pix e a cidade em Configurações.');
  const merchant = fld('00', 'BR.GOV.BCB.PIX') + fld('01', pixKey);
  const m = fld('26', merchant);
  const txid = String(tx || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 25) || '***';
  const additional = fld('62', fld('05', txid));
  // QR estático BR Code: chave + valor fixo + txid. O campo 01 de iniciação
  // não é incluído; 12 é reservado ao fluxo dinâmico baseado em URL.
  const body = fld('00', '01') + m + fld('52', '0000') + fld('53', '986') + fld('54', Number(amount).toFixed(2)) + fld('58', 'BR') + fld('59', merchantName) + fld('60', merchantCity) + additional + '6304';
  return body + crc(body);
}
function pixQrSvg(payload) {
  if (typeof window.PerfumePayQRCode !== 'function') throw new Error('O gerador de QR Code não foi carregado. Atualize a página e tente novamente.');
  const qr = new window.PerfumePayQRCode(0, 0); // Correção de erros M
  qr.addData(payload);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = n + quiet * 2;
  const paths = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(row, col)) paths.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
    }
  }
  // SVG interno, criado a partir somente da matriz numérica do QR; payload não é interpolado no HTML.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR Code Pix para pagamento"><rect width="${size}" height="${size}" fill="#fff"/><path d="${paths.join('')}" fill="#111" shape-rendering="crispEdges"/></svg>`;
}
function downloadPixQr() {
  const svg = $('pixQr')?.querySelector('svg');
  if (!svg) { alert('O QR Code não está disponível. Gere a cobrança novamente.'); return; }
  const svgBlob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 800; canvas.height = 800;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      URL.revokeObjectURL(svgUrl);
      if (!blob) { alert('Não foi possível criar o arquivo PNG. Use o Pix Copia e Cola.'); return; }
      const pngUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = pngUrl; link.download = 'PerfumePay-Pix-QR.png';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
    }, 'image/png');
  };
  image.onerror = () => { URL.revokeObjectURL(svgUrl); alert('Não foi possível exportar o QR Code. Use o Pix Copia e Cola.'); };
  image.src = svgUrl;
}
function getPixChargeDetails(saleId, installmentId) {
  const sale = db.sales.find(item => item.id === saleId && !item.cancelled);
  const installment = sale?.installments.find(item => item.id === installmentId);
  if (!sale || !installment || installment.paid) {
    alert('Esta cobrança não está disponível para pagamento. Confira se a parcela já foi recebida ou se a venda foi cancelada.');
    return null;
  }
  const client = db.clients.find(item => item.id === sale.clientId);
  if (!client) {
    alert('Não foi possível encontrar o cadastro do cliente desta cobrança.');
    return null;
  }
  const key = db.settings.pixKey;
  const pixName = db.settings.pixName || '';
  const city = db.settings.city || '';
  if (!key) { alert('Cadastre sua chave Pix em Configurações.'); return null; }
  if (!pixName || !city || pixAscii(city, 15) === 'BRASIL') {
    alert('Antes de gerar o QR Code, abra Configurações e preencha “Nome do titular da chave Pix” exatamente como aparece no banco e a cidade real do titular. Depois salve as configurações.');
    return null;
  }
  let code;
  try { code = pix(key, installment.value, pixName, city, installmentId); }
  catch (error) { alert(error.message || 'Não foi possível gerar o Pix. Confira as configurações.'); return null; }
  const due = new Date(`${installment.due}T12:00:00`);
  const base = new Date(`${today()}T12:00:00`);
  const daysUntilDue = Math.round((due.getTime() - base.getTime()) / 86400000);
  let duePhrase;
  if (daysUntilDue < 0) duePhrase = `venceu há ${Math.abs(daysUntilDue)} dia(s)`;
  else if (daysUntilDue === 0) duePhrase = 'vence hoje';
  else if (daysUntilDue === 1) duePhrase = 'vence amanhã';
  else duePhrase = `vence em ${daysUntilDue} dias`;
  const message = `Olá, ${client.name || 'tudo bem'}! Passando para lembrar que sua parcela referente a “${sale.desc || 'sua compra'}”, no valor de ${money(installment.value)}, ${duePhrase} (${fmt(installment.due)}).\n\nPix Copia e Cola:\n${code}\n\nPara pagar, copie o código completo e cole no aplicativo do seu banco. Confira o nome do recebedor e o valor antes de confirmar. Após realizar o pagamento, pode me enviar o comprovante. Obrigado!`;
  return { sale, installment, client, code, message };
}

function normalizeBrazilWhatsApp(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return '';
}

function openWhatsAppWithMessage(phone, message) {
  const normalizedPhone = normalizeBrazilWhatsApp(phone);
  if (!normalizedPhone) {
    alert('Este cliente não tem um número de WhatsApp válido. Cadastre o telefone com DDD (10 ou 11 dígitos) para enviar a cobrança.');
    return false;
  }
  const url = `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message)}`;
  // Abre o WhatsApp numa nova aba com a mensagem preenchida. O usuário ainda precisa
  // revisar e tocar em Enviar; uma página estática não pode enviar mensagens em segundo plano.
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  return true;
}

window.sendPixWhatsApp = (saleId, installmentId) => {
  const details = getPixChargeDetails(saleId, installmentId);
  if (!details) return;
  openWhatsAppWithMessage(details.client.phone, details.message);
};

window.showPix = (saleId, installmentId) => {
  const details = getPixChargeDetails(saleId, installmentId);
  if (!details) return;
  let qrMarkup;
  try { qrMarkup = pixQrSvg(details.code); }
  catch (error) { console.error(error); alert(error.message || 'Não foi possível gerar o QR Code.'); return; }
  $('pixView').innerHTML = `<h2>PIX da parcela</h2><p><b>${money(details.installment.value)}</b> • vencimento ${fmt(details.installment.due)}</p><div class="pix-qr-card"><div class="pix-qr-frame" id="pixQr">${qrMarkup}</div><b>Escaneie para pagar com Pix</b><p class="muted">Abra o aplicativo do banco do pagador e leia o QR Code. Confira o nome do recebedor e o valor antes de confirmar.</p><button class="secondary" id="downloadPixQr" type="button">Baixar QR Code (PNG)</button></div><p class="muted">Ou use o Pix Copia e Cola</p><div class="copy">${esc(details.code)}</div><div class="actions pix-actions"><button class="primary" id="copyPix" type="button">Copiar Pix</button><button id="copyCharge" type="button">Copiar cobrança</button><button class="green whatsapp-button" id="sendPixWhatsApp" type="button">Enviar cobrança pelo WhatsApp</button></div><p class="pix-warning">O QR Code é gerado localmente e não confirma o pagamento automaticamente. Para mandar a imagem pelo WhatsApp, baixe o PNG e anexe manualmente. Confira o recebimento no seu banco antes de marcar a parcela como paga.</p>`;
  $('copyPix').onclick = async () => { try { await navigator.clipboard.writeText(details.code); alert('Pix Copia e Cola copiado!'); } catch (_) { alert('Não foi possível copiar automaticamente. Selecione e copie o código.'); } };
  $('copyCharge').onclick = async () => { try { await navigator.clipboard.writeText(details.message); alert('Cobrança copiada! Você pode enviá-la por WhatsApp.'); } catch (_) { alert('Não foi possível copiar automaticamente.'); } };
  $('downloadPixQr').onclick = downloadPixQr;
  $('sendPixWhatsApp').onclick = () => openWhatsAppWithMessage(details.client.phone, details.message);
  $('pixDlg').showModal();
};

// Configurações. Esta checagem complementa o bloqueio visual por PIN; não substitui o Firebase Auth.
$('saveSettings').onclick = () => {
  if (!settingsUnlocked || currentTab !== 'settings') { alert('Digite o PIN para desbloquear Configurações antes de salvar.'); return; }
  db.settings.store = $('storeName').value.trim() || 'Perfumaria';
  db.settings.pixKey = $('pixKey').value.trim();
  db.settings.pixName = $('pixName').value.trim();
  db.settings.city = $('pixCity').value.trim();
  save();
  alert('Configurações salvas.');
  armSettingsAutoLock();
};

// Backup manual: exporta somente depois de confirmar que as alterações pendentes foram sincronizadas.
const BACKUP_FORMAT = 'PerfumePay-backup';
const BACKUP_VERSION = 1;
$('exportBackup').onclick = async () => {
  const button = $('exportBackup');
  if (!firebaseUser || !cloudReady || !currentDocRef) {
    alert('Entre na sua conta e aguarde os dados carregarem da nuvem antes de fazer o backup.');
    return;
  }
  button.disabled = true;
  try {
    setSync('Conferindo sincronização antes do backup…');
    const synced = await flushPendingSave();
    if (!synced || writeFailed || savedRevision < changeRevision) {
      setSync('Backup não criado: há dados que não foram sincronizados.');
      alert('Não criei o backup porque não consegui confirmar que todas as alterações foram salvas na nuvem. Verifique a conexão e tente novamente.');
      return;
    }
    const ownerUid = firebaseUser.uid;
    const backup = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      ownerUid,
      ownerEmail: firebaseUser.email || '',
      data: JSON.parse(JSON.stringify(db))
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = `PerfumePay-backup-${date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setSync('Backup baixado; dados sincronizados na nuvem ✓');
    alert('Cópia de segurança criada. Guarde o arquivo em local privado: ele contém dados de clientes, vendas e a chave Pix. O arquivo não é criptografado.');
  } catch (error) {
    console.error(error);
    setSync('Não foi possível criar o backup.');
    alert('Não foi possível criar a cópia de segurança. Verifique a conexão e tente novamente.');
  } finally {
    button.disabled = false;
  }
};

$('chooseBackup').onclick = () => {
  if (!firebaseUser || !cloudReady || !currentDocRef) {
    alert('Entre na sua conta e aguarde os dados carregarem antes de restaurar uma cópia.');
    return;
  }
  $('backupFile').click();
};

$('backupFile').onchange = async event => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    if (!firebaseUser || !cloudReady || !currentDocRef) throw new Error('A conta não está pronta para restaurar.');
    const raw = await file.text();
    const backup = JSON.parse(raw);
    if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
      throw new Error('Este arquivo não é uma cópia de segurança compatível do PerfumePay.');
    }
    if (backup.ownerUid !== firebaseUser.uid) {
      throw new Error('Esta cópia pertence a outra conta. Por segurança, só é possível restaurá-la na conta que a criou.');
    }
    const data = backup.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.clients) || !Array.isArray(data.sales) || !Array.isArray(data.products) || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) {
      throw new Error('O arquivo está incompleto ou não contém os dados esperados. Nenhum dado foi alterado.');
    }
    const restoredDb = normalizeDatabase(data).db;
    // Primeiro, garante que o estado atual não tem alterações pendentes.
    const synced = await flushPendingSave();
    if (!synced || writeFailed || savedRevision < changeRevision) {
      throw new Error('Existem alterações atuais que não foi possível sincronizar. A restauração foi cancelada para evitar perda de dados.');
    }
    const stamp = backup.exportedAt ? new Date(backup.exportedAt).toLocaleString('pt-BR') : 'data desconhecida';
    const summary = `Arquivo: ${file.name}
Data da cópia: ${stamp}
Clientes: ${restoredDb.clients.length}
Produtos: ${restoredDb.products.length}
Vendas: ${restoredDb.sales.length}

ATENÇÃO: isso substituirá TODOS os dados atuais desta conta pela cópia escolhida.`;
    if (!confirm(summary)) return;
    const phrase = prompt('Para confirmar, digite exatamente RESTAURAR CÓPIA. A ação substituirá os dados atuais da nuvem.');
    if (String(phrase || '').trim() !== 'RESTAURAR CÓPIA') {
      alert('Restauração cancelada. Nenhum dado foi substituído.');
      return;
    }
    const ownerAtStart = firebaseUser.uid;
    const docAtStart = currentDocRef;
    setSync('Restaurando cópia de segurança na nuvem…');
    await docAtStart.set({ data: restoredDb, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    // Não repintar os dados antigos/restaurados se o usuário trocou de conta durante a operação.
    if (!firebaseUser || firebaseUser.uid !== ownerAtStart || currentDocRef !== docAtStart || !cloudReady) return;
    db = restoredDb;
    changeRevision++;
    savedRevision = changeRevision;
    writeFailed = false;
    if (settingsUnlocked && currentTab === 'settings') fillSettingsForm(); else clearSettingsForm();
    render();
    setSync('Cópia restaurada e sincronizada na nuvem ✓');
    alert('Cópia restaurada com sucesso. Atualize a página e confirme que os dados aparecem corretamente.');
  } catch (error) {
    console.error(error);
    setSync('Não foi possível restaurar a cópia.');
    alert(error && error.message ? error.message : 'Não foi possível restaurar a cópia. Nenhum dado foi alterado se a gravação não foi concluída.');
  } finally {
    $('backupFile').value = '';
  }
};

clearSettingsForm();
render();

// Firebase Auth + Firestore: os dados não são mantidos em localStorage.
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
  const retryButton = $('retryCloudBtn');

  function clearSessionData() {
    clearTimeout(saveTimer);
    saveTimer = null;
    // Fecha também os diálogos de detalhes/PIX antes de limpar a tela, para que não fique
    // informação antiga na camada modal do navegador depois de sair ou trocar de conta.
    ['clientDlg', 'productDlg', 'saleDlg', 'viewDlg', 'pixDlg', 'payableDlg', 'pinDlg'].forEach(id => {
      const dialog = $(id);
      if (dialog && dialog.open) dialog.close();
    });
    ['clientForm', 'productForm', 'saleForm', 'payableForm', 'pinForm'].forEach(id => { const form = $(id); if (form) form.reset(); });
    $('view').innerHTML = '';
    $('pixView').innerHTML = '';
    $('search').value = '';
    cloudReady = false;
    currentDocRef = null;
    active = null;
    selectedSaleProductId = null;
    db = emptyDatabase();
    changeRevision = 0;
    savedRevision = 0;
    writeFailed = false;
    lockSettings(false);
    showTab('home', { skipLock: true });
    clearSettingsForm();
    render();
  }

  function showLogin(message, canRetry = false) {
    $('appShell').classList.add('hidden');
    $('cloudLogin').classList.remove('hidden');
    $('loginMessage').textContent = message || '';
    retryButton.hidden = !canRetry;
  }

  function hasMeaningfulLegacyData(data) {
    return !!(data && (
      (Array.isArray(data.clients) && data.clients.length) ||
      (Array.isArray(data.sales) && data.sales.length) ||
      (Array.isArray(data.products) && data.products.length) ||
      (data.settings && (data.settings.pixKey || data.settings.pixName || data.settings.store && data.settings.store !== 'Perfumaria' || data.settings.city))
    ));
  }

  async function loadUserData(user) {
    if (!user || !auth.currentUser || auth.currentUser.uid !== user.uid) return;
    clearSessionData();
    firebaseUser = user;
    showLogin('Conta autenticada. Carregando seus dados protegidos…');
    setSync('Carregando dados da nuvem…');

    try {
      const ref = store.collection('users').doc(user.uid).collection('appData').doc('main');
      const snapshot = await ref.get();
      if (!auth.currentUser || auth.currentUser.uid !== user.uid) return;

      let loadedDb;
      let shouldWrite = false;
      if (snapshot.exists) {
        const envelope = snapshot.data();
        if (!envelope || !envelope.data || typeof envelope.data !== 'object') {
          throw new Error('O documento principal existe, mas não tem o formato de dados esperado. Nenhum dado foi alterado.');
        }
        const normalized = normalizeDatabase(envelope.data);
        loadedDb = normalized.db;
        shouldWrite = normalized.changed;
      } else {
        // Migração antiga é sempre explícita. Nunca importamos automaticamente o cache global para outra conta.
        let legacyDb = null;
        try {
          const raw = localStorage.getItem(LEGACY_KEY);
          if (raw) legacyDb = normalizeDatabase(JSON.parse(raw)).db;
        } catch (parseError) {
          console.warn('O cache antigo não pôde ser interpretado; ele não será importado.', parseError);
        }
        if (hasMeaningfulLegacyData(legacyDb)) {
          const choice = prompt(
            'ATENÇÃO: esta versão encontrou dados salvos pelo aplicativo antigo neste navegador. Eles podem pertencer a outra conta.\n\n' +
            'Para importar os dados antigos para a conta ' + user.email + ', digite exatamente:\nIMPORTAR DADOS ANTIGOS\n\n' +
            'Para iniciar esta conta vazia, digite:\nVAZIO\n\n' +
            'Qualquer outra resposta cancela a abertura por segurança.'
          );
          if (String(choice || '').trim() === 'IMPORTAR DADOS ANTIGOS') {
            loadedDb = legacyDb;
          } else if (String(choice || '').trim() === 'VAZIO') {
            loadedDb = emptyDatabase();
          } else {
            showLogin('A abertura foi cancelada por segurança. Os dados antigos não foram importados nem apagados. Clique em “Tentar carregar novamente” para escolher.', true);
            setSync('Aguardando escolha de migração segura.');
            return;
          }
        } else {
          loadedDb = emptyDatabase();
        }
        // Só gravamos o documento inicial após a escolha de migração, se necessária.
        if (!auth.currentUser || auth.currentUser.uid !== user.uid) return;
        await ref.set({ data: loadedDb, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      }

      if (shouldWrite) {
        if (!auth.currentUser || auth.currentUser.uid !== user.uid) return;
        await ref.set({ data: loadedDb, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      }
      if (!auth.currentUser || auth.currentUser.uid !== user.uid) return;

      // Firestore é a fonte de verdade. O cache global legado é removido somente depois de
      // confirmar que os dados dessa conta foram lidos/criados com sucesso na nuvem.
      try { localStorage.removeItem(LEGACY_KEY); } catch (_) { /* armazenamento local pode estar bloqueado */ }
      db = loadedDb;
      currentDocRef = ref;
      changeRevision = 0;
      savedRevision = 0;
      cloudReady = true;
      retryButton.hidden = true;
      $('loginPassword').value = '';
      $('cloudLogin').classList.add('hidden');
      $('appShell').classList.remove('hidden');
      lockSettings(false);
      showTab('home', { skipLock: true });
      render();
      setSync('Sincronizado na nuvem ✓');
    } catch (error) {
      console.error(error);
      clearSessionData();
      showLogin('Não foi possível carregar com segurança os dados da nuvem. O aplicativo ficou bloqueado e nenhuma alteração local foi enviada. Verifique a conexão e as regras do Firestore; depois tente novamente.', true);
      setSync('Nuvem indisponível — edição bloqueada.');
    }
  }

  $('loginBtn').onclick = async () => {
    const email = $('loginEmail').value.trim(), password = $('loginPassword').value;
    if (!email || !password) { $('loginMessage').textContent = 'Digite seu e-mail e sua senha.'; return; }
    $('loginMessage').textContent = 'Entrando…';
    try { await auth.signInWithEmailAndPassword(email, password); $('loginPassword').value = ''; }
    catch (error) { $('loginMessage').textContent = authMessage(error); }
  };

  $('createBtn').onclick = async () => {
    const email = $('loginEmail').value.trim(), password = $('loginPassword').value;
    if (!email || password.length < 6) { $('loginMessage').textContent = 'Digite um e-mail válido e uma senha com pelo menos 6 caracteres.'; return; }
    $('loginMessage').textContent = 'Criando conta…';
    try { await auth.createUserWithEmailAndPassword(email, password); $('loginPassword').value = ''; }
    catch (error) { $('loginMessage').textContent = authMessage(error); }
  };

  retryButton.onclick = async () => {
    if (auth.currentUser) await loadUserData(auth.currentUser);
    else $('loginMessage').textContent = 'Entre novamente para carregar os dados da nuvem.';
  };

  $('logoutBtn').onclick = async () => {
    clearTimeout(saveTimer);
    if (cloudReady && savedRevision < changeRevision) {
      const synced = await flushPendingSave();
      if (!synced && !confirm('Existem alterações que não foram sincronizadas. Se sair agora, elas serão descartadas desta sessão. Deseja sair mesmo assim?')) return;
    }
    try {
      await auth.signOut();
    } catch (error) {
      console.error(error);
      alert('Não foi possível encerrar a sessão. Tente novamente.');
      return;
    }
    firebaseUser = null;
    clearSessionData();
    showLogin('Você saiu da conta. Os dados pessoais foram removidos da memória desta sessão.');
  };

  auth.onAuthStateChanged(async user => {
    clearSessionData();
    firebaseUser = user || null;
    if (!user) {
      showLogin('Entre para acessar seus dados sincronizados na nuvem.');
      setSync('Desconectado');
      return;
    }
    await loadUserData(user);
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
