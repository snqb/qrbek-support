import {
  BANKS,
  decodePage,
  encodePage,
  inspectQr,
  normalizePage,
  paymentTarget,
} from './payment.js?v=20260921-zero-amount1';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const pageKind = document.body?.classList.contains('builder-page') ? 'builder' : document.body?.classList.contains('receiver-page') ? 'receiver' : 'home';
const designBase = ['/opendesign', '/interface-design'].includes(document.body?.dataset.designBase) ? document.body.dataset.designBase : '';
const bankById = new Map((BANKS || []).map((bank) => [bank.id, bank]));
const bankOptions = (sourceOnly = false) => (BANKS || []).filter((bank) => !sourceOnly || bank.allowAsSource !== false).map((bank) => `<option value="${escapeHtml(bank.id)}">${escapeHtml(bank.name)}</option>`).join('');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const fragmentDraft = () => {
  const match = location.hash.match(/^#draft=(.+)$/);
  if (!match) return null;
  try { return decodePage(`#p=${decodeURIComponent(match[1])}`); } catch { return null; }
};
const show = (node) => { if (node) node.hidden = false; };
const hide = (node) => { if (node) node.hidden = true; };
const setText = (node, text) => { if (node) node.textContent = text; };
const formatAmount = (value) => String(value || '').replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const announce = (node, text, isError = false) => { if (!node) return; node.textContent = text; node.classList.toggle('is-error', isError); node.hidden = !text; };

async function drawQr(canvas, value, size = 320) {
  if (!canvas || !value || !globalThis.QRCode?.toCanvas) throw new Error('QR-код сейчас недоступен.');
  canvas.width = size; canvas.height = size;
  const result = QRCode.toCanvas(canvas, value, { width: size, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#0c1711', light: '#ffffff' } });
  if (result?.then) await result;
}

function initCounts() {
  $$('[data-count-for]').forEach((counter) => {
    const input = document.getElementById(counter.dataset.countFor);
    if (!input) return;
    const update = () => { counter.textContent = `${input.value.length} / ${input.maxLength}`; };
    input.addEventListener('input', update); update();
  });
}


const emptyMethod = () => ({ kind: 'qr', label: '', value: '', bankId: '' });
const methodTemplate = (method, index) => `<article class="method-row" data-bank-id="${escapeHtml(method.bankId)}">
  <div class="method-row-head"><div class="method-row-title"><img class="bank-preview" alt="" width="28" height="28" hidden><span class="method-number">QR ${index + 1}</span></div><button class="remove-method" type="button" aria-label="Удалить QR ${index + 1}">×</button></div>
  <button class="upload-qr" type="button"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z"/></svg><span>Выбрать фото QR</span></button>
  <label class="field method-value-field"><span>Или вставьте ссылку / текст QR</span><textarea class="method-value" rows="2" maxlength="3000" placeholder="https://…">${escapeHtml(method.value)}</textarea></label>
  <div class="method-meta"><label class="field"><span>Название QR</span><input class="method-label" type="text" maxlength="80" value="${escapeHtml(method.label)}" placeholder="Например, личный"></label><p class="method-status" role="status" aria-live="polite"></p></div>
</article>`;

function initBuilder() {
  const form = $('#payment-form');
  if (!form) return;
  const list = $('#methods-list');
  let methods = [];
  const draft = fragmentDraft();
  if (draft?.methods?.length) methods = draft.methods.slice(0, 8);
  else methods = [emptyMethod()];
  if (draft) {
    $('#page-title').value = draft.title;
    $('#page-note').value = draft.note;
    $('#page-amount').value = draft.amount;
  }
  const renderMethods = () => {
    list.innerHTML = methods.map(methodTemplate).join('');
    methods.forEach((method, index) => {
      const row = list.children[index];
      if (method.value) validateMethod(row, method.value, false);
      updateBankLogo(row);
    });
  };
  const collectMethods = () => [...list.children].map((row) => ({
    kind: 'qr',
    label: $('.method-label', row)?.value.trim() || '',
    value: $('.method-value', row)?.value.trim() || '',
    bankId: row.dataset.bankId || '',
  }));
  const sync = () => { methods = collectMethods(); };
  const validateMethod = async (row, value, announceResult = true) => {
    row.dataset.bankId = '';
    updateBankLogo(row);
    if (!value) { announce($('.method-status', row), ''); return; }
    const status = $('.method-status', row);
    const currentValue = value;
    announce(status, 'Проверяем QR…');
    try {
      const inspected = await inspectQr(value);
      if ($('.method-value', row)?.value.trim() !== currentValue) return;
      if (inspected?.bankId && bankById.has(inspected.bankId)) { row.dataset.bankId = inspected.bankId; updateBankLogo(row); }
      status.textContent = inspected.name || bankById.get(inspected.bankId)?.name || 'QR распознан';
      status.classList.remove('is-error');
    } catch (error) {
      if ($('.method-value', row)?.value.trim() !== currentValue) return;
      status.textContent = announceResult ? (error.message || 'Не удалось распознать QR') : '';
      status.classList.toggle('is-error', announceResult);
    }
  };
  const updateBankLogo = (row) => {
    const id = row.dataset.bankId;
    const image = $('.bank-preview', row);
    const bank = bankById.get(id);
    if (!bank) { hide(image); return; }
    image.src = bank.icon || `/assets/banks/${bank.id}.png`; show(image);
  };
  list.addEventListener('input', (event) => {
    const row = event.target.closest('.method-row'); if (!row) return;
    if (event.target.classList.contains('method-value')) window.clearTimeout(row._inspectTimer), row._inspectTimer = window.setTimeout(() => validateMethod(row, event.target.value.trim()), 320);
  });
  list.addEventListener('click', (event) => {
    if (!event.target.closest('.remove-method')) return;
    const row = event.target.closest('.method-row');
    if (list.children.length === 1) { announce($('#methods-error'), 'Нужен хотя бы один QR.'); return; }
    sync(); methods.splice([...list.children].indexOf(row), 1); renderMethods();
  });
  $('#add-method').addEventListener('click', () => {
    sync(); if (methods.length >= 8) { announce($('#methods-error'), 'Можно добавить до 8 QR.'); return; }
    methods.push(emptyMethod()); renderMethods(); list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  const decodeUpload = (file, row) => {
    if (!file || file.size > 12 * 1024 * 1024) { announce($('.method-status', row), 'Фото слишком большое (максимум 12 МБ).', true); return; }
    if (!globalThis.jsQR) { announce($('.method-status', row), 'Декодер изображения пока недоступен.', true); return; }
    const reader = new FileReader();
    reader.onerror = () => announce($('.method-status', row), 'Не удалось прочитать изображение.', true);
    reader.onload = () => {
      const image = new Image(); image.onload = () => {
        const max = 1800, scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const result = globalThis.jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
        if (!result?.data) { announce($('.method-status', row), 'QR-код на фото не найден.', true); return; }
        $('.method-value', row).value = result.data; $('.method-value', row).dispatchEvent(new Event('input', { bubbles: true })); announce($('.method-status', row), 'QR найден');
      }; image.onerror = () => announce($('.method-status', row), 'Не удалось открыть изображение.', true); image.src = reader.result;
    }; reader.readAsDataURL(file);
  };
  list.addEventListener('click', (event) => {
    if (!event.target.closest('.upload-qr')) return;
    const row = event.target.closest('.method-row');
    const upload = document.createElement('input'); upload.type = 'file'; upload.accept = 'image/*'; upload.className = 'upload-qr-input'; upload.hidden = true;
    row.append(upload); upload.addEventListener('change', () => upload.files[0] && decodeUpload(upload.files[0], row)); upload.click();
  });
  $('#reset-form').addEventListener('click', () => { methods = [emptyMethod()]; form.reset(); renderMethods(); announce($('#methods-error'), ''); });
  $('#create-again').addEventListener('click', () => { hide($('#success-panel')); show(form); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('#copy-link').addEventListener('click', async () => copyText($('#published-url').textContent, $('#copy-link'), 'Скопировано'));
  $('#share-link').addEventListener('click', async () => { const url = $('#published-url').textContent; if (navigator.share) { try { await navigator.share({ title: 'QRbek — страница оплаты', url }); } catch {} } else await copyText(url, $('#share-link'), 'Ссылка скопирована'); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); sync(); const status = $('#form-status'); announce(status, '');
    const page = { v: 1, title: $('#page-title').value.trim(), note: $('#page-note').value.trim(), amount: $('#page-amount').value.trim().replace(',', '.'), currency: 'KGS', methods };
    try {
      const normalized = normalizePage(page);
      for (const method of normalized.methods) {
        const inspected = await inspectQr(method.value);
        if (bankById.has(inspected.bankId)) method.bankId = inspected.bankId;
        if (inspected.kind === 'sbp' && normalized.amount) throw new Error('Для СБП сумма задаётся в исходном банковском QR; оставьте сумму страницы пустой.');
        await paymentTarget(method.value, normalized.amount, '');
      }
      const encoded = encodePage(normalized); const path = `${designBase}/pay.html#p=${encoded}`; const url = `${location.origin}${path}`;
      $('#published-url').textContent = url; $('#open-link').href = path; show($('#success-panel')); hide(form); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) { announce(status, error.message || 'Проверьте данные и попробуйте снова.', true); }
  });
  renderMethods(); initCounts();
}

async function copyText(text, feedbackNode, feedback = 'Скопировано') {
  try { await navigator.clipboard.writeText(text); } catch { const area = document.createElement('textarea'); area.value = text; document.body.append(area); area.select(); document.execCommand('copy'); area.remove(); }
  if (feedbackNode) { const original = feedbackNode.textContent; feedbackNode.textContent = feedback; setTimeout(() => { feedbackNode.textContent = original; }, 1600); }
}

function initReceiver() {
  const pagePanel = $('#payment-page'); if (!pagePanel) return;
  let page;
  try { page = decodePage(location.hash); } catch (error) { show($('#invalid-state')); setText($('#invalid-message'), error.message || 'Ссылка неполная или данные повреждены.'); return; }
  show(pagePanel);
  setText($('#receiver-title'), page.title || 'Оплата по QR');
  if (page.note) { setText($('#receiver-note'), page.note); show($('#receiver-note')); }
  if (page.amount) { setText($('#receiver-amount'), formatAmount(page.amount)); show($('#amount-band')); }
  setText($('#method-count'), `${page.methods.length} QR`);
  const methodList = $('#receiver-methods'); const selected = { index: 0, inspected: null, target: null }; let inspectToken = 0;
  const handoff = $('#open-bank');
  let handoffToken = 0;
  const clearHandoff = () => {
    handoffToken += 1;
    handoff.removeAttribute('href');
    handoff.setAttribute('aria-disabled', 'true');
  };
  const prepareHandoff = async () => {
    clearHandoff();
    const token = handoffToken;
    const inspected = selected.inspected;
    const method = page.methods[selected.index];
    if (!inspected) return;
    const source = inspected.kind === 'sbp' ? '' : $('#from-bank').value;
    if (inspected.kind !== 'sbp' && !source) return;
    try {
      const target = inspected.kind === 'sbp' ? selected.target : await paymentTarget(method.value, page.amount, source);
      if (token !== handoffToken || !target?.url) return;
      handoff.href = target.url;
      handoff.setAttribute('aria-disabled', 'false');
      hide($('#receiver-error'));
    } catch (error) {
      if (token === handoffToken) announce($('#receiver-error'), error.message, true);
    }
  };
  const populateFromBanks = () => {
    const select = $('#from-bank'); const logos = $('#source-bank-logos');
    if (!select.options.length) select.innerHTML = '<option value="">Выберите банк</option>' + bankOptions(true);
    if (logos.childElementCount) return;
    (BANKS || []).filter((bank) => bank.allowAsSource !== false).forEach((bank) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'source-bank-logo'; button.dataset.bankId = bank.id; button.setAttribute('aria-pressed', 'false'); button.innerHTML = `<img src="${escapeHtml(bank.icon)}" alt="" width="32" height="32"><span>${escapeHtml(bank.name)}</span>`;
      button.addEventListener('click', () => { select.value = bank.id; select.dispatchEvent(new Event('change')); });
      logos.append(button);
    });
  };
  page.methods.forEach((method, index) => {
    const bank = bankById.get(method.bankId);
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'receiver-method';
    row.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
    row.innerHTML = `<span class="receiver-method-bank">${bank ? `<img src="${escapeHtml(bank.icon)}" alt="" width="32" height="32">` : 'QR'}</span><span class="receiver-method-info"><strong>${escapeHtml(method.label || `QR ${index + 1}`)}</strong><small>${escapeHtml(bank?.name || 'QR получателя')}</small></span><span class="method-radio" aria-hidden="true"></span>`;
    row.addEventListener('click', () => {
      selected.index = index;
      $$('.receiver-method', methodList).forEach((other, i) => other.setAttribute('aria-pressed', i === index ? 'true' : 'false'));
      renderSelected();
    });
    methodList.append(row);
  });
  const renderSelected = async () => {
    const method = page.methods[selected.index]; const token = ++inspectToken; const canvas = $('#payment-qr'); const placeholder = $('#qr-placeholder'); const bankName = $('#selected-bank-name'); const picker = $('#bank-picker'); const receiverError = $('#receiver-error');
    hide(receiverError); hide($('#payment-notice')); selected.inspected = null; selected.target = null;
    clearHandoff(); hide(canvas);
    setText($('#amount-label'), 'Запрошено');
    setText($('#receiver-amount'), formatAmount(page.amount));
    $('#amount-band').hidden = !page.amount;
    setText(bankName, bankById.get(method.bankId)?.name || ''); hide(picker); hide($('#download-qr')); show(placeholder); setText(placeholder, 'Готовим QR…');
    try {
      const inspected = await inspectQr(method.value);
      if (inspected.kind === 'sbp' && page.amount) throw new Error('Для СБП сумма задаётся в исходном банковском QR; сумма страницы должна быть пустой.');
      const target = await paymentTarget(method.value, page.amount || '', '');
      if (token !== inspectToken) return;
      selected.inspected = inspected; selected.target = target;
      const displayedAmount = page.amount || target.amount;
      setText($('#amount-label'), inspected.kind === 'elqr' ? 'К оплате' : 'Запрошено');
      setText($('#receiver-amount'), formatAmount(displayedAmount));
      $('#amount-band').hidden = !displayedAmount;
      await drawQr(canvas, target.qrText); if (token !== inspectToken) return;
      hide(placeholder); show(canvas); show($('#download-qr')); show(picker);
      picker.classList.toggle('direct', inspected.kind === 'sbp'); $('#open-bank').textContent = inspected.kind === 'sbp' ? 'Открыть ссылку ↗' : 'Открыть банк ↗';
      if (inspected.kind === 'sbp') hide($('#source-bank-logos')); else { show($('#source-bank-logos')); populateFromBanks(); }
      if (target.notice) { setText($('#payment-notice'), target.notice); show($('#payment-notice')); }
      prepareHandoff();
    } catch (error) { if (token !== inspectToken) return; hide(canvas); setText(placeholder, 'Этот QR нельзя показать безопасно.'); announce(receiverError, error.message || 'Реквизит не распознан.', true); }
  };
  $('#from-bank').addEventListener('change', () => {
    $$('.source-bank-logo').forEach((item) => { const active = item.dataset.bankId === $('#from-bank').value; item.classList.toggle('is-selected', active); item.setAttribute('aria-pressed', String(active)); });
    prepareHandoff();
  });
  $('#download-qr').addEventListener('click', () => { const canvas = $('#payment-qr'); if (!canvas?.toDataURL) return; const anchor = document.createElement('a'); anchor.download = 'qrbek-payment.png'; anchor.href = canvas.toDataURL('image/png'); anchor.click(); });
  handoff.addEventListener('click', (event) => {
    if (handoff.hasAttribute('href')) return;
    event.preventDefault();
    announce($('#receiver-error'), 'Выберите банк отправителя и дождитесь подготовки ссылки.', true);
  });
  renderSelected();
}

if (pageKind === 'builder') initBuilder();
if (pageKind === 'receiver') initReceiver();
window.addEventListener('hashchange', () => location.reload());
