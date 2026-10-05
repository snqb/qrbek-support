const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function bindBuilderUploadInteractions({ form, list, announce }) {
  const isBuilderBusy = () => form.getAttribute("aria-busy") === "true";
  const decodeUpload = (file, row) => {
    const generation = (row._inputGeneration || 0) + 1;
    row._inputGeneration = generation;
    row._pendingUpload = null;
    const isCurrent = () => row.isConnected && row._inputGeneration === generation;
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
        const max = 1800;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
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
        $(".method-value", row).dispatchEvent(new Event("input", { bubbles: true }));
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
    event.target instanceof Element ? event.target.closest(".method-row") : null;
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
      announce($("#methods-error"), "Перетащите одно изображение на нужную карточку QR.", true);
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
      announce($("#methods-error"), "Перетащите одно изображение на нужную карточку QR.", true);
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
    upload.addEventListener("change", () => upload.files[0] && decodeUpload(upload.files[0], row));
    upload.click();
  });
}
