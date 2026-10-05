import {
  BANKS,
  decodePage,
  inspectQr,
  normalizePage,
  paymentTarget,
} from "./payment.js?v=20260922-amount2";
import { formatExpiry } from "./page-expiry.js";
import { bindBuilderUploadInteractions } from "./builder-upload.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const pageKind = document.body?.classList.contains("builder-page")
  ? "builder"
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
  bindBuilderUploadInteractions({ form, list, announce });
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
if (pageKind === "builder") initBuilder();


