import {
  BANKS,
  decodePage,
  inspectQr,
  normalizePage,
  paymentTarget,
} from "./payment.js?v=20260922-amount2";
import { formatExpiry, watchPageExpiry } from "./page-expiry.js";
import {
  clearReceiverBankLinks,
  prepareReceiverBankLinks,
} from "./receiver-bank.js";

const $ = (selector, root = document) => root.querySelector(selector);
const bankById = new Map((BANKS || []).map((bank) => [bank.id, bank]));
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
const show = (node) => { if (node) node.hidden = false; };
const hide = (node) => { if (node) node.hidden = true; };
const setText = (node, text) => { if (node) node.textContent = text; };
const formatAmount = (value) =>
  String(value || "").replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const announce = (node, text, isError = false) => {
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("is-error", isError);
  node.hidden = !text;
};

async function requestPage(path) {
  let response;
  let data;
  try {
    response = await fetch(path, {
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    data = await response.json();
  } catch {
    throw new Error("Сервер недоступен. Проверьте соединение и попробуйте снова.");
  }
  if (!response.ok) {
    const error = new Error(data.message || "Не удалось обработать ссылку.");
    error.code = data.error;
    throw error;
  }
  return data;
}

async function drawQr(canvas, value, size = 480) {
  if (!canvas || !value || !globalThis.QRCode?.toCanvas) {
    throw new Error("QR-код сейчас недоступен.");
  }
  canvas.width = size;
  canvas.height = size;
  const result = globalThis.QRCode.toCanvas(canvas, value, {
    width: size,
    margin: 4,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  });
  if (result?.then) await result;
}

const clearDownload = (download) => {
  if (!download) return;
  download.removeAttribute("href");
  download.removeAttribute("download");
  download.disabled = true;
  download.setAttribute("aria-disabled", "true");
};

const clearCanvas = (canvas) => {
  const context = canvas?.getContext?.("2d");
  if (context) context.clearRect(0, 0, canvas.width, canvas.height);
};

const isPositive = (value) =>
  Boolean(value && !/^0(?:\.0*)?$/.test(String(value)));

async function loadPage() {
  const shortLink = location.pathname.match(
    /^\/p\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])$/,
  );
  if (shortLink) {
    const key = new URLSearchParams(location.search).get("key");
    const suffix = key ? `?key=${encodeURIComponent(key)}` : "";
    const stored = await requestPage(`/api/pages/${shortLink[1]}${suffix}`);
    const { expiresAt, ...pageData } = stored;
    return { page: normalizePage(pageData), expiresAt };
  }
  return { page: decodePage(location.hash), expiresAt: "" };
}

async function initReceiver() {
  const pagePanel = $("#payment-page");
  if (!pagePanel) return;
  let loaded;
  try {
    loaded = await loadPage();
  } catch (error) {
    show($("#invalid-state"));
    setText($("#invalid-message"), error.message || "Ссылка неполная или данные повреждены.");
    hide($("#page-loading"));
    return;
  }
  hide($("#page-loading"));
  const { page, expiresAt } = loaded;
  show(pagePanel);
  const title = $("#receiver-title");
  if (page.title) {
    setText(title, page.title);
    show(title);
  } else hide(title);
  if (expiresAt) {
    setText($("#receiver-expiry"), formatExpiry(expiresAt));
    show($("#receiver-expiry"));
  }

  const methodList = $("#receiver-methods");
  const recipient = $("#receiver-recipient");
  const bankLinks = $("#source-bank-logos");
  const amountEntry = $("#amount-entry");
  const amountInput = $("#payment-amount");
  const amountError = $("#amount-error");
  const canvas = $("#payment-qr");
  const placeholder = $("#qr-placeholder");
  const picker = $("#bank-picker");
  const receiverError = $("#receiver-error");
  const download = $("#download-qr");
  let selectedIndex = 0;
  let generation = 0;

  const expired = expiresAt
    ? watchPageExpiry(expiresAt, () => {
      generation += 1;
      clearReceiverBankLinks(bankLinks);
      clearDownload(download);
      hide(pagePanel);
      pagePanel.replaceChildren();
      show($("#invalid-state"));
      setText($("#invalid-message"), "Срок ссылки истёк. Попросите новую ссылку.");
    })
    : () => false;
  if (expired()) return;

  const updateRecipient = (method, inspected) => {
    if (!inspected) return;
    const bank = inspected.kind === "sbp"
      ? { id: "sbp", name: "СБП", icon: "/assets/mark.png" }
      : bankById.get(inspected.bankId || method.bankId);
    const icon = $("#receiver-recipient-icon");
    if (bank?.icon && icon) {
      icon.src = bank.icon;
      icon.alt = "";
      show(icon);
    } else hide(icon);
    setText($("#receiver-recipient-bank"), bank?.name || "QR получателя");
    show(recipient);
  };

  const renderMethodPicker = () => {
    if (!methodList) return;
    methodList.replaceChildren();
    if (page.methods.length === 1) {
      hide(methodList);
      return;
    }
    show(methodList);
    page.methods.forEach((method, index) => {
      const bank = bankById.get(method.bankId);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "receiver-method";
      row.setAttribute("aria-pressed", index === selectedIndex ? "true" : "false");
      const icon = bank?.icon || "/assets/mark.png";
      const label = escapeHtml(method.label || `QR ${index + 1}`);
      const bankName = escapeHtml(bank?.name || "QR получателя");
      row.innerHTML = `<span class="receiver-method-bank"><img src="${escapeHtml(icon)}" alt="" width="32" height="32"></span><span class="receiver-method-info"><strong>${label}</strong><small>${bankName}</small></span><span class="method-radio" aria-hidden="true"></span>`;
      row.addEventListener("click", () => {
        if (selectedIndex === index) return;
        selectedIndex = index;
        methodList.querySelectorAll(".receiver-method").forEach((other, otherIndex) =>
          other.setAttribute("aria-pressed", otherIndex === index ? "true" : "false")
        );
        if (amountInput) amountInput.value = "";
        renderSelected();
      });
      methodList.append(row);
    });
  };

  const setAmountMode = (inspected) => {
    const editable = !page.amount && inspected?.kind === "elqr" && inspected.mutableAmount &&
      !isPositive(inspected.amount);
    if (editable) show(amountEntry);
    else hide(amountEntry);
    if (!editable && amountInput) amountInput.value = "";
    return editable;
  };

  const renderSelected = async () => {
    const method = page.methods[selectedIndex];
    const token = ++generation;
    clearReceiverBankLinks(bankLinks);
    clearDownload(download);
    clearCanvas(canvas);
    hide(canvas);
    hide(picker);
    hide($("#amount-band"));
    hide($("#payment-notice"));
    hide(receiverError);
    hide(amountError);
    if (amountInput) amountInput.removeAttribute("aria-invalid");
    show(placeholder);
    setText(placeholder, "Готовим QR…");
    hide(recipient);
    let inspected;
    try {
      inspected = await inspectQr(method.value);
      if (expired() || token !== generation) return;
      updateRecipient(method, inspected);
      const editable = setAmountMode(inspected);
      const entered = editable ? amountInput?.value.trim().replace(",", ".") || "" : "";
      const requested = page.amount || entered;
      if (inspected.kind === "sbp" && page.amount) {
        throw new Error("Для СБП сумма задаётся в исходном банковском QR; сумма страницы должна быть пустой.");
      }
      const target = await paymentTarget(method.value, requested, "");
      if (expired() || token !== generation) return;
      const displayedAmount = page.amount || target.amount || "";
      setText($("#receiver-amount"), formatAmount(displayedAmount));
      $("#amount-band").hidden = editable || !isPositive(displayedAmount);
      announce(amountError, "");
      const bankLinksReady = prepareReceiverBankLinks({
        container: bankLinks,
        banks: BANKS,
        inspected,
        directTarget: target,
        getTarget: (sourceBankId) => paymentTarget(method.value, requested, sourceBankId),
        isCurrent: () => !expired() && token === generation,
        onError: (message) => announce(receiverError, message, true),
      });
      const renderedCanvas = document.createElement("canvas");
      await drawQr(renderedCanvas, target.qrText);
      await bankLinksReady;
      if (expired() || token !== generation) return;
      canvas.width = renderedCanvas.width;
      canvas.height = renderedCanvas.height;
      canvas.getContext("2d").drawImage(renderedCanvas, 0, 0);
      hide(placeholder);
      show(canvas);
      if (download) {
        download.disabled = false;
        download.removeAttribute("aria-disabled");
      }
      show(picker);
      picker?.classList.toggle("direct", inspected.kind === "sbp");
      if (target.notice) announce($("#payment-notice"), target.notice);
    } catch (error) {
      if (token !== generation) return;
      clearReceiverBankLinks(bankLinks);
      clearDownload(download);
      hide(canvas);
      if (amountInput && setAmountMode(inspected)) {
        announce(amountError, error.message || "Введите положительную сумму.", true);
        amountInput.setAttribute("aria-invalid", "true");
        setText(placeholder, "Исправьте сумму, чтобы показать QR.");
      } else {
        setText(placeholder, "Этот QR нельзя показать безопасно.");
        announce(receiverError, error.message || "Реквизит не распознан.", true);
      }
    }
  };

  amountInput?.addEventListener("input", renderSelected);
  amountInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      amountInput.blur();
    }
  });
  download?.addEventListener("click", () => {
    if (expired() || download.disabled || !canvas?.toDataURL) return;
    const anchor = document.createElement("a");
    anchor.download = "qrbek-payment.png";
    anchor.href = canvas.toDataURL("image/png");
    anchor.click();
  });
  renderMethodPicker();
  renderSelected();
}

initReceiver();
window.addEventListener("hashchange", () => location.reload());
