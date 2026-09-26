import {
  BANKS,
  decodePage,
  inspectQr,
  normalizePage,
  paymentTarget,
} from "./payment.js?v=20260922-amount2";
import { formatExpiry, watchPageExpiry } from "./page-expiry.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const pageKind = document.body?.classList.contains("builder-page")
  ? "builder"
  : document.body?.classList.contains("receiver-page")
  ? "receiver"
  : "home";
const bankById = new Map((BANKS || []).map((bank) => [bank.id, bank]));
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
const fragmentDraft = () => {
  const match = location.hash.match(/^#draft=(.+)$/);
  if (!match) return null;
  try {
    return decodePage(`#p=${decodeURIComponent(match[1])}`);
  } catch {
    return null;
  }
};
const show = (node) => {
  if (node) node.hidden = false;
};
const hide = (node) => {
  if (node) node.hidden = true;
};
const setText = (node, text) => {
  if (node) node.textContent = text;
};
const formatAmount = (value) =>
  String(value || "").replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const announce = (node, text, isError = false) => {
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("is-error", isError);
  node.hidden = !text;
};

async function drawQr(canvas, value, size = 320) {
  if (!canvas || !value || !globalThis.QRCode?.toCanvas) {
    throw new Error("QR-код сейчас недоступен.");
  }
  canvas.width = size;
  canvas.height = size;
  const result = QRCode.toCanvas(canvas, value, {
    width: size,
    margin: 4,
    errorCorrectionLevel: "M",
    color: { dark: "#0c1711", light: "#ffffff" },
  });
  if (result?.then) await result;
}

const emptyMethod = () => ({ kind: "qr", label: "", value: "", bankId: "" });
const methodTemplate = (method, index) =>
  `<article class="method-row" data-bank-id="${escapeHtml(method.bankId)}">
  <div class="method-row-head"><div class="method-row-title"><img class="bank-preview" alt="" width="24" height="24" hidden><span class="method-number">QR ${
    index + 1
  }</span><span class="method-bank-name"></span></div><button class="remove-method" type="button" aria-label="Удалить QR ${
    index + 1
  }">×</button></div>
  <button class="upload-qr" type="button"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z"/></svg><span class="upload-qr-copy"><span>Выбрать фото QR</span><small>Или перетащите одно фото сюда</small></span></button>
  <label class="field method-value-field"><span>Или ссылка / текст QR</span><textarea class="method-value" rows="2" maxlength="3000" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="qr-status-${index}" placeholder="https://…">${
    escapeHtml(method.value)
  }</textarea></label>
  <p id="qr-status-${index}" class="method-status" role="status" aria-live="polite"></p>
  <details class="method-options" ${
    method.label ? "open" : ""
  }><summary>Название QR</summary><label class="field"><span class="sr-only">Название QR ${
    index + 1
  }</span><input class="method-label" type="text" maxlength="80" value="${
    escapeHtml(method.label)
  }" placeholder="Например, личный"></label></details>
</article>`;

async function requestPage(path, options = {}) {
  let response, data;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    data = await response.json();
  } catch {
    throw new Error(
      "Сервер недоступен. Проверьте соединение и попробуйте снова.",
    );
  }
  if (!response.ok) {
    const error = new Error(data.message || "Не удалось обработать ссылку.");
    error.code = data.error;
    throw error;
  }
  return data;
}

function initBuilder() {
  const form = $("#payment-form");
  if (!form) return;
  const list = $("#methods-list");
  let methods = [];
  const slugInput = $("#page-slug");
  const updateSlugPreview = () => {
    const slug = slugInput.value.trim().toLowerCase();
    setText(
      $("#slug-preview"),
      slug
        ? `${location.host}/p/${slug} · с уникальным кодом ссылки`
        : "Оставьте пустым для случайного адреса.",
    );
    slugInput.removeAttribute("aria-invalid");
  };
  slugInput.addEventListener("input", updateSlugPreview);
  updateSlugPreview();
  const draft = fragmentDraft();
  if (draft?.methods?.length) methods = draft.methods.slice(0, 8);
  else methods = [emptyMethod()];
  if (draft) {
    $("#page-title").value = draft.title;
    $("#page-note").value = draft.note;
    $("#page-amount").value = draft.amount;
    if (draft.note) $(".comment-toggle").open = true;
  }
  $(".metadata-details").open = matchMedia("(min-width: 960px)").matches ||
    Boolean(draft?.title || draft?.amount || draft?.note);
  const renderMethods = () => {
    announce($("#methods-error"), "");
    list.innerHTML = methods.map(methodTemplate).join("");
    methods.forEach((method, index) => {
      const row = list.children[index];
      if (method.value) validateMethod(row, method.value, false);
      updateBankLogo(row);
    });
  };
  const collectMethods = () =>
    [...list.children].map((row) => ({
      kind: "qr",
      label: $(".method-label", row)?.value.trim() || "",
      value: $(".method-value", row)?.value.trim() || "",
      bankId: row.dataset.bankId || "",
    }));
  const sync = () => {
    methods = collectMethods();
  };
  const validateMethod = async (row, value, announceResult = true) => {
    row.dataset.bankId = "";
    updateBankLogo(row);
    $(".method-value", row).removeAttribute("aria-invalid");
    if (!value) {
      announce($(".method-status", row), "");
      return;
    }
    const status = $(".method-status", row);
    const currentValue = value;
    announce(status, "Проверяем QR…");
    try {
      const inspected = await inspectQr(value);
      if ($(".method-value", row)?.value.trim() !== currentValue) return;
      if (inspected?.bankId && bankById.has(inspected.bankId)) {
        row.dataset.bankId = inspected.bankId;
        updateBankLogo(row);
      }
      status.textContent = inspected.name ||
        bankById.get(inspected.bankId)?.name || "QR распознан";
      status.classList.remove("is-error");
    } catch (error) {
      if ($(".method-value", row)?.value.trim() !== currentValue) return;
      status.textContent = announceResult
        ? (error.message || "Не удалось распознать QR")
        : "";
      status.classList.toggle("is-error", announceResult);
      $(".method-value", row).setAttribute(
        "aria-invalid",
        String(announceResult),
      );
    }
  };
  const updateBankLogo = (row) => {
    const id = row.dataset.bankId;
    const image = $(".bank-preview", row);
    const bank = bankById.get(id);
    setText($(".method-bank-name", row), bank?.name || "");
    if (!bank) {
      hide(image);
      return;
    }
    image.src = bank.icon || `/assets/banks/${bank.id}.png`;
    show(image);
  };
  list.addEventListener("input", (event) => {
    const row = event.target.closest(".method-row");
    if (!row) return;
    if (event.target.classList.contains("method-value")) {
      row._inputGeneration = (row._inputGeneration || 0) + 1;
      row._pendingUpload = null;
      window.clearTimeout(row._inspectTimer),
        row._inspectTimer = window.setTimeout(
          () => validateMethod(row, event.target.value.trim()),
          320,
        );
    }
  });
  list.addEventListener("click", (event) => {
    if (!event.target.closest(".remove-method")) return;
    const row = event.target.closest(".method-row");
    if (list.children.length === 1) {
      announce($("#methods-error"), "Нужен хотя бы один QR.");
      return;
    }
    sync();
    methods.splice([...list.children].indexOf(row), 1);
    renderMethods();
  });
  $("#add-method").addEventListener("click", () => {
    sync();
    if (methods.length >= 8) {
      announce($("#methods-error"), "Можно добавить до 8 QR.");
      return;
    }
    methods.push(emptyMethod());
    renderMethods();
    $(".upload-qr", list.lastElementChild)?.focus();
  });
  const isBuilderBusy = () => form.getAttribute("aria-busy") === "true";
  const decodeUpload = (file, row) => {
    const generation = (row._inputGeneration || 0) + 1;
    row._inputGeneration = generation;
    row._pendingUpload = null;
    const isCurrent = () =>
      row.isConnected && row._inputGeneration === generation;
    const status = $(".method-status", row);
    const mime = String(file?.type || "");
    if (!file) {
      announce(status, "Перетащите одно фото QR.", true);
      return;
    }
    if (mime && !/^image\//i.test(mime)) {
      announce(status, "Выберите изображение QR-кода.", true);
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      announce(status, "Фото слишком большое (максимум 12 МБ).", true);
      return;
    }
    if (!globalThis.jsQR) {
      announce(status, "Декодер изображения пока недоступен.", true);
      return;
    }
    row._pendingUpload = generation;
    announce(status, "Распознаём QR…");
    const reader = new FileReader();
    reader.onerror = () => {
      if (!isCurrent()) return;
      row._pendingUpload = null;
      announce(status, "Не удалось прочитать изображение.", true);
    };
    reader.onload = () => {
      if (!isCurrent()) return;
      const image = new Image();
      image.onload = () => {
        if (!isCurrent()) return;
        row._pendingUpload = null;
        const max = 1800,
          scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const result = globalThis.jsQR(
          context.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width,
          canvas.height,
          { inversionAttempts: "attemptBoth" },
        );
        if (!result?.data) {
          if (isCurrent()) announce(status, "QR-код на фото не найден.", true);
          return;
        }
        if (!isCurrent()) return;
        $(".method-value", row).value = result.data;
        announce(status, "QR найден");
        $(".method-value", row).dispatchEvent(
          new Event("input", { bubbles: true }),
        );
      };
      image.onerror = () => {
        if (!isCurrent()) return;
        row._pendingUpload = null;
        announce(status, "Не удалось открыть изображение.", true);
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  const rowFromEvent = (event) =>
    event.target instanceof Element
      ? event.target.closest(".method-row")
      : null;
  const isFileOnlyDrag = (event) => {
    const transfer = event.dataTransfer;
    if (!transfer) return false;
    return [...transfer.types].includes("Files") || transfer.files.length > 0;
  };
  const clearDropHighlight = () => {
    $$(".method-row", list).forEach((row) => {
      row._dragDepth = 0;
      row.classList.remove("is-drop-target");
    });
  };
  list.addEventListener("dragenter", (event) => {
    if (!isFileOnlyDrag(event)) return;
    event.preventDefault();
    const row = rowFromEvent(event);
    if (!row) return;
    row._dragDepth = (row._dragDepth || 0) + 1;
    row.classList.add("is-drop-target");
  });
  list.addEventListener("dragover", (event) => {
    if (!isFileOnlyDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = isBuilderBusy() ? "none" : "copy";
    const row = rowFromEvent(event);
    if (!row) return;
    if (!row.classList.contains("is-drop-target")) row._dragDepth = 1;
    row.classList.add("is-drop-target");
  });
  list.addEventListener("dragleave", (event) => {
    const row = rowFromEvent(event);
    if (!row) return;
    row._dragDepth = Math.max(0, (row._dragDepth || 1) - 1);
    if (!row._dragDepth) row.classList.remove("is-drop-target");
  });
  list.addEventListener("drop", (event) => {
    if (!isFileOnlyDrag(event)) {
      clearDropHighlight();
      return;
    }
    event.preventDefault();
    event._qrbekFileDropHandled = true;
    const row = rowFromEvent(event);
    clearDropHighlight();
    if (isBuilderBusy()) return;
    if (!row) {
      announce(
        $("#methods-error"),
        "Перетащите одно изображение на нужную карточку QR.",
        true,
      );
      return;
    }
    announce($("#methods-error"), "");
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length !== 1) {
      row._inputGeneration = (row._inputGeneration || 0) + 1;
      row._pendingUpload = null;
      announce(
        $(".method-status", row),
        files.length > 1
          ? "Перетащите только одно изображение QR."
          : "Не удалось получить изображение. Перетащите одно фото QR.",
        true,
      );
      return;
    }
    decodeUpload(files[0], row);
  });
  window.addEventListener("dragover", (event) => {
    if (isFileOnlyDrag(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (!isFileOnlyDrag(event)) {
      clearDropHighlight();
      return;
    }
    event.preventDefault();
    clearDropHighlight();
    if (isBuilderBusy()) return;
    if (!event._qrbekFileDropHandled) {
      announce(
        $("#methods-error"),
        "Перетащите одно изображение на нужную карточку QR.",
        true,
      );
    }
  });
  window.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) clearDropHighlight();
  });
  window.addEventListener("dragend", clearDropHighlight);
  window.addEventListener("blur", clearDropHighlight);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") clearDropHighlight();
  });
  list.addEventListener("click", (event) => {
    if (!event.target.closest(".upload-qr")) return;
    const row = event.target.closest(".method-row");
    const upload = document.createElement("input");
    upload.type = "file";
    upload.accept = "image/*";
    upload.className = "upload-qr-input";
    upload.hidden = true;
    row.append(upload);
    upload.addEventListener(
      "change",
      () => upload.files[0] && decodeUpload(upload.files[0], row),
    );
    upload.click();
  });
  $("#reset-form").addEventListener("click", () => {
    methods = [emptyMethod()];
    form.reset();
    updateSlugPreview();
    $(".comment-toggle").open = false;
    renderMethods();
    announce($("#methods-error"), "");
    announce($("#form-status"), "");
  });
  $("#create-again").addEventListener("click", () => {
    hide($("#success-panel"));
    show(form);
    slugInput.value = "";
    updateSlugPreview();
    $(".upload-qr", list)?.focus();
  });
  $("#copy-link").addEventListener(
    "click",
    async () =>
      copyText($("#published-url").textContent, $("#copy-link"), "Скопировано"),
  );
  $("#share-link").addEventListener("click", async () => {
    const url = $("#published-url").textContent;
    if (navigator.share) {
      try {
        await navigator.share({ title: "QRbek — страница оплаты", url });
      } catch {}
    } else await copyText(url, $("#share-link"), "Ссылка скопирована");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isBuilderBusy()) return;
    if ($$(".method-row", list).some((row) => row._pendingUpload != null)) {
      announce($("#form-status"), "Дождитесь распознавания фото.", true);
      return;
    }
    sync();
    const status = $("#form-status");
    announce(status, "");
    const submit = $('button[type="submit"]', form);
    const enabledControls = [...form.elements].filter((control) =>
      !control.disabled
    );
    enabledControls.forEach((control) => control.disabled = true);
    submit.textContent = "Создаём…";
    form.setAttribute("aria-busy", "true");
    const page = {
      v: 1,
      title: $("#page-title").value.trim(),
      note: $("#page-note").value.trim(),
      amount: $("#page-amount").value.trim().replace(",", "."),
      currency: "KGS",
      methods,
    };
    try {
      const slug = slugInput.value.trim().toLowerCase();
      if (slug && !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) {
        slugInput.setAttribute("aria-invalid", "true");
        throw new Error(
          "Адрес: от 3 до 32 латинских букв, цифр или дефисов. Дефис не может быть первым или последним.",
        );
      }
      const normalized = normalizePage(page);
      for (const method of normalized.methods) {
        const inspected = await inspectQr(method.value);
        if (bankById.has(inspected.bankId)) method.bankId = inspected.bankId;
        if (inspected.kind === "sbp" && normalized.amount) {
          throw new Error(
            "Для СБП сумма задаётся в исходном банковском QR; оставьте сумму страницы пустой.",
          );
        }
        await paymentTarget(method.value, normalized.amount, "");
      }
      const created = await requestPage("/api/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page: normalized,
          expiresInDays: Number($("#page-lifetime").value),
          ...(slug ? { slug } : {}),
        }),
      });
      if (
        typeof created.id !== "string" ||
        !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(created.id) ||
        (created.path !== `/p/${created.id}` &&
          !new RegExp(`^/p/${created.id}\\?key=[a-f0-9]{32}$`).test(created.path))
      ) {
        throw new Error("Сервер вернул некорректный адрес страницы.");
      }
      const path = created.path;
      const url = `${location.origin}${path}`;
      setText($("#success-title"), normalized.title || "Оплата по QR");
      setText(
        $("#success-summary"),
        `${normalized.methods.length} QR${
          normalized.amount ? ` · ${formatAmount(normalized.amount)} сом` : ""
        }`,
      );
      setText($("#success-expiry"), formatExpiry(created.expiresAt));
      $("#published-url").textContent = url;
      $("#open-link").href = path;
      show($("#success-panel"));
      hide(form);
      $("#success-heading").focus();
    } catch (error) {
      if (error.code === "slug_taken") {
        slugInput.setAttribute("aria-invalid", "true");
      }
      announce(
        status,
        error.message || "Проверьте данные и попробуйте снова.",
        true,
      );
    } finally {
      enabledControls.forEach((control) => control.disabled = false);
      submit.textContent = "Создать ссылку";
      form.removeAttribute("aria-busy");
      if (slugInput.hasAttribute("aria-invalid")) slugInput.focus();
    }
  });
  renderMethods();
}

const copyFeedback = new WeakMap();

async function copyText(text, feedbackNode, feedback = "Скопировано") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  if (feedbackNode) {
    const previous = copyFeedback.get(feedbackNode);
    const original = previous?.original ?? feedbackNode.textContent;
    if (previous) clearTimeout(previous.timer);
    feedbackNode.textContent = feedback;
    const timer = setTimeout(() => {
      feedbackNode.textContent = original;
      copyFeedback.delete(feedbackNode);
    }, 1600);
    copyFeedback.set(feedbackNode, { original, timer });
  }
}

async function initReceiver() {
  const pagePanel = $("#payment-page");
  if (!pagePanel) return;
  let page;
  let expiresAt;
  try {
    const shortLink = location.pathname.match(
      /^\/p\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])$/,
    );
    if (shortLink) {
      const key = new URLSearchParams(location.search).get("key");
      const stored = await requestPage(
        `/api/pages/${shortLink[1]}${key ? `?key=${encodeURIComponent(key)}` : ""}`,
      );
      expiresAt = stored.expiresAt;
      setText($("#receiver-expiry"), formatExpiry(expiresAt));
      show($("#receiver-expiry"));
      const { expiresAt: _expiry, ...pageData } = stored;
      page = normalizePage(pageData);
    } else {
      page = decodePage(location.hash);
    }
  } catch (error) {
    show($("#invalid-state"));
    setText(
      $("#invalid-message"),
      error.message || "Ссылка неполная или данные повреждены.",
    );
    return;
  } finally {
    hide($("#page-loading"));
  }
  show(pagePanel);
  $("#qr-details").open = matchMedia("(min-width: 960px)").matches;
  setText($("#receiver-title"), page.title || "Оплата по QR");
  if (page.note) {
    setText($("#receiver-note"), page.note);
    show($("#receiver-note"));
  }
  if (page.amount) {
    setText($("#receiver-amount"), formatAmount(page.amount));
    show($("#amount-band"));
  }
  setText($("#method-count"), `${page.methods.length} QR`);
  const methodList = $("#receiver-methods");
  const selected = { index: 0, inspected: null, target: null };
  let inspectToken = 0;
  let sourceBankId = "";
  const handoff = $("#open-bank");
  let handoffToken = 0;
  const clearHandoff = () => {
    handoffToken += 1;
    handoff.removeAttribute("href");
    handoff.setAttribute("aria-disabled", "true");
  };
  const expired = expiresAt
    ? watchPageExpiry(expiresAt, () => {
      inspectToken += 1;
      clearHandoff();
      hide(pagePanel);
      pagePanel.replaceChildren();
      show($("#invalid-state"));
      setText($("#invalid-message"), "Срок ссылки истёк. Попросите новую ссылку.");
    })
    : () => false;
  if (expired()) return;
  const prepareHandoff = async () => {
    if (expired()) return;
    clearHandoff();
    const token = handoffToken;
    const inspected = selected.inspected;
    const method = page.methods[selected.index];
    if (!inspected) return;
    const source = inspected.kind === "sbp" ? "" : sourceBankId;
    if (inspected.kind !== "sbp" && !source) return;
    try {
      const target = inspected.kind === "sbp"
        ? selected.target
        : await paymentTarget(method.value, page.amount, source);
      if (expired() || token !== handoffToken || !target?.url) return;
      handoff.href = target.url;
      handoff.setAttribute("aria-disabled", "false");
      handoff.textContent = inspected.kind === "sbp"
        ? "Открыть ссылку ↗"
        : `Открыть ${bankById.get(source)?.name || "банк"} ↗`;
      hide($("#receiver-error"));
    } catch (error) {
      if (token === handoffToken) {
        announce($("#receiver-error"), error.message, true);
      }
    }
  };
  const populateFromBanks = () => {
    const logos = $("#source-bank-logos");
    if (logos.childElementCount) return;
    (BANKS || []).filter((bank) => bank.allowAsSource !== false).forEach(
      (bank) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "source-bank-logo";
        button.dataset.bankId = bank.id;
        button.setAttribute("aria-pressed", "false");
        button.innerHTML = `<img src="${
          escapeHtml(bank.icon)
        }" alt="" width="32" height="32"><span>${escapeHtml(bank.name)}</span>`;
        button.addEventListener("click", () => {
          sourceBankId = bank.id;
          $$(".source-bank-logo", logos).forEach((item) =>
            item.setAttribute(
              "aria-pressed",
              String(item.dataset.bankId === sourceBankId),
            )
          );
          prepareHandoff();
        });
        logos.append(button);
      },
    );
  };
  page.methods.forEach((method, index) => {
    const bank = bankById.get(method.bankId);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "receiver-method";
    row.setAttribute("aria-pressed", index === 0 ? "true" : "false");
    row.innerHTML = `<span class="receiver-method-bank">${
      bank
        ? `<img src="${escapeHtml(bank.icon)}" alt="" width="32" height="32">`
        : "QR"
    }</span><span class="receiver-method-info"><strong>${
      escapeHtml(method.label || `QR ${index + 1}`)
    }</strong><small>${
      escapeHtml(bank?.name || "QR получателя")
    }</small></span><span class="method-radio" aria-hidden="true"></span>`;
    row.addEventListener("click", () => {
      selected.index = index;
      $$(".receiver-method", methodList).forEach((other, i) =>
        other.setAttribute("aria-pressed", i === index ? "true" : "false")
      );
      renderSelected();
    });
    methodList.append(row);
  });
  const renderSelected = async () => {
    const method = page.methods[selected.index];
    const token = ++inspectToken;
    const canvas = $("#payment-qr");
    const placeholder = $("#qr-placeholder");
    const bankName = $("#selected-bank-name");
    const picker = $("#bank-picker");
    const receiverError = $("#receiver-error");
    hide(receiverError);
    hide($("#payment-notice"));
    selected.inspected = null;
    selected.target = null;
    clearHandoff();
    hide(canvas);
    setText($("#amount-label"), "Запрошено");
    setText($("#receiver-amount"), formatAmount(page.amount));
    $("#amount-band").hidden = !page.amount;
    setText(bankName, bankById.get(method.bankId)?.name || "");
    hide(picker);
    hide($("#download-qr"));
    show(placeholder);
    setText(placeholder, "Готовим QR…");
    try {
      const inspected = await inspectQr(method.value);
      if (inspected.kind === "sbp" && page.amount) {
        throw new Error(
          "Для СБП сумма задаётся в исходном банковском QR; сумма страницы должна быть пустой.",
        );
      }
      const target = await paymentTarget(method.value, page.amount || "", "");
      if (expired() || token !== inspectToken) return;
      selected.inspected = inspected;
      selected.target = target;
      const displayedAmount = page.amount || target.amount;
      setText(
        $("#amount-label"),
        inspected.kind === "elqr" ? "К оплате" : "Запрошено",
      );
      setText($("#receiver-amount"), formatAmount(displayedAmount));
      $("#amount-band").hidden = !displayedAmount;
      await drawQr(canvas, target.qrText);
      if (expired() || token !== inspectToken) return;
      hide(placeholder);
      show(canvas);
      show($("#download-qr"));
      show(picker);
      picker.classList.toggle("direct", inspected.kind === "sbp");
      handoff.textContent = inspected.kind === "sbp"
        ? "Открыть ссылку ↗"
        : "Выберите банк";
      if (inspected.kind === "sbp") hide($("#source-bank-logos"));
      else {
        show($("#source-bank-logos"));
        populateFromBanks();
      }
      if (target.notice) {
        setText($("#payment-notice"), target.notice);
        show($("#payment-notice"));
      }
      prepareHandoff();
    } catch (error) {
      if (token !== inspectToken) return;
      hide(canvas);
      setText(placeholder, "Этот QR нельзя показать безопасно.");
      announce(receiverError, error.message || "Реквизит не распознан.", true);
    }
  };
  $("#download-qr").addEventListener("click", () => {
    if (expired()) return;
    const canvas = $("#payment-qr");
    if (!canvas?.toDataURL) return;
    const anchor = document.createElement("a");
    anchor.download = "qrbek-payment.png";
    anchor.href = canvas.toDataURL("image/png");
    anchor.click();
  });
  handoff.addEventListener("click", (event) => {
    if (expired()) {
      event.preventDefault();
      return;
    }
    if (handoff.hasAttribute("href")) return;
    event.preventDefault();
    announce(
      $("#receiver-error"),
      "Выберите банк отправителя и дождитесь подготовки ссылки.",
      true,
    );
  });
  renderSelected();
}

if (pageKind === "builder") initBuilder();
if (pageKind === "receiver") initReceiver();
window.addEventListener("hashchange", () => location.reload());
